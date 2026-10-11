import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleBooks, freezeHash, makeFreeze, textBlocks, validateFreeze } from '../datasets.js';
import { createManifest, loadConfig, runExperiment } from '../runner.js';
import { Ledger } from '../ledger.js';
import type { DatasetBundle, FrozenDataset, FrozenQuestion, SourceRecord } from '../types.js';
import { sha256 } from '../util.js';

const person = 'a'.repeat(20), other = 'b'.repeat(20);
function fixture(prefix = 'books'): DatasetBundle {
  const projectId = `${prefix}-project`;
  const documents: FrozenDataset['documents'] = Array.from({ length: 8 }, (_, index) => {
    const id = `${prefix}-${index}`, blocks = textBlocks(id, [{ text: `Test-only evidence ${id}.` }]);
    return { id, projectId, title: id, hash: sha256(blocks[0]!.text), version: 1, blockCount: 1, sections: [], blocks };
  });
  const questions: FrozenQuestion[] = documents.flatMap(doc => Array.from({ length: 10 }, (_, index) => ({
    id: `${doc.id}:q${index}`, documentId: doc.id, question: `Test-only question ${index}?`,
    questionType: index < 4 ? 'factual' : index < 7 ? 'explanatory' : 'multi_section', answer: 'Test-only answer.',
    evidenceSets: [[{ blockId: doc.blocks[0]!.id, start: 0, end: doc.blocks[0]!.text.length, quote: doc.blocks[0]!.text }]],
    annotation: { mode: 'single_annotator', annotatorIds: [person], reviewedAt: '2026-10-03T00:00:00.000Z' },
  })));
  const freeze = makeFreeze(projectId, documents, questions);
  const sources: SourceRecord[] = documents.map(doc => ({ documentId: doc.id, corpus: 'openstax-books', split: 'test', url: 'https://example.test/source', license: 'test fixture', licenseUrl: 'https://example.test/license', acquiredAt: '2026-10-03', rawSha256: '0'.repeat(64), textSha256: doc.hash }));
  return { schemaVersion: 1, freeze, sources, provenance: { fixture: true } };
}
const rehash = (bundle: DatasetBundle) => { bundle.freeze.hash = freezeHash(bundle.freeze); return bundle; };
const config = () => { const value = loadConfig(); value.methods = ['bm25']; value.generation.questions = 0; value.timing.questions = 0; return value; };

test('book import preserves hashed personal-review provenance without claiming independent review', () => {
  const original = fixture(), result = bundleBooks(original.freeze, original.sources);
  assert.equal(result.freeze.hash, original.freeze.hash);
  assert.equal(result.freeze.questions.length, 80);
  assert.equal(result.provenance.annotationMode, 'single_annotator');
  assert.equal(result.provenance.independentReview, false);
  assert.deepEqual(result.provenance.annotatorIds, [person]);
  assert.deepEqual(result.freeze.questions[0]!.annotation, original.freeze.questions[0]!.annotation);
});

test('legacy external gold remains readable but cannot silently become single-annotator book gold', () => {
  const original = fixture(); delete original.freeze.questions[0]!.annotation; rehash(original);
  assert.doesNotThrow(() => validateFreeze(original.freeze));
  assert.throws(() => bundleBooks(original.freeze, original.sources), /confirmed personal review/);
  assert.throws(() => createManifest([original], config(), { id: 'missing-book-review', mock: false, phase: 'test' }), /confirmed personal review/);
  assert.doesNotThrow(() => createManifest([original], config(), { id: 'explicit-mock', mock: true, phase: 'test' }));
  original.sources.forEach(source => { source.corpus = 'openstax-development'; source.split = 'development'; });
  assert.throws(() => createManifest([original], config(), { id: 'missing-pilot-review', mock: false, phase: 'pilot' }), /confirmed personal review/);
});

test('the shared study ledger rejects a different book author before model initialization or API usage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'single-book-annotator-'));
  const budgetPath = join(directory, 'study.sqlite'), ledger = new Ledger(budgetPath, '200');
  ledger.freeze('study:book-annotator', { mode: 'single_annotator', annotatorId: other }); ledger.close();
  try {
    const bundle = fixture();
    bundle.sources.forEach(source => { source.corpus = 'openstax-development'; source.split = 'development'; });
    const manifest = createManifest([bundle], config(), { id: 'pilot-author', mock: false, phase: 'pilot', budgetPath });
    assert.deepEqual(manifest.bookAnnotation, { mode: 'single_annotator', annotatorId: person });
    await assert.rejects(runExperiment({ bundles: [bundle], config: config(), id: 'pilot-author', directory: join(directory, 'run'), budgetPath, mock: false, allowPaid: false, phase: 'pilot' }), /Immutable|immutable/);
    const verified = new Ledger(budgetPath, '200');
    try { assert.equal(verified.attempts().length, 0); assert.deepEqual(verified.get('study:book-annotator'), { mode: 'single_annotator', annotatorId: other }); }
    finally { verified.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('book import and measured runs reject mixed annotators, including across separate frozen projects', () => {
  const original = fixture(); original.freeze.questions[1]!.annotation!.annotatorIds = [other]; rehash(original);
  assert.throws(() => bundleBooks(original.freeze, original.sources), /same single annotator/);
  const first = fixture('first'), second = fixture('second');
  second.freeze.questions.forEach(q => { q.annotation!.annotatorIds = [other]; }); rehash(second);
  assert.doesNotThrow(() => bundleBooks(second.freeze, second.sources));
  assert.throws(() => createManifest([first, second], config(), { id: 'mixed-books', mock: false, phase: 'test' }), /same single annotator/);
  assert.doesNotThrow(() => createManifest([first], config(), { id: 'single-books', mock: false, phase: 'test' }));
});

test('provenance tampering changes the hash and malformed metadata is rejected even after rehashing', () => {
  const original = fixture(); original.freeze.questions[0]!.annotation!.reviewedAt = '2026-10-04T00:00:00.000Z';
  assert.throws(() => validateFreeze(original.freeze), /hash mismatch/);
  for (const annotation of [
    { mode: 'single_annotator', annotatorIds: [person, other], reviewedAt: '2026-10-03' },
    { mode: 'single_annotator', annotatorIds: ['Juan'], reviewedAt: '2026-10-03' },
    { mode: 'single_annotator', annotatorIds: [person], reviewedAt: 'invalid' },
    { mode: 'independent_review', annotatorIds: [person], reviewedAt: '2026-10-03' },
  ]) {
    original.freeze.questions[0]!.annotation = annotation as FrozenQuestion['annotation']; rehash(original);
    assert.throws(() => validateFreeze(original.freeze), /annotation provenance/);
  }
});
