import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AnnotationService } from '../../../annotation/server/service.ts';
import { AnnotationStore } from '../../../annotation/server/store.ts';
import { loadConfig } from '../../../annotation/server/config.ts';
import { BOOK_PLAN, importBooks, validateBooksPayload } from '../import-books.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'import-books-')), store = new AnnotationStore(directory), service = new AnnotationService(store, loadConfig({ ANNOTATION_DATA_DIR: directory }));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const participant = service.createParticipant({ name: 'Juan Terven', role: 'coordinator', canAdjudicate: true });
  const policy = { annotationMode: 'single_annotator', soleAnnotatorId: participant.id };
  const development = service.createProject({ name: 'Libros · desarrollo', ...policy }), test = service.createProject({ name: 'Libros · evaluación', ...policy });
  const token = service.invite(participant.id).split('=')[1]; service.redeem(token);
  const documents = BOOK_PLAN.map(([title, split, slug]) => {
    const sourceUrl = `https://openstax.org/books/${slug}/pages/preface`, license = 'Fixture license; not a claim about the actual edition', licenseUrl = 'https://example.org/fixture-license';
    const blocks = [{ text: `First block: ${title} 🔬.`, heading: 'Preface', page: 1 }, { text: `Final block: ${title}.`, heading: 'Last section', page: 2 }];
    const source = { documentId: `openstax:${slug}`, corpus: split === 'development' ? 'openstax-development' : 'openstax-books', split, url: sourceUrl, license, licenseUrl, acquiredAt: '2026-10-03T00:00:00.000Z', rawSha256: sha(`raw:${slug}`), textSha256: sha(blocks.map(block => block.text).join('\n\n')), warnings: ['Synthetic fixture text only.'] };
    return { title, sourceUrl, attribution: { text: 'OpenStax · Rice University. Test fixture only.', url: sourceUrl, license, licenseUrl, notice: 'No model execution.' }, blocks, source };
  });
  const payload = { schemaVersion: 1, assigneeId: participant.id, expectedName: participant.name, projects: { development: { id: development.id, name: development.name }, test: { id: test.id, name: test.name } }, documents };
  return { store, service, participant, payload };
}
const importedKinds = ['document', 'task', 'books-authoring-import', 'revision', 'submission', 'freeze', 'result'];
const assertEmpty = store => importedKinds.forEach(kind => assert.equal(store.all(kind).length, 0, kind));

test('imports ten source documents and 100 typed blank authoring tasks atomically, preserving attribution and split mappings', t => {
  const { store, service, participant, payload } = fixture(t);
  const preserved = ['participant', 'project', 'invite', 'session'].map(kind => store.all(kind));
  const original = structuredClone(payload), receipt = importBooks(service, payload);
  assert.equal(receipt.reused, false); assert.equal(receipt.humanAnnotationsCreated, 0); assert.equal(receipt.tasksCreated, 100);
  assert.deepEqual(payload, original); assert.equal(store.all('document').length, 10); assert.equal(store.all('task').length, 100);
  assert.equal(receipt.sourcesBySplit.development.length, 2); assert.equal(receipt.sourcesBySplit.test.length, 8);
  const originalIds = new Set(payload.documents.map(doc => doc.source.documentId));
  for (const item of receipt.documents) {
    const doc = store.get('document', item.documentId), input = payload.documents.find(doc => doc.source.documentId === item.sourceDocumentId);
    assert(originalIds.has(item.sourceDocumentId)); assert.equal(item.source.documentId, item.documentId);
    assert.equal(item.projectId, payload.projects[item.split].id);
    assert.equal(doc.info.hash, input.source.textSha256); assert.deepEqual(doc.info.attribution, input.attribution);
    assert.deepEqual(item.source, { ...input.source, documentId: item.documentId });
    assert.equal(doc.blocks[1].start, doc.blocks[0].text.length + 2); assert.equal(doc.blocks[1].text, input.blocks[1].text);
    const counts = { factual: 0, explanatory: 0, multi_section: 0 };
    for (const mapped of item.tasks) {
      const record = store.get('task', mapped.taskId), task = record.task;
      assert.equal(record.draft, null); assert.equal(task.status, 'assigned'); assert.equal(task.revision, 0);
      assert.equal(task.kind, 'author'); assert.equal(task.assigneeId, participant.id); assert.equal(task.documentId, item.documentId);
      assert.equal(task.assignedQuestionType, mapped.assignedQuestionType); counts[task.assignedQuestionType]++;
      assert(task.title.startsWith(`${input.title} · `)); assert.equal(service.view(task.id, participant).questionType, task.assignedQuestionType);
    }
    assert.deepEqual(counts, { factual: 4, explanatory: 3, multi_section: 3 });
  }
  assert.deepEqual(['participant', 'project', 'invite', 'session'].map(kind => store.all(kind)), preserved);
  for (const kind of ['revision', 'submission', 'freeze', 'result']) assert.equal(store.all(kind).length, 0);
});

test('retry canonicalizes JSON/document order, creates no duplicates, and preserves human drafts and completed work', t => {
  const { store, service, participant, payload } = fixture(t), first = importBooks(service, payload);
  const firstTask = first.documents[0].tasks[0];
  const draft = { question: 'A human question?', questionType: firstTask.assignedQuestionType, answer: '', evidenceSets: [], unanswerable: true };
  const { revision } = service.saveDraft(firstTask.taskId, participant, { revision: 0, draft });
  service.submit(firstTask.taskId, participant, { revision, submissionId: crypto.randomUUID() });
  service.selfReview(firstTask.taskId, participant, { revision, confirmed: true });
  const before = store.all('task');
  const reordered = Object.fromEntries(Object.entries({ ...payload, documents: [...payload.documents].reverse() }).reverse());
  const second = importBooks(service, reordered);
  assert.equal(second.reused, true); assert.deepEqual({ ...second, reused: false }, first);
  assert.deepEqual(store.all('task'), before); assert.equal(store.all('document').length, 10); assert.equal(store.all('books-authoring-import').length, 1);
});

test('rejects cross-split, unapproved or duplicate books, changed text, attribution mismatch and embedded annotations before writing', t => {
  const { store, service, payload } = fixture(t);
  for (const alter of [
    value => { value.documents.pop(); },
    value => { value.documents[0].source.split = 'test'; value.documents[0].source.corpus = 'openstax-books'; },
    value => { value.documents[0].title = 'Some other book'; },
    value => { value.documents[0].source.documentId = 'different-id'; },
    value => { value.documents[1] = structuredClone(value.documents[0]); },
    value => { value.documents[0].blocks[0].text += ' Altered.'; },
    value => { value.documents[1].source.textSha256 = value.documents[0].source.textSha256; },
    value => { value.documents[1].source.rawSha256 = value.documents[0].source.rawSha256; },
    value => { value.documents[0].attribution.license = 'Wrong'; },
    value => { delete value.documents[0].attribution; },
    value => { value.documents[0].source.url = 'https://user:password@openstax.org/book'; },
    value => { value.documents[0].source.acquiredAt = 'not-a-date'; },
    value => { value.documents[0].questions = [{ question: 'No artificial gold' }]; },
    value => { value.documents[0].blocks[0].answer = 'No answers'; },
    value => { value.projects.test.id = value.projects.development.id; },
  ]) {
    const invalid = structuredClone(payload); alter(invalid);
    assert.throws(() => importBooks(service, invalid)); assertEmpty(store);
  }
});

test('validates existing active Juan and exact single-annotator project identities without creating accounts or changing policy', t => {
  const { store, service, participant, payload } = fixture(t);
  assert.throws(() => importBooks(service, { ...payload, assigneeId: 'missing' }));
  assert.throws(() => importBooks(service, { ...payload, expectedName: 'Another person' }));
  for (const override of [{ active: false }, { role: 'collaborator' }, { name: 'Different Name' }]) {
    store.put('participant', participant.id, { ...participant, ...override });
    assert.throws(() => importBooks(service, payload)); assertEmpty(store);
  }
  store.put('participant', participant.id, participant);
  const project = store.get('project', payload.projects.development.id);
  for (const override of [{ annotationMode: 'independent_review' }, { soleAnnotatorId: 'other' }, { name: 'Renamed project' }]) {
    store.put('project', project.id, { ...project, ...override });
    assert.throws(() => importBooks(service, payload), /project identity/); assertEmpty(store);
  }
  store.put('project', project.id, project);
  assert.equal(store.all('participant').length, 1); assert.equal(store.all('project').length, 2);
});

test('rejects conflicting reruns and corrupt markers without overwriting documents or human work', t => {
  const { store, service, payload } = fixture(t), receipt = importBooks(service, payload);
  const changed = structuredClone(payload); changed.documents[0].source.warnings.push('Different acquisition decision');
  assert.throws(() => importBooks(service, changed), /different books import/);
  const taskId = receipt.documents[0].tasks[0].taskId, record = store.get('task', taskId);
  store.put('task', taskId, { ...record, task: { ...record.task, assignedQuestionType: 'multi_section' } });
  assert.throws(() => importBooks(service, payload), /task conflicts/);
  assert.equal(store.all('document').length, 10); assert.equal(store.all('task').length, 100);
  assert.equal(store.all('books-authoring-import').length, 1);
});

test('refuses overlapping source text in another project and existing target content without a marker', t => {
  const { store, service, payload } = fixture(t);
  const other = service.createProject({ name: 'Other corpus' }), first = payload.documents[0];
  const existing = service.createDocument({ projectId: other.id, title: 'An existing edition', blocks: first.blocks });
  assert.throws(() => importBooks(service, payload), /split leakage/);
  store.remove('document', existing.id);
  service.createDocument({ projectId: payload.projects.development.id, title: 'Untracked document', blocks: [{ text: 'Untracked' }] });
  assert.throws(() => importBooks(service, payload), /already contain data/);
  assert.equal(store.all('document').length, 1); assert.equal(store.all('task').length, 0);
});

test('a late failure rolls back all books, all tasks and the receipt; the same input can safely retry', t => {
  const { store, service, payload } = fixture(t), original = service.createTask.bind(service); let calls = 0;
  service.createTask = input => { if (++calls === 73) throw new Error('Injected late task failure'); return original(input); };
  assert.throws(() => importBooks(service, payload), /late task failure/); assertEmpty(store);
  assert.equal(store.all('project').length, 2); assert.equal(store.all('participant').length, 1);
  service.createTask = original;
  assert.equal(importBooks(service, payload).tasksCreated, 100);
});

test('source metadata and assigned question plan remain explicit rather than fabricated human annotations', t => {
  const { payload } = fixture(t), validated = validateBooksPayload(payload);
  assert.equal(validated.documents.length, 10);
  assert.equal(validated.documents.filter(doc => doc.source.split === 'development').length, 2);
  assert(validated.documents.every(doc => doc.source.warnings[0] === 'Synthetic fixture text only.'));
  assert.deepEqual(validated, payload);
});
