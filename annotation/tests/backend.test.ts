import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AnnotationStore } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { sha256, hashDataset } from '../server/canonical.js';
import type { AnnotationDraft, FrozenDataset, Participant, Project, Task, TaskView, TextBlock } from '../shared/types.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'annotation-backend-'));
  const config = loadConfig({ ANNOTATION_DATA_DIR: directory });
  const app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const service = app.annotation;
  const coordinator = service.createParticipant({ name: 'Coordinator', role: 'coordinator', canAdjudicate: true });
  const author = service.createParticipant({ name: 'Author', role: 'collaborator', canAdjudicate: false });
  const reviewer = service.createParticipant({ name: 'Reviewer', role: 'collaborator', canAdjudicate: false });
  const judge = service.createParticipant({ name: 'Judge', role: 'collaborator', canAdjudicate: true });
  const outsider = service.createParticipant({ name: 'Outsider', role: 'collaborator', canAdjudicate: false });
  const headers = { host: '127.0.0.1:3002', origin: config.origin, 'x-annotation-csrf': '1' };
  async function redeem(person: Participant) {
    const token = service.invite(person.id).split('=')[1]!;
    const response = await app.inject({ method: 'POST', url: '/api/annotation/auth/redeem', headers, payload: { token } });
    assert.equal(response.statusCode, 200, response.body);
    return response.headers['set-cookie']!.toString().split(';')[0]!;
  }
  const cookies = new Map<string, string>();
  for (const participant of [coordinator, author, reviewer, judge, outsider]) cookies.set(participant.id, await redeem(participant));
  async function request(method: 'GET' | 'POST' | 'PUT' | 'PATCH', route: string, participant?: Participant, body?: unknown) {
    return app.inject({ method, url: `/api/annotation${route}`, headers: { ...headers, ...(participant ? { cookie: cookies.get(participant.id)! } : {}) }, ...(method === 'GET' ? {} : { payload: body ?? {} }) });
  }
  async function okay<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', route: string, participant?: Participant, body?: unknown): Promise<T> { const response = await request(method, route, participant, body); assert.equal(response.statusCode, 200, response.body); return response.json() as T; }
  const project = service.createProject({ name: 'Study' });
  const document = service.createDocument({ projectId: project.id, title: 'Source', blocks: [{ text: 'Café 🔬, first evidence.', heading: 'One', page: 1 }, { text: 'Second independent evidence.', page: 2 }] });
  const blocks = service.document(document.id, coordinator).blocks;
  const task = service.createTask({ projectId: project.id, documentId: document.id, assigneeId: author.id, kind: 'author' });
  const span = (block: TextBlock) => ({ blockId: block.id, start: block.start, end: block.end, quote: block.text });
  const draft: AnnotationDraft = { question: 'What is evidence?', questionType: 'explanatory', answer: 'Two passages describe evidence.', evidenceSets: [[span(blocks[0]!), span(blocks[1]!)]] };
  async function send(task: Task, person: Participant, value = draft) {
    const { revision } = await okay<{revision: number}>('PUT', `/tasks/${task.id}/draft`, person, { revision: 0, draft: value });
    return okay<TaskView>('POST', `/tasks/${task.id}/submit`, person, { revision, submissionId: randomUUID() });
  }
  async function accepted(): Promise<FrozenDataset> {
    await send(task, author);
    const review = service.createTask({ projectId: project.id, documentId: document.id, assigneeId: reviewer.id, kind: 'review', sourceTaskId: task.id });
    await send(review, reviewer);
    await okay('POST', `/tasks/${review.id}/verdict`, reviewer, { verdict: 'agree', note: '' });
    return okay('POST', `/admin/projects/${project.id}/freeze`, coordinator);
  }
  return { app, config, directory, service, headers, coordinator, author, reviewer, judge, outsider, cookies, request, okay, project, document, blocks, task, draft, send, accepted };
}

test('reusable hashed invitations retain their seven-day expiry and reopen saved drafts with independent sessions', async t => {
  const f = await fixture(t);
  const issuedAt = Date.now(), url = f.service.invite(f.author.id), token = url.split('=')[1]!;
  const invitation = f.service.store.get<{hash: string; participantId: string; expires: number}>('invite', sha256(token))!;
  assert.equal(f.config.inviteDays, 7); assert.equal(f.config.sessionDays, 30);
  assert(invitation.expires >= issuedAt + 7 * 86400000 && invitation.expires <= Date.now() + 7 * 86400000);
  const stored = f.service.store.all<{hash: string; expires: number}>('invite');
  assert(!JSON.stringify(stored).includes(token)); assert(stored.some(row => row.hash === sha256(token)));
  async function enter() {
    const before = Date.now();
    const response = await f.app.inject({ method: 'POST', url: '/api/annotation/auth/redeem', headers: f.headers, payload: { token } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<{participant: Participant}>().participant.id, f.author.id);
    const header = response.headers['set-cookie']!.toString();
    assert.match(header, /HttpOnly; SameSite=Strict/); assert.match(header, /Max-Age=2592000/);
    const cookie = header.split(';')[0]!, sessionToken = cookie.slice('annotation_session='.length);
    const session = f.service.store.get<{expires: number}>('session', sha256(sessionToken))!;
    assert(session.expires >= before + 30 * 86400000 && session.expires <= Date.now() + 30 * 86400000);
    assert.deepEqual(f.service.store.get('invite', sha256(token)), invitation);
    return cookie;
  }
  const first = await enter(), second = await enter(); assert.notEqual(first, second);
  const save = await f.app.inject({ method: 'PUT', url: `/api/annotation/tasks/${f.task.id}/draft`, headers: { ...f.headers, cookie: first }, payload: { revision: 0, draft: f.draft } });
  assert.equal(save.statusCode, 200); assert.equal(save.json<{revision: number}>().revision, 1);
  const logout = await f.app.inject({ method: 'POST', url: '/api/annotation/auth/logout', headers: { ...f.headers, cookie: first }, payload: {} });
  assert.equal(logout.statusCode, 200);
  const read = (cookie: string) => f.app.inject({ method: 'GET', url: `/api/annotation/tasks/${f.task.id}`, headers: { ...f.headers, cookie } });
  assert.equal((await read(first)).statusCode, 401);
  for (const cookie of [second, await enter()]) {
    const resumed = await read(cookie); assert.equal(resumed.statusCode, 200);
    const view = resumed.json<TaskView>(); assert.equal(view.task.revision, 1); assert.deepEqual(view.draft, f.draft);
  }
  const secondHash = sha256(second.slice('annotation_session='.length));
  const expiringSession = f.service.store.get<{hash: string; participantId: string; expires: number}>('session', secondHash)!;
  f.service.store.put('session', secondHash, { ...expiringSession, expires: Date.now() - 1 });
  assert.equal((await read(second)).statusCode, 401);
  assert.equal((await read(await enter())).statusCode, 200);
});

test('rotation invalidates only the old link, expiry preserves sessions, and revocation blocks every link and session', async t => {
  const f = await fixture(t);
  const issue = async () => new URLSearchParams(new URL((await f.okay<{inviteUrl: string}>('POST', `/admin/participants/${f.outsider.id}/invite`, f.coordinator)).inviteUrl).hash.slice(1)).get('invite')!;
  const redeem = (token: string) => f.request('POST', '/auth/redeem', undefined, { token });
  const firstToken = await issue();
  const sessions: string[] = [];
  for (let i = 0; i < 2; i++) { const result = await redeem(firstToken); assert.equal(result.statusCode, 200); sessions.push(result.headers['set-cookie']!.toString().split(';')[0]!); }
  const replacement = await issue(); assert.notEqual(replacement, firstToken);
  assert.equal((await redeem(firstToken)).statusCode, 401);
  const tasks = (cookie: string) => f.app.inject({ method: 'GET', url: '/api/annotation/tasks', headers: { ...f.headers, cookie } });
  for (const cookie of sessions) assert.equal((await tasks(cookie)).statusCode, 200);
  const fresh = await redeem(replacement); assert.equal(fresh.statusCode, 200);
  sessions.push(fresh.headers['set-cookie']!.toString().split(';')[0]!);
  const invitation = f.service.store.get<{hash: string; participantId: string; expires: number}>('invite', sha256(replacement))!;
  f.service.store.put('invite', invitation.hash, { ...invitation, expires: Date.now() - 1 });
  assert.equal((await redeem(replacement)).statusCode, 401);
  for (const cookie of sessions) assert.equal((await tasks(cookie)).statusCode, 200);
  await f.okay('POST', `/admin/participants/${f.outsider.id}/revoke`, f.coordinator);
  for (const cookie of [...sessions, f.cookies.get(f.outsider.id)!]) assert.equal((await tasks(cookie)).statusCode, 401);
  assert.equal((await redeem(replacement)).statusCode, 401);
  for (const kind of ['invite', 'session']) assert.equal(f.service.store.all<{participantId: string}>(kind).filter(row => row.participantId === f.outsider.id).length, 0);
  assert.equal(f.service.participant(f.outsider.id).active, false);
});

test('reusable links and drafts survive restart without resurrecting legacy consumed invitation tokens', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'annotation-reusable-restart-'));
  const config = loadConfig({ ANNOTATION_DATA_DIR: directory });
  let app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const coordinator = app.annotation.createParticipant({ name: 'Coordinator', role: 'coordinator', canAdjudicate: true });
  const participant = app.annotation.createParticipant({ name: 'Author', role: 'collaborator', canAdjudicate: false });
  const legacy = app.annotation.createParticipant({ name: 'Legacy author', role: 'collaborator', canAdjudicate: false });
  const headers = { host: '127.0.0.1:3002', origin: config.origin, 'x-annotation-csrf': '1' };
  const tokenFor = (id: string) => new URLSearchParams(new URL(app.annotation.invite(id)).hash.slice(1)).get('invite')!;
  const redeem = (token: string) => app.inject({ method: 'POST', url: '/api/annotation/auth/redeem', headers, payload: { token } });
  const coordinatorToken = tokenFor(coordinator.id), reusable = tokenFor(participant.id), consumed = tokenFor(legacy.id);
  const coordinatorEntry = await redeem(coordinatorToken); assert.equal(coordinatorEntry.statusCode, 200);
  const coordinatorCookie = coordinatorEntry.headers['set-cookie']!.toString().split(';')[0]!;
  const beforeRestart = await redeem(reusable); assert.equal(beforeRestart.statusCode, 200);
  const cookie = beforeRestart.headers['set-cookie']!.toString().split(';')[0]!;
  const legacyEntry = await redeem(consumed); assert.equal(legacyEntry.statusCode, 200);
  const legacyCookie = legacyEntry.headers['set-cookie']!.toString().split(';')[0]!;
  // Reproduce a token consumed by the old implementation, before restart/upgrade.
  app.annotation.store.remove('invite', sha256(consumed));
  const project = app.annotation.createProject({ name: 'Persistent drafts' });
  const document = app.annotation.createDocument({ projectId: project.id, title: 'Source', blocks: [{ text: 'Saved evidence.' }] });
  const task = app.annotation.createTask({ projectId: project.id, documentId: document.id, assigneeId: participant.id, kind: 'author' });
  const draft: AnnotationDraft = { question: 'Draft question?', questionType: 'factual', answer: 'Draft answer', evidenceSets: [] };
  const saved = await app.inject({ method: 'PUT', url: `/api/annotation/tasks/${task.id}/draft`, headers: { ...headers, cookie }, payload: { revision: 0, draft } });
  assert.equal(saved.statusCode, 200);
  const originalExpiry = app.annotation.store.get<{expires: number}>('invite', sha256(reusable))!.expires;
  await app.close(); app = await buildApp({ config, serveStatic: false });
  const resumed = await redeem(reusable); assert.equal(resumed.statusCode, 200);
  const resumedCookie = resumed.headers['set-cookie']!.toString().split(';')[0]!; assert.notEqual(resumedCookie, cookie);
  const read = await app.inject({ method: 'GET', url: `/api/annotation/tasks/${task.id}`, headers: { ...headers, cookie: resumedCookie } });
  assert.equal(read.statusCode, 200); assert.deepEqual(read.json<TaskView>().draft, draft); assert.equal(read.json<TaskView>().task.revision, 1);
  assert.equal(app.annotation.store.get<{expires: number}>('invite', sha256(reusable))!.expires, originalExpiry);
  assert.equal((await redeem(consumed)).statusCode, 401);
  assert.equal(app.annotation.store.get('invite', sha256(consumed)), undefined);
  assert.equal((await app.inject({ method: 'GET', url: '/api/annotation/tasks', headers: { ...headers, cookie: legacyCookie } })).statusCode, 200);
  const replacement = await app.inject({ method: 'POST', url: `/api/annotation/admin/participants/${legacy.id}/invite`, headers: { ...headers, cookie: coordinatorCookie }, payload: {} });
  assert.equal(replacement.statusCode, 200);
  const replacementToken = new URLSearchParams(new URL(replacement.json<{inviteUrl: string}>().inviteUrl).hash.slice(1)).get('invite')!;
  assert.equal((await redeem(consumed)).statusCode, 401); assert.equal((await redeem(replacementToken)).statusCode, 200);
  assert.equal(app.annotation.store.all('participant').length, 3);
});

test('CSRF, DNS rebinding, administrative access and assigned-document authorization', async t => {
  const f = await fixture(t);
  for (const headers of [{ ...f.headers, origin: 'https://evil.test' }, { ...f.headers, 'x-annotation-csrf': undefined }, { ...f.headers, host: 'evil.test' }, { ...f.headers, origin: undefined }]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/annotation/admin/projects', headers: Object.fromEntries(Object.entries({ ...headers, cookie: f.cookies.get(f.coordinator.id)! }).filter((entry): entry is [string, string] => entry[1] !== undefined)), payload: { name: 'x' } });
    assert.equal(response.statusCode, 403);
  }
  assert.equal((await f.request('GET', '/admin', f.author)).statusCode, 403);
  assert.equal((await f.request('GET', `/tasks/${f.task.id}`, f.outsider)).statusCode, 403);
  assert.equal((await f.request('GET', `/documents/${f.document.id}/blocks`, f.outsider)).statusCode, 403);
  assert.deepEqual(await f.okay('GET', '/health'), { ok: true });
  assert.deepEqual(await f.okay('GET', '/me'), { participant: null });
});

test('canonical UTF-16 evidence validates emoji boundaries, exact text, cross-block spans and revision history', async t => {
  const f = await fixture(t), block = f.blocks[0]!;
  assert.equal(f.blocks[1]!.start, block.text.length + 2);
  assert.equal(f.document.hash, sha256(f.blocks.map(item => item.text).join('\n\n')));
  const emojiOffset = block.text.indexOf('🔬');
  const valid = { ...f.draft, evidenceSets: [[{ blockId: block.id, start: emojiOffset, end: emojiOffset + 2, quote: '🔬' }]] };
  const first = await f.okay<{revision: number}>('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 0, draft: valid });
  assert.equal(first.revision, 1);
  assert.equal((await f.request('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 0, draft: valid })).statusCode, 409);
  for (const span of [
    { blockId: block.id, start: emojiOffset, end: emojiOffset + 1, quote: block.text.slice(emojiOffset, emojiOffset + 1) },
    { blockId: block.id, start: 0, end: f.blocks[1]!.end, quote: `${block.text}\n\n${f.blocks[1]!.text}` },
    { blockId: block.id, start: 0, end: 4, quote: 'Fake' },
    { blockId: 'foreign', start: 0, end: 4, quote: 'Café' },
  ]) assert.equal((await f.request('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 1, draft: { ...f.draft, evidenceSets: [[span]] } })).statusCode, 400);
  const saved = await f.okay<{revision: number}>('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 1, draft: f.draft });
  assert.equal(saved.revision, 2); assert.equal(f.service.store.all('revision').length, 2);
  const submissionId = randomUUID(), payload = { revision: 2, submissionId };
  await f.okay('POST', `/tasks/${f.task.id}/submit`, f.author, payload);
  await f.okay('POST', `/tasks/${f.task.id}/submit`, f.author, payload);
  assert.equal(f.service.store.all('submission').length, 1);
  assert.equal((await f.request('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 2, draft: f.draft })).statusCode, 409);
  assert.equal((await f.request('POST', `/tasks/${f.task.id}/submit`, f.author, { revision: 1, submissionId })).statusCode, 409);
});

test('review is independent until submission; only agreement or authorized adjudication enters gold', async t => {
  const f = await fixture(t);
  await f.send(f.task, f.author);
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  const taskInput = { projectId: f.project.id, documentId: f.document.id, assigneeId: f.author.id, kind: 'review', sourceTaskId: f.task.id };
  assert.equal((await f.request('POST', '/admin/tasks', f.coordinator, taskInput)).statusCode, 400);
  const review = await f.okay<Task>('POST', '/admin/tasks', f.coordinator, { ...taskInput, assigneeId: f.reviewer.id });
  const initial = await f.okay<TaskView>('GET', `/tasks/${review.id}`, f.reviewer);
  assert.equal(initial.questionType, 'explanatory'); assert.equal(initial.question, f.draft.question);
  assert.equal(initial.comparison, undefined); assert.equal(initial.reference, undefined); assert(!JSON.stringify(initial).includes(f.draft.answer));
  assert.equal((await f.request('POST', `/tasks/${review.id}/verdict`, f.reviewer, { verdict: 'agree' })).statusCode, 409);
  await f.send(review, f.reviewer, { ...f.draft, answer: 'Independent answer.', questionType: 'factual' });
  const viewed = await f.okay<TaskView>('GET', `/tasks/${review.id}`, f.reviewer);
  assert.equal(viewed.comparison?.original.answer, f.draft.answer); assert.equal(viewed.draft?.questionType, 'explanatory');
  await f.okay('POST', `/tasks/${review.id}/verdict`, f.reviewer, { verdict: 'disagree', note: 'Different supporting answer.' });
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  const adjudication = await f.okay<Task>('POST', '/admin/tasks', f.coordinator, { ...taskInput, kind: 'adjudicate', assigneeId: f.judge.id, sourceTaskId: review.id });
  const before = await f.okay<TaskView>('GET', `/tasks/${adjudication.id}`, f.judge);
  assert.equal(before.adjudication?.length, 2);
  await f.send(adjudication, f.judge, { ...f.draft, answer: 'Adjudicated answer.', note: 'Evidence resolves the disagreement.' });
  const freeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  assert.equal(freeze.questions[0]!.answer, 'Adjudicated answer.'); assert.equal(freeze.hash, hashDataset(freeze));
  assert.equal((await f.request('POST', '/admin/tasks', f.coordinator, { ...taskInput, kind: 'adjudicate', assigneeId: f.coordinator.id, sourceTaskId: review.id })).statusCode, 409);
});

test('frozen results are immutable, import is atomic, each answer has two blinded raters and pseudonymous exports', async t => {
  const f = await fixture(t), freeze = await f.accepted(), question = freeze.questions[0]!;
  const payload = { freezeId: freeze.id, reviewerIds: [f.author.id, f.reviewer.id], answers: [{ questionId: question.id, method: 'secret-jev-provider', runId: 'sensitive-run-id', text: 'Anonymous answer', citations: [{ label: 'C1', spans: f.draft.evidenceSets[0] }] }] };
  assert.equal((await f.request('POST', '/admin/results', f.coordinator, { ...payload, reviewerIds: [f.author.id, f.author.id] })).statusCode, 400);
  const imported = await f.okay<{tasks: Task[]}>('POST', '/admin/results', f.coordinator, payload);
  assert.equal(imported.tasks.length, 2); assert.equal(new Set(imported.tasks.map(task => task.assigneeId)).size, 2);
  const task = imported.tasks.find(task => task.assigneeId === f.author.id)!;
  const blinded = await f.okay<TaskView>('GET', `/tasks/${task.id}`, f.author), serialized = JSON.stringify(blinded);
  assert(!serialized.includes('secret-jev-provider')); assert(!serialized.includes('sensitive-run-id')); assert(!serialized.includes('answerId')); assert.equal(blinded.answer?.text, 'Anonymous answer');
  assert.equal((await f.request('GET', `/tasks/${task.id}`, f.reviewer)).statusCode, 403);
  const count = f.service.store.all('task').length;
  const duplicateBatch = { ...payload, answers: [{ ...payload.answers[0], method: 'new-method' }, payload.answers[0]] };
  assert.equal((await f.request('POST', '/admin/results', f.coordinator, duplicateBatch)).statusCode, 409);
  assert.equal(f.service.store.all('task').length, count);
  const rating = { correctness: 2 as const, unsupported: 'no' as const, citations: 'supported' as const, abstention: 'not_applicable' as const, comment: '', issue: '' };
  for (const task of imported.tasks) await f.send(task, task.assigneeId === f.author.id ? f.author : f.reviewer, { ...f.draft, rating });
  const adjudication = await f.okay<Task>('POST', '/admin/tasks', f.coordinator, { projectId: f.project.id, documentId: f.document.id, assigneeId: f.judge.id, kind: 'adjudicate', sourceTaskId: task.id });
  const view = await f.okay<TaskView>('GET', `/tasks/${adjudication.id}`, f.judge); assert.equal(view.adjudication?.length, 2); assert.equal(view.answer?.text, 'Anonymous answer');
  await f.send(adjudication, f.judge, { ...f.draft, rating, note: 'Both ratings supported.' });
  const exported = await f.okay<{answers: Array<{raw: unknown[]; adjudicated: unknown[]}>}>('GET', `/admin/freezes/${freeze.id}/ratings/export`, f.coordinator);
  assert.equal(exported.answers[0]!.raw.length, 2); assert.equal(exported.answers[0]!.adjudicated.length, 1);
  assert(!JSON.stringify(exported).includes(f.author.id)); assert(!JSON.stringify(exported).includes(f.author.name));
  const later = await f.okay<FrozenDataset>('GET', `/admin/freezes/${freeze.id}/export`, f.coordinator);
  assert.deepEqual(later, freeze);
  assert.equal((await f.request('GET', `/admin/freezes/${freeze.id}/ratings/export`, f.author)).statusCode, 403);
});

test('unanswerable questions need no evidence and survive freeze; pagination and search preserve block IDs', async t => {
  const f = await fixture(t);
  const draft = { ...f.draft, answer: '', evidenceSets: [], unanswerable: true };
  await f.send(f.task, f.author, draft);
  const review = f.service.createTask({ projectId: f.project.id, documentId: f.document.id, assigneeId: f.reviewer.id, kind: 'review', sourceTaskId: f.task.id });
  await f.send(review, f.reviewer, draft); await f.okay('POST', `/tasks/${review.id}/verdict`, f.reviewer, { verdict: 'agree', note: '' });
  const freeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  assert.equal(freeze.questions[0]!.unanswerable, true);
  const paged = await f.okay<{blocks: TextBlock[]; total: number}>('GET', `/documents/${f.document.id}/blocks?offset=1&limit=1`, f.author);
  assert.equal(paged.total, 2); assert.equal(paged.blocks[0]!.id, f.blocks[1]!.id);
  assert.deepEqual(await f.okay('GET', `/documents/${f.document.id}/blocks/${f.blocks[1]!.id}`, f.author), f.blocks[1]);
  const found = await f.okay<{matches: Array<{blockIndex: number}>}>('GET', `/documents/${f.document.id}/search?q=CAF%C3%89`, f.author);
  assert.equal(found.matches[0]!.blockIndex, 0);
});

test('production requires HTTPS, cookie is secure and request limit returns Retry-After', async t => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /HTTPS/);
  const directory = mkdtempSync(path.join(tmpdir(), 'annotation-prod-'));
  const config = loadConfig({ NODE_ENV: 'production', ANNOTATION_ORIGIN: 'https://annotations.example.test', ANNOTATION_DATA_DIR: directory });
  config.rateLimit = 2;
  const app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const participant = app.annotation.createParticipant({ name: 'x', role: 'coordinator', canAdjudicate: true });
  const token = app.annotation.invite(participant.id).split('=')[1];
  const headers = { host: 'annotations.example.test', origin: config.origin, 'x-annotation-csrf': '1' };
  const redemption = await app.inject({ method: 'POST', url: '/api/annotation/auth/redeem', headers, payload: { token } });
  assert.equal(redemption.statusCode, 200); assert.match(redemption.headers['set-cookie']!.toString(), /; Secure/);
  for (let count = 0; count < 2; count++) assert.equal((await app.inject({ method: 'GET', url: '/api/annotation/me', headers })).statusCode, 200);
  const limited = await app.inject({ method: 'GET', url: '/api/annotation/me', headers });
  assert.equal(limited.statusCode, 429); assert(limited.headers['retry-after']);
});

test('corrections create a new reviewed version without mutating existing freezes or reusing stale gold', async t => {
  const f = await fixture(t), oldFreeze = await f.accepted();
  const correction = await f.okay<Task>('POST', `/admin/tasks/${f.task.id}/amend`, f.coordinator, { note: 'Clarify the answer.' });
  assert.notEqual(correction.id, f.task.id); assert.equal(correction.sourceTaskId, f.task.id);
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  assert.equal((await f.request('POST', `/admin/tasks/${f.task.id}/amend`, f.coordinator, { note: 'Duplicate correction' })).statusCode, 409);
  await f.send(correction, f.author, { ...f.draft, answer: 'Corrected evidence-based answer.' });
  const review = await f.okay<Task>('POST', '/admin/tasks', f.coordinator, { projectId: f.project.id, documentId: f.document.id, assigneeId: f.reviewer.id, kind: 'review', sourceTaskId: correction.id });
  await f.send(review, f.reviewer, { ...f.draft, answer: 'Corrected evidence-based answer.' });
  await f.okay('POST', `/tasks/${review.id}/verdict`, f.reviewer, { verdict: 'agree', note: '' });
  const newFreeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  assert.equal(newFreeze.version, 2); assert.equal(newFreeze.questions.length, 1); assert.equal(newFreeze.questions[0]!.id, oldFreeze.questions[0]!.id);
  assert.equal(newFreeze.questions[0]!.answer, 'Corrected evidence-based answer.');
  assert.deepEqual(await f.okay('GET', `/admin/freezes/${oldFreeze.id}/export`, f.coordinator), oldFreeze);
});

test('neutral citation labels, evaluation incidents and authorized two-person adjudication', async t => {
  const f = await fixture(t), freeze = await f.accepted();
  const base = { freezeId: freeze.id, reviewerIds: [f.coordinator.id, f.reviewer.id], answers: [{ questionId: freeze.questions[0]!.id, method: 'hidden-method', runId: 'run', text: 'Output', citations: [{ label: 'hidden-method', spans: f.draft.evidenceSets[0] }] }] };
  assert.equal((await f.request('POST', '/admin/results', f.coordinator, base)).statusCode, 400);
  const citation = { ...base.answers[0]!.citations[0]!, label: 'C1' };
  assert.equal((await f.request('POST', '/admin/results', f.coordinator, { ...base, answers: [{ ...base.answers[0], citations: [citation, citation] }] })).statusCode, 400);
  const imported = await f.okay<{tasks: Task[]}>('POST', '/admin/results', f.coordinator, { ...base, answers: [{ ...base.answers[0], citations: [citation] }] });
  const rating = { correctness: null, unsupported: 'uncertain' as const, citations: 'not_applicable' as const, abstention: 'not_applicable' as const, comment: '', issue: 'The imported answer is corrupted.' };
  for (const task of imported.tasks) await f.send(task, task.assigneeId === f.coordinator.id ? f.coordinator : f.reviewer, { ...f.draft, rating });
  const adjudication = await f.okay<Task>('POST', '/admin/tasks', f.coordinator, { projectId: f.project.id, documentId: f.document.id, assigneeId: f.coordinator.id, kind: 'adjudicate', sourceTaskId: imported.tasks[0]!.id });
  await f.send(adjudication, f.coordinator, { ...f.draft, rating, note: 'Confirmed the import issue with both reviewers.' });
  const ratings = await f.okay<{answers: Array<{adjudicated: Array<{rating: {correctness: number | null}}>}>}>('GET', `/admin/freezes/${freeze.id}/ratings/export`, f.coordinator);
  assert.equal(ratings.answers[0]!.adjudicated[0]!.rating.correctness, null);
});

test('sessions, persisted order and drafts survive a service restart', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'annotation-restart-')), config = loadConfig({ ANNOTATION_DATA_DIR: directory });
  let app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const user = app.annotation.createParticipant({ name: 'User', role: 'coordinator', canAdjudicate: true });
  const token = app.annotation.redeem(app.annotation.invite(user.id).split('=')[1]).session;
  const project = app.annotation.createProject({ name: 'Persistence' });
  const document = app.annotation.createDocument({ projectId: project.id, title: 'Doc', blocks: [{ text: 'Evidence' }] });
  const tasks = Array.from({ length: 5 }, () => app.annotation.createTask({ projectId: project.id, documentId: document.id, assigneeId: user.id, kind: 'author' }));
  const draft = { question: 'Q', questionType: 'factual', answer: 'A', evidenceSets: [] };
  app.annotation.saveDraft(tasks[0]!.id, user, { revision: 0, draft });
  const before = app.annotation.tasks(user).map(task => task.id);
  await app.close(); app = await buildApp({ config, serveStatic: false });
  assert.equal(app.annotation.authenticate(token)?.id, user.id);
  assert.deepEqual(app.annotation.tasks(user).map(task => task.id), before);
  assert.deepEqual(app.annotation.view(tasks[0]!.id, user).draft, draft);
  assert.equal(app.annotation.view(tasks[0]!.id, user).task.revision, 1);
});

test('external frozen gold imports atomically with canonical hashes and feeds blinded ratings without author tasks', async t => {
  const f = await fixture(t), text = 'External 🔬 evidence';
  const block: TextBlock = { id: 'qasper:paper:b:0', index: 0, start: 0, end: text.length, text };
  const dataset: FrozenDataset = { schemaVersion: 1, id: 'freeze-external', projectId: 'qasper-public', version: 1, createdAt: new Date().toISOString(), hash: '', documents: [{ id: 'qasper:paper', projectId: 'qasper-public', title: 'Public paper', version: 1, hash: sha256(text), blockCount: 1, sections: [], blocks: [block] }], questions: [{ id: 'public-question', documentId: 'qasper:paper', question: 'What is present?', answer: 'Evidence', evidenceSets: [[{ blockId: block.id, start: 0, end: block.end, quote: text }]] }] };
  dataset.hash = hashDataset(dataset);
  const bundle = { schemaVersion: 1, freeze: dataset, sources: [{ documentId: 'qasper:paper', corpus: 'QASPER' }], provenance: { dataset: 'QASPER' } };
  assert.equal((await f.request('POST', '/admin/datasets', f.author, { dataset: bundle })).statusCode, 403);
  const before = f.service.overview().tasks.length;
  assert.deepEqual(await f.okay('POST', '/admin/datasets', f.coordinator, { dataset: bundle, name: 'Public gold' }), dataset);
  assert.deepEqual(await f.okay('POST', '/admin/datasets', f.coordinator, { dataset }), dataset);
  assert.equal(f.service.overview().tasks.length, before);
  assert.equal(f.service.store.all('freeze-provenance').length, 1);
  assert.equal((await f.request('POST', '/admin/projects/qasper-public/freeze', f.coordinator)).statusCode, 409);
  const changed = structuredClone(dataset); changed.questions[0]!.answer = 'Different'; changed.hash = hashDataset(changed);
  assert.equal((await f.request('POST', '/admin/datasets', f.coordinator, { dataset: changed })).statusCode, 409);
  const broken = structuredClone(dataset); broken.id = 'freeze-broken'; broken.documents[0]!.blocks[0]!.end--; broken.hash = hashDataset(broken);
  assert.equal((await f.request('POST', '/admin/datasets', f.coordinator, { dataset: broken })).statusCode, 400);
  const badQuote = structuredClone(dataset); badQuote.id = 'freeze-quote'; badQuote.questions[0]!.evidenceSets[0]![0]!.quote = 'Fabricated'; badQuote.hash = hashDataset(badQuote);
  assert.equal((await f.request('POST', '/admin/datasets', f.coordinator, { dataset: badQuote })).statusCode, 400);
  const result = await f.okay<{tasks: Task[]}>('POST', '/admin/results', f.coordinator, { freezeId: dataset.id, reviewerIds: [f.author.id, f.reviewer.id], answers: [{ questionId: 'public-question', method: 'hidden-system', runId: 'r1', text: 'Evidence', citations: [{ label: 'C1', spans: dataset.questions[0]!.evidenceSets[0] }] }] });
  assert.equal(result.tasks.length, 2);
  const view = await f.okay<TaskView>('GET', `/tasks/${result.tasks[0]!.id}`, f.author);
  assert.equal(view.question, 'What is present?'); assert.equal(view.questionType, undefined); assert.equal(view.reference?.answer, 'Evidence');
  assert(!JSON.stringify(view).includes('hidden-system'));
});

test('CLI backup captures live WAL and restore invalidates all sessions and invitations', async t => {
  const f = await fixture(t);
  f.service.invite(f.outsider.id);
  assert(f.service.store.all('session').length > 0); assert(f.service.store.all('invite').length > 0);
  const backupFile = path.join(f.directory, 'nested-backups', 'snapshot.sqlite');
  const cli = path.resolve('annotation/server/cli.ts');
  const env = { PATH: process.env.PATH, ANNOTATION_DATA_DIR: f.directory };
  execFileSync(process.execPath, ['--import', 'tsx', cli, 'backup', backupFile], { env });
  const target = path.join(f.directory, 'restored');
  execFileSync(process.execPath, ['--import', 'tsx', cli, 'restore', backupFile], { env: { ...env, ANNOTATION_DATA_DIR: target } });
  const restored = new AnnotationStore(target);
  try {
    assert.equal(restored.all('session').length, 0); assert.equal(restored.all('invite').length, 0);
    assert.deepEqual(restored.get('document', f.document.id), f.service.store.get('document', f.document.id));
    assert.equal(restored.all('participant').length, f.service.store.all('participant').length);
  } finally { restored.close(); }
  assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', cli, 'restore', backupFile], { env: { ...env, ANNOTATION_DATA_DIR: target }, stdio: 'pipe' }), /Restore requires a new empty data directory/);
});

test('single-annotator authors require exact, confirmed self-review before freezing and cannot be reviewed by another person', async t => {
  const f = await fixture(t), mode = { annotationMode: 'single_annotator', soleAnnotatorId: f.author.id };
  assert.equal((await f.request('PATCH', `/admin/projects/${f.project.id}`, f.author, mode)).statusCode, 403);
  const project = await f.okay<Project>('PATCH', `/admin/projects/${f.project.id}`, f.coordinator, mode);
  assert.equal(project.annotationMode, 'single_annotator'); assert.equal(project.soleAnnotatorId, f.author.id);
  const route = `/tasks/${f.task.id}/self-review`;
  assert.equal((await f.request('POST', route, undefined, { revision: 0, confirmed: true })).statusCode, 401);
  assert.equal((await f.request('POST', route, f.author, { revision: 0, confirmed: true })).statusCode, 409);
  await f.okay('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 0, draft: f.draft });
  assert.equal((await f.request('POST', route, f.author, { revision: 1, confirmed: true })).statusCode, 409);
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  const submission = { revision: 1, submissionId: randomUUID() };
  const submitted = await f.okay<TaskView>('POST', `/tasks/${f.task.id}/submit`, f.author, submission);
  assert.equal(submitted.task.status, 'submitted'); assert.equal(submitted.annotationMode, 'single_annotator'); assert.equal(submitted.selfReview, undefined);
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  assert.equal((await f.request('POST', route, f.author, { revision: 1, confirmed: false })).statusCode, 400);
  assert.equal((await f.request('POST', route, f.author, { revision: 0, confirmed: true })).statusCode, 409);
  for (const person of [f.coordinator, f.reviewer]) assert.equal((await f.request('POST', route, person, { revision: 1, confirmed: true })).statusCode, 403);
  const reviewed = await f.okay<TaskView>('POST', route, f.author, { revision: 1, confirmed: true });
  assert.equal(reviewed.task.status, 'completed'); assert.equal(reviewed.task.revision, 1);
  assert.deepEqual(Object.keys(reviewed.selfReview!).sort(), ['reviewedAt', 'revision']);
  assert.equal(reviewed.selfReview!.revision, 1); assert(Number.isFinite(Date.parse(reviewed.selfReview!.reviewedAt)));
  assert.deepEqual(await f.okay('POST', route, f.author, { revision: 1, confirmed: true }), reviewed);
  assert.deepEqual(await f.okay('POST', `/tasks/${f.task.id}/submit`, f.author, submission), reviewed);
  assert.equal((await f.request('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 1, draft: f.draft })).statusCode, 409);
  assert.equal((await f.request('POST', '/admin/tasks', f.coordinator, { projectId: f.project.id, documentId: f.document.id, assigneeId: f.reviewer.id, kind: 'review', sourceTaskId: f.task.id })).statusCode, 400);
  const freeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  assert.equal(freeze.questions.length, 1); assert.equal(freeze.hash, hashDataset(freeze));
  const metadata = freeze.questions[0]!.annotation!;
  assert.deepEqual(metadata, { mode: 'single_annotator', annotatorIds: [metadata.annotatorIds[0]], reviewedAt: reviewed.selfReview!.reviewedAt });
  assert.match(metadata.annotatorIds[0]!, /^[a-f0-9]{20}$/);
  assert(!JSON.stringify(freeze).includes(f.author.id));
  const changed = structuredClone(freeze); changed.questions[0]!.annotation!.reviewedAt = new Date(0).toISOString();
  assert.notEqual(hashDataset(changed), freeze.hash);
  assert.deepEqual(await f.okay('GET', `/admin/freezes/${freeze.id}/export`, f.coordinator), freeze);
});

test('project modes validate the active sole annotator and preserve drafts while guarding all historical submissions', async t => {
  const f = await fixture(t), adminProject = `/admin/projects/${f.project.id}`;
  const create = (body: unknown) => f.request('POST', '/admin/projects', f.coordinator, body);
  assert.equal((await create({ name: 'Missing person', annotationMode: 'single_annotator' })).statusCode, 400);
  assert.equal((await create({ name: 'Invalid mode', annotationMode: 'single' })).statusCode, 400);
  assert.equal((await create({ name: 'Wrong combination', annotationMode: 'independent_review', soleAnnotatorId: f.author.id })).statusCode, 400);
  await f.okay('POST', `/admin/participants/${f.outsider.id}/revoke`, f.coordinator);
  assert.equal((await create({ name: 'Inactive person', annotationMode: 'single_annotator', soleAnnotatorId: f.outsider.id })).statusCode, 400);
  const body = { annotationMode: 'single_annotator', soleAnnotatorId: f.author.id };
  assert.equal((await f.request('PATCH', adminProject, f.coordinator, { ...body, soleAnnotatorId: f.reviewer.id })).statusCode, 409);
  await f.okay('PUT', `/tasks/${f.task.id}/draft`, f.author, { revision: 0, draft: f.draft });
  const updated = await f.okay<Project>('PATCH', adminProject, f.coordinator, body);
  const preserved = await f.okay<TaskView>('GET', `/tasks/${f.task.id}`, f.author);
  assert.deepEqual(preserved.draft, f.draft); assert.equal(preserved.task.revision, 1);
  assert.deepEqual(await f.okay('PATCH', adminProject, f.coordinator, body), updated);
  assert.equal((await f.request('POST', '/admin/tasks', f.coordinator, { projectId: f.project.id, documentId: f.document.id, assigneeId: f.reviewer.id, kind: 'author' })).statusCode, 400);
  const independent = await f.okay<Project>('PATCH', adminProject, f.coordinator, { annotationMode: 'independent_review' });
  assert.equal(independent.soleAnnotatorId, undefined);
  await f.okay('POST', `/tasks/${f.task.id}/submit`, f.author, { revision: 1, submissionId: randomUUID() });
  assert.equal((await f.request('PATCH', adminProject, f.coordinator, body)).statusCode, 409);
  assert.deepEqual(await f.okay('PATCH', adminProject, f.coordinator, { annotationMode: 'independent_review' }), independent);
  assert.equal((await f.request('POST', `/tasks/${f.task.id}/self-review`, f.author, { revision: 1, confirmed: true })).statusCode, 403);
  const other = await f.okay<Project>('POST', '/admin/projects', f.coordinator, { name: 'New single project', ...body });
  assert.equal(other.soleAnnotatorId, f.author.id);
});

test('single-annotator corrections retain question identity and require a fresh review without reusing or changing frozen gold', async t => {
  const f = await fixture(t);
  await f.okay('PATCH', `/admin/projects/${f.project.id}`, f.coordinator, { annotationMode: 'single_annotator', soleAnnotatorId: f.author.id });
  await f.send(f.task, f.author);
  await f.okay('POST', `/tasks/${f.task.id}/self-review`, f.author, { revision: 1, confirmed: true });
  const oldFreeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  assert.equal((await f.request('POST', `/admin/tasks/${f.task.id}/amend`, f.coordinator, { note: 'Another author', assigneeId: f.reviewer.id })).statusCode, 400);
  const correction = await f.okay<Task>('POST', `/admin/tasks/${f.task.id}/amend`, f.coordinator, { note: 'Clarify wording' });
  assert.equal(correction.assigneeId, f.author.id);
  const correctionView = await f.okay<TaskView>('GET', `/tasks/${correction.id}`, f.author);
  assert.equal(correctionView.selfReview, undefined); assert.equal(correctionView.task.revision, 0);
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  await f.send(correction, f.author, { ...f.draft, answer: 'A corrected answer.' });
  assert.equal((await f.request('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator)).statusCode, 409);
  await f.okay('POST', `/tasks/${correction.id}/self-review`, f.author, { revision: 1, confirmed: true });
  const nextFreeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  assert.equal(nextFreeze.version, 2); assert.equal(nextFreeze.questions[0]!.id, oldFreeze.questions[0]!.id);
  assert.equal(nextFreeze.questions[0]!.answer, 'A corrected answer.');
  assert.deepEqual(nextFreeze.questions[0]!.annotation!.annotatorIds, oldFreeze.questions[0]!.annotation!.annotatorIds);
  assert.deepEqual(await f.okay('GET', `/admin/freezes/${oldFreeze.id}/export`, f.coordinator), oldFreeze);
  assert.equal((await f.request('PATCH', `/admin/projects/${f.project.id}`, f.coordinator, { annotationMode: 'independent_review' })).statusCode, 409);
  assert.equal((await f.request('PATCH', `/admin/projects/${f.project.id}`, f.coordinator, { annotationMode: 'single_annotator', soleAnnotatorId: f.reviewer.id })).statusCode, 409);
});

test('legacy projects keep independent review and freeze metadata records distinct pseudonyms', async t => {
  const f = await fixture(t);
  const { annotationMode: _mode, ...legacy } = f.project;
  f.service.store.put('project', f.project.id, legacy);
  assert.equal((await f.okay<TaskView>('GET', `/tasks/${f.task.id}`, f.author)).annotationMode, 'independent_review');
  const freeze = await f.accepted(), metadata = freeze.questions[0]!.annotation!;
  assert.equal(metadata.mode, 'independent_review'); assert.equal(new Set(metadata.annotatorIds).size, 2);
  assert(metadata.annotatorIds.every(value => /^[a-f0-9]{20}$/.test(value)));
  assert.equal((await f.request('POST', `/tasks/${f.task.id}/self-review`, f.author, { revision: 1, confirmed: true })).statusCode, 403);
  assert.equal((await f.request('PATCH', `/admin/projects/${f.project.id}`, f.coordinator, { annotationMode: 'single_annotator', soleAnnotatorId: f.author.id })).statusCode, 409);
});

test('single-annotator projects still require two blinded evaluators and reuse stable pseudonyms across projects and ratings', async t => {
  const f = await fixture(t);
  const mode = { annotationMode: 'single_annotator', soleAnnotatorId: f.author.id };
  await f.okay('PATCH', `/admin/projects/${f.project.id}`, f.coordinator, mode);
  await f.send(f.task, f.author); await f.okay('POST', `/tasks/${f.task.id}/self-review`, f.author, { revision: 1, confirmed: true });
  const freeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`, f.coordinator);
  const input = { freezeId: freeze.id, reviewerIds: [f.author.id], answers: [{ questionId: freeze.questions[0]!.id, method: 'hidden-engine', runId: 'hidden-run', text: 'An answer', citations: [] }] };
  assert.equal((await f.request('POST', '/admin/results', f.coordinator, input)).statusCode, 400);
  assert.equal((await f.request('POST', '/admin/results', f.coordinator, { ...input, reviewerIds: [f.author.id, f.author.id] })).statusCode, 400);
  const { tasks } = await f.okay<{tasks: Task[]}>('POST', '/admin/results', f.coordinator, { ...input, reviewerIds: [f.author.id, f.reviewer.id] });
  assert.equal(tasks.length, 2);
  const rating = { correctness: 2 as const, unsupported: 'no' as const, citations: 'not_applicable' as const, abstention: 'not_applicable' as const, comment: '', issue: '' };
  for (const task of tasks) {
    const actor = task.assigneeId === f.author.id ? f.author : f.reviewer;
    const view = await f.okay<TaskView>('GET', `/tasks/${task.id}`, actor);
    assert.equal(view.annotationMode, 'single_annotator'); assert.equal(view.selfReview, undefined);
    assert(!JSON.stringify(view).includes('hidden-engine')); assert(!JSON.stringify(view).includes('hidden-run'));
    assert.equal((await f.request('POST', `/tasks/${task.id}/self-review`, actor, { revision: 0, confirmed: true })).statusCode, 403);
    await f.send(task, actor, { ...f.draft, rating });
  }
  const adjudication = await f.okay<Task>('POST', '/admin/tasks', f.coordinator, { projectId: f.project.id, documentId: f.document.id, kind: 'adjudicate', assigneeId: f.judge.id, sourceTaskId: tasks[0]!.id });
  const judgeView = await f.okay<TaskView>('GET', `/tasks/${adjudication.id}`, f.judge);
  assert.equal(judgeView.adjudication!.length, 2); assert(judgeView.answer);
  assert.equal((await f.request('POST', `/tasks/${adjudication.id}/self-review`, f.judge, { revision: 0, confirmed: true })).statusCode, 403);
  const exportRatings = await f.okay<{answers: Array<{raw: Array<{participant: string}>}>}>('GET', `/admin/freezes/${freeze.id}/ratings/export`, f.coordinator);
  assert(exportRatings.answers[0]!.raw.some(value => value.participant === freeze.questions[0]!.annotation!.annotatorIds[0]));
  const second = f.service.createProject({ name: 'Other split', ...mode });
  const doc = f.service.createDocument({ projectId: second.id, title: 'Other source', blocks: [{ text: 'Evidence' }] });
  const task = f.service.createTask({ projectId: second.id, documentId: doc.id, kind: 'author', assigneeId: f.author.id });
  await f.send(task, f.author, { ...f.draft, unanswerable: true, answer: '', evidenceSets: [] });
  await f.okay('POST', `/tasks/${task.id}/self-review`, f.author, { revision: 1, confirmed: true });
  const secondFreeze = await f.okay<FrozenDataset>('POST', `/admin/projects/${second.id}/freeze`, f.coordinator);
  assert.deepEqual(secondFreeze.questions[0]!.annotation!.annotatorIds, freeze.questions[0]!.annotation!.annotatorIds);
});

test('import validates annotation provenance, includes it in the hash, preserves old datasets and prevents frozen project mode changes', async t => {
  const source = await fixture(t), target = await fixture(t);
  const original = await source.accepted();
  const withoutMetadata = structuredClone(original); delete withoutMetadata.questions[0]!.annotation; withoutMetadata.hash = hashDataset(withoutMetadata);
  const candidate = (metadata: unknown): FrozenDataset => {
    const value = structuredClone(original); value.questions[0]!.annotation = metadata as FrozenDataset['questions'][number]['annotation']; value.hash = hashDataset(value); return value;
  };
  const validSingle = candidate({ mode: 'single_annotator', annotatorIds: ['0123456789abcdefabcd'], reviewedAt: new Date().toISOString() });
  assert.deepEqual(await target.okay('POST', '/admin/datasets', target.coordinator, { dataset: validSingle }), validSingle);
  assert.deepEqual(await target.okay('POST', '/admin/datasets', target.coordinator, { dataset: validSingle }), validSingle);
  assert.equal((await target.request('PATCH', `/admin/projects/${validSingle.projectId}`, target.coordinator, { annotationMode: 'single_annotator', soleAnnotatorId: target.author.id })).statusCode, 409);
  for (const metadata of [
    { mode: 'single_annotator', annotatorIds: [], reviewedAt: validSingle.createdAt },
    { mode: 'single_annotator', annotatorIds: ['0123456789abcdefabcd', '1123456789abcdefabcd'], reviewedAt: validSingle.createdAt },
    { mode: 'independent_review', annotatorIds: ['0123456789abcdefabcd'], reviewedAt: validSingle.createdAt },
    { mode: 'independent_review', annotatorIds: ['0123456789abcdefabcd', '0123456789abcdefabcd'], reviewedAt: validSingle.createdAt },
    { mode: 'single_annotator', annotatorIds: [source.author.id], reviewedAt: validSingle.createdAt },
    { mode: 'single_annotator', annotatorIds: ['0123456789abcdefabcd'], reviewedAt: 'Yesterday' },
    { mode: 'single_annotator', annotatorIds: ['0123456789abcdefabcd'], reviewedAt: validSingle.createdAt, name: 'Not a pseudonym' },
  ]) assert.equal((await target.request('POST', '/admin/datasets', target.coordinator, { dataset: candidate(metadata) })).statusCode, 400);
  const tampered = structuredClone(validSingle); tampered.questions[0]!.annotation!.annotatorIds[0] = '1123456789abcdefabcd';
  assert.equal((await target.request('POST', '/admin/datasets', target.coordinator, { dataset: tampered })).statusCode, 400);
  const legacyTarget = await fixture(t);
  assert.deepEqual(await legacyTarget.okay('POST', '/admin/datasets', legacyTarget.coordinator, { dataset: withoutMetadata }), withoutMetadata);
  const independentTarget = await fixture(t);
  assert.deepEqual(await independentTarget.okay('POST', '/admin/datasets', independentTarget.coordinator, { dataset: original }), original);
});
