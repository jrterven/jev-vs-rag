import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

async function productionFixture(t: test.TestContext, rateLimit = 300) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'annotation-proxy-'));
  const origin = 'https://anotation.jemailabs.com';
  const config = loadConfig({ NODE_ENV: 'production', ANNOTATION_ORIGIN: origin, ANNOTATION_DATA_DIR: directory, ANNOTATION_TRUST_PROXY: '1' });
  config.rateLimit = rateLimit;
  const app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { host: 'anotation.jemailabs.com', origin, 'x-annotation-csrf': '1' };
  return { app, headers };
}

test('one trusted hop uses the proxy-normalized visitor IP and ignores an earlier forged XFF prefix', async t => {
  const { app, headers } = await productionFixture(t, 1);
  const request = (forwarded: string) => app.inject({ method: 'GET', url: '/api/annotation/me', remoteAddress: '127.0.0.1', headers: { ...headers, 'x-forwarded-for': forwarded } });
  assert.equal((await request('198.51.100.10')).statusCode, 200);
  assert.equal((await request('203.0.113.99, 198.51.100.10')).statusCode, 429);
  assert.equal((await request('198.51.100.11')).statusCode, 200);
});

test('authenticated sessions have independent limits even behind the same proxy and IP', async t => {
  const { app, headers } = await productionFixture(t, 1);
  const cookies: string[] = [];
  for (const name of ['Fixture A', 'Fixture B']) {
    const participant = app.annotation.createParticipant({ name, role: 'collaborator', canAdjudicate: false });
    const invite = new URL(app.annotation.invite(participant.id));
    const token = new URLSearchParams(invite.hash.slice(1)).get('invite')!;
    // Synthetic participants exist only in this temporary database.
    const authenticated = app.annotation.redeem(token);
    cookies.push(`annotation_session=${authenticated.session}`);
  }
  const request = (cookie: string) => app.inject({ method: 'GET', url: '/api/annotation/me', remoteAddress: '127.0.0.1', headers: { ...headers, cookie, 'x-forwarded-for': '198.51.100.10' } });
  assert.equal((await request(cookies[0]!)).statusCode, 200);
  assert.equal((await request(cookies[0]!)).statusCode, 429);
  assert.equal((await request(cookies[1]!)).statusCode, 200);
});

test('a no-session production smoke verifies secure cookie attributes and CSRF without an invitation', async t => {
  const { app, headers } = await productionFixture(t);
  const count = () => ({ sessions: app.annotation.store.all('session').length, invitations: app.annotation.store.all('invite').length });
  const before = count();
  const logout = await app.inject({ method: 'POST', url: '/api/annotation/auth/logout', headers: { ...headers, 'x-forwarded-proto': 'http' }, payload: {} });
  assert.equal(logout.statusCode, 200);
  const cookie = String(logout.headers['set-cookie']);
  for (const attribute of ['annotation_session=;', 'HttpOnly', 'SameSite=Strict', 'Path=/api/annotation', 'Max-Age=0', 'Secure']) assert(cookie.includes(attribute));
  assert.deepEqual(count(), before);
  const forbidden = await app.inject({ method: 'POST', url: '/api/annotation/auth/logout', headers: { ...headers, origin: 'https://untrusted.example' }, payload: {} });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.headers['set-cookie'], undefined);
  assert.equal((await app.inject({ method: 'GET', url: '/api/annotation/tasks', headers })).statusCode, 401);
  assert.deepEqual(count(), before);
});
