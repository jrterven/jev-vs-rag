import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AnnotationService } from '../../../annotation/server/service.ts';
import { AnnotationStore } from '../../../annotation/server/store.ts';
import { loadConfig } from '../../../annotation/server/config.ts';
import { configureSingleAnnotator } from '../configure-single-annotator.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'single-setup-')), store = new AnnotationStore(directory), service = new AnnotationService(store, loadConfig({ ANNOTATION_DATA_DIR: directory }));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const participant = service.createParticipant({ name: 'Test coordinator', role: 'coordinator' }), project = service.createProject({ name: 'Practice' });
  const document = service.createDocument({ projectId: project.id, title: 'Test source', blocks: [{ text: 'Test evidence.' }] });
  const task = service.createTask({ projectId: project.id, documentId: document.id, assigneeId: participant.id, kind: 'author' });
  const token = service.invite(participant.id).split('=')[1]; service.redeem(token);
  return { store, service, participant, task, payload: { schemaVersion: 1, participantId: participant.id, expectedName: participant.name, practiceProjectId: project.id, expectedPracticeName: project.name, bookProjectNames: ['Book development', 'Book test'] } };
}

test('single-person setup is idempotent and preserves tasks, documents, accounts and access', t => {
  const { store, service, payload } = fixture(t);
  const kinds = ['participant', 'task', 'document', 'invite', 'session'];
  const before = kinds.map(kind => store.all(kind));
  const first = configureSingleAnnotator(service, payload), second = configureSingleAnnotator(service, payload);
  assert.equal(first.reused, false); assert.equal(second.reused, true); assert.deepEqual(second.bookProjectIds, first.bookProjectIds);
  assert.equal(store.all('project').length, 3); assert.deepEqual(kinds.map(kind => store.all(kind)), before);
  for (const project of store.all('project')) { assert.equal(project.annotationMode, 'single_annotator'); assert.equal(project.soleAnnotatorId, payload.participantId); }
  for (const kind of ['freeze', 'submission', 'result', 'revision']) assert.equal(store.all(kind).length, 0);
});

test('setup rejects wrong identities or conflicting book projects before changing practice', t => {
  const { store, service, payload } = fixture(t);
  assert.throws(() => configureSingleAnnotator(service, { ...payload, expectedName: 'Somebody else' }), /identity/);
  assert.throws(() => configureSingleAnnotator(service, { ...payload, expectedPracticeName: 'Different' }), /identity/);
  service.createProject({ name: payload.bookProjectNames[0] });
  assert.throws(() => configureSingleAnnotator(service, payload), /conflicts/);
  assert.notEqual(store.get('project', payload.practiceProjectId).annotationMode, 'single_annotator');
  assert.equal(store.all('single-annotator-setup').length, 0);
});

test('setup refuses to relabel submitted work and creates no book projects after refusal', t => {
  const { store, service, payload, task, participant } = fixture(t);
  const draft = { question: 'Test question?', questionType: 'factual', answer: '', evidenceSets: [], unanswerable: true };
  const { revision } = service.saveDraft(task.id, participant, { revision: 0, draft });
  service.submit(task.id, participant, { revision, submissionId: crypto.randomUUID() });
  assert.throws(() => configureSingleAnnotator(service, payload));
  assert.equal(store.all('project').length, 1); assert.equal(store.all('single-annotator-setup').length, 0);
  assert.equal(store.get('task', task.id).task.status, 'submitted');
});
