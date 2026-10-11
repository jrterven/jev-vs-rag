import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './canonical.js';
import type { Participant } from '../shared/types.js';
import { loadConfig, type AnnotationConfig } from './config.js';
import { AnnotationService } from './service.js';
import { AnnotationStore } from './store.js';
import { ApiError, fail, integer, string } from './validation.js';

const prefix = '/api/annotation';
const cookieName = 'annotation_session';
function session(request: FastifyRequest): string | undefined {
  return request.headers.cookie?.split(';').map(pair => pair.trim()).find(pair => pair.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}
export type AnnotationApp = FastifyInstance & { annotation: AnnotationService };
export interface BuildAppOptions { config?: AnnotationConfig; store?: AnnotationStore; serveStatic?: boolean }
export async function buildApp(options: BuildAppOptions = {}): Promise<AnnotationApp> {
  const config = options.config ?? loadConfig(), store = options.store ?? new AnnotationStore(config.dataDir);
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, requestTimeout: 30000, trustProxy: config.trustProxyHops ? (_address, hop) => hop < config.trustProxyHops : false }) as unknown as AnnotationApp;
  const service = new AnnotationService(store, config);
  app.decorate('annotation', service);
  app.addHook('onClose', async () => { if (!options.store) store.close(); });
  const allowedHosts = new Set(config.allowedOrigins.map(origin => new URL(origin).host));
  const hits = new Map<string, { count: number; end: number }>();
  function cookie(token: string, expired = false): string { return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=${expired ? 0 : config.sessionDays * 86400}${config.production ? '; Secure' : ''}`; }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (config.production) reply.header('Strict-Transport-Security', 'max-age=31536000').header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!request.headers.host || !allowedHosts.has(request.headers.host.toLowerCase())) fail(403, 'Host no autorizado.');
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) fail(403, 'Origen no autorizado.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (!origin || !config.allowedOrigins.includes(origin) || request.headers['x-annotation-csrf'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Solicitud entre sitios bloqueada.');
      if (request.headers['content-type'] && !request.headers['content-type'].toLowerCase().startsWith('application/json')) fail(415, 'Use JSON.');
    }
    if (request.url.startsWith(prefix)) {
      const redeem = request.url.split('?')[0] === `${prefix}/auth/redeem`;
      const token = session(request), authenticated = !redeem && service.authenticate(token);
      const identity = authenticated ? `session:${sha256(token!)}` : `ip:${request.ip}`;
      const key = `${identity}:${redeem ? 'redeem' : 'general'}`, now = Date.now();
      let hit = hits.get(key);
      if (!hit || hit.end <= now) { hit = { count: 0, end: now + 60000 }; hits.set(key, hit); }
      if (++hit.count > (redeem ? 15 : config.rateLimit)) { reply.header('Retry-After', String(Math.ceil((hit.end - now) / 1000))); fail(429, 'Demasiadas solicitudes.'); }
      if (hits.size > 10000) { for (const [entry, item] of hits) if (item.end <= now) hits.delete(entry); if (hits.size > 20000) fail(503, 'Servicio ocupado.'); }
    }
  });
  app.setErrorHandler((unknownError, _request, reply) => {
    const error = unknownError as Error & { statusCode?: number };
    const status = error instanceof ApiError ? error.statusCode : typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Error interno del servicio.' : error.message });
  });
  const actor = (request: FastifyRequest): Participant => service.authenticate(session(request)) ?? fail(401, 'Inicie sesión con una invitación.');
  const admin = (request: FastifyRequest): Participant => { const user = actor(request); service.coordinator(user); return user; };
  const parameter = (request: FastifyRequest, name = 'id'): string => string((request.params as Record<string, unknown>)[name], 100);
  app.get(`${prefix}/health`, async () => ({ ok: true }));
  app.get(`${prefix}/me`, async request => ({ participant: service.authenticate(session(request)) }));
  app.post(`${prefix}/auth/redeem`, async (request, reply) => { const { participant, session: token } = service.redeem((request.body as {token?: unknown})?.token); reply.header('Set-Cookie', cookie(token)); return { participant }; });
  app.post(`${prefix}/auth/logout`, async (request, reply) => { service.logout(session(request)); reply.header('Set-Cookie', cookie('', true)); return { ok: true }; });
  app.get(`${prefix}/tasks`, async request => service.tasks(actor(request)));
  app.get(`${prefix}/tasks/:id`, async request => service.view(parameter(request), actor(request)));
  app.put(`${prefix}/tasks/:id/draft`, async request => service.saveDraft(parameter(request), actor(request), request.body));
  app.post(`${prefix}/tasks/:id/submit`, async request => service.submit(parameter(request), actor(request), request.body));
  app.post(`${prefix}/tasks/:id/self-review`, async request => service.selfReview(parameter(request), actor(request), request.body));
  app.post(`${prefix}/tasks/:id/verdict`, async request => service.verdict(parameter(request), actor(request), request.body));
  app.get(`${prefix}/documents/:id/blocks`, async request => {
    const document = service.document(parameter(request), actor(request)), query = request.query as Record<string, string>;
    const offset = integer(Number(query.offset ?? 0)), limit = integer(Number(query.limit ?? 200), 1, 500);
    return { blocks: document.blocks.slice(offset, offset + limit), total: document.blocks.length };
  });
  app.get(`${prefix}/documents/:id/blocks/:blockId`, async request => {
    const document = service.document(parameter(request), actor(request));
    return document.blocks.find(block => block.id === parameter(request, 'blockId')) ?? fail(404, 'Bloque no encontrado.');
  });
  app.get(`${prefix}/documents/:id/search`, async request => {
    const document = service.document(parameter(request), actor(request)), query = string((request.query as Record<string, unknown>).q, 1000).toLocaleLowerCase();
    const matches = [];
    for (const block of document.blocks) if (block.text.toLocaleLowerCase().includes(query)) { matches.push({ blockIndex: block.index, text: block.text }); if (matches.length === 50) break; }
    return { matches };
  });
  app.get(`${prefix}/admin`, async request => { admin(request); return service.overview(); });
  app.post(`${prefix}/admin/projects`, async request => { admin(request); return service.createProject(request.body); });
  app.patch(`${prefix}/admin/projects/:id`, async request => { admin(request); return service.updateProject(parameter(request), request.body); });
  app.post(`${prefix}/admin/participants`, async request => { admin(request); return store.transaction(() => { const participant = service.createParticipant(request.body); return { participant, inviteUrl: service.invite(participant.id) }; }); });
  app.post(`${prefix}/admin/participants/:id/invite`, async request => { admin(request); return { inviteUrl: service.invite(parameter(request)) }; });
  app.post(`${prefix}/admin/participants/:id/revoke`, async request => { service.revoke(parameter(request), admin(request)); return { ok: true }; });
  app.post(`${prefix}/admin/datasets`, { bodyLimit: 128 * 1024 * 1024, onRequest: async request => { admin(request); } }, async request => service.importDataset(request.body));
  app.post(`${prefix}/admin/documents`, async request => { admin(request); return service.createDocument(request.body); });
  app.post(`${prefix}/admin/tasks/:id/amend`, async request => { admin(request); return service.amend(parameter(request), request.body); });
  app.post(`${prefix}/admin/tasks`, async request => { admin(request); return service.createTask(request.body); });
  app.post(`${prefix}/admin/projects/:id/freeze`, async request => { admin(request); return service.freeze(parameter(request)); });
  app.get(`${prefix}/admin/freezes/:id/export`, async request => { admin(request); return service.getFreeze(parameter(request)); });
  app.get(`${prefix}/admin/freezes/:id/ratings/export`, async request => { admin(request); return service.ratings(parameter(request)); });
  app.post(`${prefix}/admin/results`, async request => { admin(request); return service.importResults(request.body); });
  const staticRoot = path.resolve('annotation/dist/web');
  if (options.serveStatic !== false && existsSync(path.join(staticRoot, 'index.html'))) {
    await app.register(staticFiles, { root: staticRoot });
    app.setNotFoundHandler(async (request, reply) => request.method === 'GET' && !request.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'No encontrado.' }));
  }
  await app.ready(); return app;
}
