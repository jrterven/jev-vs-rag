import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AnnotationStore } from '../../../annotation/dist/runtime/server/store.js';
import { AnnotationService } from '../../../annotation/dist/runtime/server/service.js';
import { loadConfig } from '../../../annotation/dist/runtime/server/config.js';
import { createAuthoringPilot, validatePilotPayload } from '../create-authoring-pilot.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'authoring-pilot-'));
  const config = loadConfig({ ANNOTATION_DATA_DIR: directory });
  const store = new AnnotationStore(directory), service = new AnnotationService(store, config);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const participant = service.createParticipant({ name: 'Juan Terven', role: 'coordinator', canAdjudicate: true });
  const documents = ['First source with café and 🔬.', 'Second independent source.'].map((text, index) => ({
    title: `Piloto · Article ${index + 1}`, sourceUrl: `https://example.org/paper-${index + 1}`,
    blocks: [{ text, heading: 'Abstract' }],
    source: { documentId: `source-${index + 1}`, corpus: 'qasper-development', split: 'development', url: `https://example.org/paper-${index + 1}`, license: 'Fixture only', licenseUrl: 'https://example.org/license', acquiredAt: '2026-10-03T00:00:00.000Z', rawSha256: sha(`raw${index}`), textSha256: sha(text) },
  }));
  const payload = { schemaVersion: 1, projectName: 'Piloto de anotación · desarrollo', assigneeId: participant.id, expectedName: 'Juan Terven', parentDatasetHash: sha('source bundle'), documents };
  return { store, service, payload, participant };
}

test('authoring pilot preserves source text, creates one task per document, and reruns without duplicates', async t => {
  const { store, service, payload } = await fixture(t);
  const first = createAuthoringPilot(service, payload);
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const second = createAuthoringPilot(service, reordered);
  assert.equal(first.reused, false); assert.equal(second.reused, true);
  assert.deepEqual({ ...second, reused: false }, first);
  assert.equal(store.all('project').length, 1); assert.equal(store.all('document').length, 2); assert.equal(store.all('task').length, 2);
  for (const item of first.documents) {
    const doc = store.get('document', item.documentId), task = store.get('task', item.taskId);
    assert.equal(doc.info.hash, item.source.textSha256);
    assert.equal(task.task.assigneeId, payload.assigneeId); assert.equal(task.task.kind, 'author'); assert.equal(task.draft, null);
  }
  assert.equal(store.all('participant').length, 1);
  for (const kind of ['invite', 'session', 'freeze', 'result', 'submission']) assert.equal(store.all(kind).length, 0);
  const marker = store.get('authoring-pilot-import', first.payloadHash);
  assert.equal(marker.parentDatasetHash, payload.parentDatasetHash);
  assert.deepEqual(marker.documents[0].source, payload.documents[0].source);
});

test('pilot rejects test sources, unverified text, and embedded gold before writing', async t => {
  const { store, service, payload } = await fixture(t);
  for (const change of [
    value => { value.documents[0].source.split = 'test'; },
    value => { value.documents[0].blocks[0].text += ' changed'; },
    value => { value.questions = [{ question: 'Existing gold' }]; },
    value => { value.documents[0].answers = ['Existing answer']; },
  ]) {
    const invalid = structuredClone(payload); change(invalid);
    assert.throws(() => createAuthoringPilot(service, invalid));
  }
  for (const kind of ['project', 'document', 'task', 'authoring-pilot-import']) assert.equal(store.all(kind).length, 0);
});

test('pilot validates an existing active coordinator and the expected recipient', async t => {
  const { store, service, payload, participant } = await fixture(t);
  assert.throws(() => createAuthoringPilot(service, { ...payload, expectedName: 'Somebody else' }), /expectedName/);
  assert.throws(() => createAuthoringPilot(service, { ...payload, assigneeId: 'missing' }));
  store.put('participant', participant.id, { ...participant, active: false });
  assert.throws(() => createAuthoringPilot(service, payload), /coordinación/);
  store.put('participant', participant.id, { ...participant, role: 'collaborator' });
  assert.throws(() => createAuthoringPilot(service, payload), /coordinación/);
  assert.equal(store.all('participant').length, 1); assert.equal(store.all('project').length, 0);
});

test('pilot rolls back every document, task and marker if a later service call fails', async t => {
  const { store, service, payload } = await fixture(t);
  const original = service.createTask.bind(service); let count = 0;
  service.createTask = value => { if (++count === 2) throw new Error('Injected second-task failure'); return original(value); };
  assert.throws(() => createAuthoringPilot(service, payload), /second-task failure/);
  for (const kind of ['project', 'document', 'task', 'authoring-pilot-import']) assert.equal(store.all(kind).length, 0);
  service.createTask = original;
  assert.equal(createAuthoringPilot(service, payload).documents.length, 2);
});

test('pilot labels and acquisition fields are required; input objects remain unchanged', async t => {
  const { payload } = await fixture(t);
  const before = structuredClone(payload);
  assert.deepEqual(validatePilotPayload(payload), before);
  assert.deepEqual(payload, before);
  assert.throws(() => validatePilotPayload({ ...payload, projectName: 'Production test' }), /Piloto/);
  const withoutLicense = structuredClone(payload); delete withoutLicense.documents[0].source.license;
  assert.throws(() => validatePilotPayload(withoutLicense), /license/);
});
