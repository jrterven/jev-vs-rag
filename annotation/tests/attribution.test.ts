import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { hashDataset } from '../server/canonical.js';
import type { DocumentInfo, FrozenDataset, Project, Task, TaskView, TextBlock } from '../shared/types.js';

const attribution = {
  text: 'Synthetic test book · Edición de prueba', url: 'https://example.test/book',
  license: 'Test license', licenseUrl: 'https://example.test/license',
  notice: 'Synthetic usage notice.\nPreserve the complete notice with the source.',
};

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'annotation-attribution-'));
  const config = loadConfig({ ANNOTATION_DATA_DIR: directory });
  const app = await buildApp({ config, serveStatic: false });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const person = app.annotation.createParticipant({ name: 'Synthetic attribution test', role: 'coordinator' });
  const token = new URLSearchParams(new URL(app.annotation.invite(person.id)).hash.slice(1)).get('invite');
  const baseHeaders = { host: '127.0.0.1:3002', origin: config.origin, 'x-annotation-csrf': '1' };
  const access = await app.inject({ method: 'POST', url: '/api/annotation/auth/redeem', headers: baseHeaders, payload: { token } });
  assert.equal(access.statusCode, 200);
  const cookie = access.headers['set-cookie']!.toString().split(';')[0]!;
  async function request(method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown) {
    return app.inject({ method, url: '/api/annotation' + route, headers: { ...baseHeaders, cookie }, ...(method === 'GET' ? {} : { payload: body ?? {} }) });
  }
  async function okay<T>(method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown): Promise<T> {
    const response = await request(method, route, body);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as T;
  }
  const project = await okay<Project>('POST', '/admin/projects', { name: 'Synthetic attribution test', annotationMode: 'single_annotator', soleAnnotatorId: person.id });
  return { app, person, project, request, okay };
}

test('document attribution survives API creation, reading, personal review, freeze and JSON export', async t => {
  const f = await fixture(t);
  const document = await f.okay<DocumentInfo>('POST', '/admin/documents', {
    projectId: f.project.id, title: 'Synthetic test book', sourceUrl: attribution.url, attribution,
    blocks: [{ text: 'The reading room opens at nine.', heading: 'Opening times', page: 1 }],
  });
  assert.deepEqual(document.attribution, attribution);
  const task = await f.okay<Task>('POST', '/admin/tasks', { projectId: f.project.id, documentId: document.id, assigneeId: f.person.id, kind: 'author' });
  const view = await f.okay<TaskView>('GET', `/tasks/${task.id}`);
  assert.deepEqual(view.document.attribution, attribution);
  const { blocks } = await f.okay<{ blocks: TextBlock[] }>('GET', `/documents/${document.id}/blocks?offset=0&limit=200`);
  const block = blocks[0]!;
  const { revision } = await f.okay<{ revision: number }>('PUT', `/tasks/${task.id}/draft`, {
    revision: 0, draft: { question: 'When does the reading room open?', questionType: 'factual', answer: 'At nine.', evidenceSets: [[{ blockId: block.id, start: block.start, end: block.end, quote: block.text }]] },
  });
  await f.okay('POST', `/tasks/${task.id}/submit`, { revision, submissionId: randomUUID() });
  await f.okay('POST', `/tasks/${task.id}/self-review`, { revision, confirmed: true });
  const frozen = await f.okay<FrozenDataset>('POST', `/admin/projects/${f.project.id}/freeze`);
  const exported = await f.okay<FrozenDataset>('GET', `/admin/freezes/${frozen.id}/export`);
  assert.deepEqual(exported, frozen);
  assert.deepEqual(exported.documents[0]!.attribution, attribution);
  assert.equal(exported.hash, hashDataset(exported));
  const changedNotice = structuredClone(exported);
  changedNotice.documents[0]!.attribution!.notice = 'Changed notice';
  assert.notEqual(hashDataset(changedNotice), exported.hash, 'Source attribution must remain part of the frozen dataset hash');
});

test('unsafe attribution and license URLs are rejected without creating a document', async t => {
  const f = await fixture(t);
  for (const invalid of [{ ...attribution, url: 'javascript:alert(1)' }, { ...attribution, licenseUrl: 'data:text/html,unsafe' }]) {
    const response = await f.request('POST', '/admin/documents', { projectId: f.project.id, title: 'Rejected test book', blocks: [{ text: 'Test text.' }], attribution: invalid });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(f.app.annotation.overview().documents.length, 0);
});
