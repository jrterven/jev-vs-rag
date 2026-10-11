import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import type { AnnotationDraft, Task, TaskView } from '../shared/types.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'assigned-question-type-'));
  const config = loadConfig({ ANNOTATION_DATA_DIR: directory }), app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const service = app.annotation, person = service.createParticipant({ name: 'Author', role: 'coordinator' });
  const token = service.redeem(service.invite(person.id).split('=')[1]).session;
  const headers = { host: '127.0.0.1:3002', origin: config.origin, 'x-annotation-csrf': '1', cookie: `annotation_session=${token}` };
  const request = (method: 'POST' | 'PUT' | 'GET', route: string, payload?: unknown) => app.inject({ method, url: `/api/annotation${route}`, headers, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });
  const project = service.createProject({ name: 'Single author', annotationMode: 'single_annotator', soleAnnotatorId: person.id });
  const document = service.createDocument({ projectId: project.id, title: 'Source', blocks: [{ text: 'Evidence.' }] });
  const base = { projectId: project.id, documentId: document.id, assigneeId: person.id, kind: 'author' };
  const draft: AnnotationDraft = { question: 'What cannot be answered?', questionType: 'explanatory', answer: '', evidenceSets: [], unanswerable: true };
  return { service, person, request, base, draft };
}

test('assigned authoring type is visible with a blank draft, enforced on save and submission, and inherited by corrections', async t => {
  const f = await fixture(t), title = 'Source · Explicativa 1/3';
  const created = await f.request('POST', '/admin/tasks', { ...f.base, title, assignedQuestionType: 'explanatory' });
  assert.equal(created.statusCode, 200); const task = created.json<Task>();
  assert.equal(task.assignedQuestionType, 'explanatory'); assert.equal(task.title, title);
  const initial = (await f.request('GET', `/tasks/${task.id}`)).json<TaskView>();
  assert.equal(initial.draft, null); assert.equal(initial.questionType, 'explanatory'); assert.equal(initial.task.status, 'assigned');
  assert.equal((await f.request('PUT', `/tasks/${task.id}/draft`, { revision: 0, draft: { ...f.draft, questionType: 'factual' } })).statusCode, 400);
  assert.equal((await f.request('PUT', `/tasks/${task.id}/draft`, { revision: 0, draft: f.draft })).statusCode, 200);
  // A mismatched persisted value also cannot bypass the rule by calling submit.
  const record = f.service.store.get<{draft: AnnotationDraft}>('task', task.id)!;
  f.service.store.put('task', task.id, { ...record, draft: { ...record.draft, questionType: 'factual' } });
  assert.equal((await f.request('POST', `/tasks/${task.id}/submit`, { revision: 1, submissionId: randomUUID() })).statusCode, 400);
  f.service.store.put('task', task.id, record);
  assert.equal((await f.request('POST', `/tasks/${task.id}/submit`, { revision: 1, submissionId: randomUUID() })).statusCode, 200);
  assert.equal((await f.request('POST', `/tasks/${task.id}/self-review`, { revision: 1, confirmed: true })).statusCode, 200);
  const corrected = await f.request('POST', `/admin/tasks/${task.id}/amend`, { note: 'Clarify the question.' });
  assert.equal(corrected.statusCode, 200); const amendment = corrected.json<Task>();
  assert.equal(amendment.assignedQuestionType, 'explanatory'); assert.equal(amendment.title, title);
  assert.equal((await f.request('PUT', `/tasks/${amendment.id}/draft`, { revision: 0, draft: { ...f.draft, questionType: 'multi_section' } })).statusCode, 400);
});

test('assigned types reject unsupported values/non-author tasks and keep legacy author types editable', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/admin/tasks', { ...f.base, assignedQuestionType: 'arbitrary' })).statusCode, 400);
  for (const kind of ['review', 'adjudicate']) for (const extra of [{ title: 'Custom' }, { assignedQuestionType: 'factual' }]) assert.equal((await f.request('POST', '/admin/tasks', { ...f.base, kind, ...extra })).statusCode, 400);
  const created = await f.request('POST', '/admin/tasks', f.base); assert.equal(created.statusCode, 200);
  const task = created.json<Task>(); assert.equal(task.assignedQuestionType, undefined); assert.equal(task.title, 'Source');
  assert.equal((await f.request('PUT', `/tasks/${task.id}/draft`, { revision: 0, draft: f.draft })).statusCode, 200);
  assert.equal((await f.request('PUT', `/tasks/${task.id}/draft`, { revision: 1, draft: { ...f.draft, questionType: 'multi_section' } })).statusCode, 200);
});

test('task lists enrich only assigned books/projects once per ID without persisting display metadata', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) f.service.createTask({ ...f.base, title: `Source · Factual ${index + 1}` });
  const other = f.service.createParticipant({ name: 'Other', role: 'collaborator' });
  const project = f.service.createProject({ name: 'Not assigned' });
  const document = f.service.createDocument({ projectId: project.id, title: 'Private book', blocks: [{ text: 'Private' }] });
  f.service.createTask({ projectId: project.id, documentId: document.id, assigneeId: other.id, kind: 'author' });
  const original = f.service.store.get.bind(f.service.store), documentReads: string[] = [], projectReads: string[] = [];
  f.service.store.get = (kind, id) => { if (kind === 'document') documentReads.push(id); if (kind === 'project') projectReads.push(id); return original(kind, id); };
  const response = await f.request('GET', '/tasks'); assert.equal(response.statusCode, 200);
  const tasks = response.json<Task[]>(); assert.equal(tasks.length, 10);
  assert(tasks.every(task => task.projectName === 'Single author' && task.documentTitle === 'Source'));
  assert.deepEqual(documentReads, [f.base.documentId]); assert.deepEqual(projectReads, [f.base.projectId]);
  for (const record of f.service.store.all<{task: Task}>('task')) { assert.equal(record.task.projectName, undefined); assert.equal(record.task.documentTitle, undefined); }
});
