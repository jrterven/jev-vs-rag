import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleBooks, bundleModelGeneratedBooks, canonicalText, freezeHash, makeFreeze, textBlocks, validateFreeze } from '../datasets.js';
import { createManifest, loadConfig, runExperiment } from '../runner.js';
import { Ledger } from '../ledger.js';
import { sha256, writeJson } from '../util.js';
import type { DatasetBundle, FrozenDataset, FrozenQuestion, SourceRecord } from '../types.js';
import type { ModelGeneratedAnnotationProvenance } from '../../annotation/shared/types.js';

function fixture(split: 'development' | 'test' = 'development'): DatasetBundle {
  const projectId = `ai-books-${split}`;
  const documents: FrozenDataset['documents'] = Array.from({ length: split === 'development' ? 2 : 8 }, (_, index) => {
    const id = `${projectId}:${index}`, blocks = textBlocks(id, [{ text: `📚 ${id} has canonical evidence.`, heading: 'First section' }, { text: `${id} has complementary evidence.`, heading: 'Second section' }]);
    return { id, projectId, title: id, hash: sha256(canonicalText({ blocks })), version: 1, blockCount: 2, sections: [{ blockIndex: 0, title: 'First section' }, { blockIndex: 1, title: 'Second section' }], blocks };
  });
  const sourceLockHash = sha256('immutable acquisition lock');
  const questions: FrozenQuestion[] = documents.flatMap(doc => Array.from({ length: 10 }, (_, index) => ({ id: `${doc.id}:q${index}`, documentId: doc.id, question: `Question ${index} about ${doc.id}?`, questionType: index < 4 ? 'factual' : index < 7 ? 'explanatory' : 'multi_section', answer: 'A model-generated reference, not human gold.', evidenceSets: [doc.blocks.slice(0, index < 7 ? 1 : 2).map(block => ({ blockId: block.id, start: block.start, end: block.end, quote: block.text }))], annotation: { mode: 'model_generated', model: 'gpt-6-astra', reasoningEffort: 'ultra', authoringRunId: `author-${split}`, promptHash: sha256('author protocol'), documentHash: doc.hash, sourceLockHash, generatedAt: '2026-10-05T01:00:00.000Z', humanReviewed: false, validation: { mode: 'model_self_check', model: 'gpt-6-astra', reasoningEffort: 'ultra', promptHash: sha256('validation prompt'), reportHash: sha256(`report ${doc.id}`), validatedAt: '2026-10-05T01:01:00.000Z', status: 'passed' } } })));
  const sources: SourceRecord[] = documents.map(doc => ({ documentId: doc.id, corpus: split === 'test' ? 'openstax-books' : 'openstax-development', split, url: `https://example.test/${doc.id}`, license: 'Fixture license', licenseUrl: 'https://example.test/license', acquiredAt: '2026-10-04T00:00:00.000Z', rawSha256: sha256(doc.id), textSha256: doc.hash, sourceLockHash }));
  return { schemaVersion: 1, freeze: makeFreeze(projectId, documents, questions), sources, provenance: {} };
}
const rehash = (bundle: DatasetBundle) => { bundle.freeze.hash = freezeHash(bundle.freeze); };
const importBundle = (bundle: DatasetBundle, split: 'development' | 'test' = 'development') => bundleModelGeneratedBooks(bundle.freeze, bundle.sources, split);
const annotation = (bundle: DatasetBundle) => bundle.freeze.questions[0]!.annotation as ModelGeneratedAnnotationProvenance;
const config = () => { const c = loadConfig(); c.methods = ['bm25']; c.generation.questions = 0; c.timing.questions = 0; return c; };

test('dedicated AI import preserves full hashed provenance and exactly 20 development/80 test questions', () => {
  for (const split of ['development', 'test'] as const) {
    const original = fixture(split), result = importBundle(original, split);
    assert.equal(result.freeze.hash, original.freeze.hash); assert.equal(result.freeze.questions.length, split === 'test' ? 80 : 20);
    assert.equal(result.provenance.annotationMode, 'model_generated'); assert.equal(result.provenance.frozenHumanAnnotations, false); assert.equal(result.provenance.humanReviewed, false);
    assert.deepEqual(result.freeze.questions[0]!.annotation, original.freeze.questions[0]!.annotation);
    assert.throws(() => bundleBooks(result.freeze, result.sources, split), /single-annotator provenance/);
    const manifest = createManifest([result], config(), { id: `ai-${split}`, mock: false, phase: split === 'test' ? 'test' : 'pilot' });
    assert.equal(manifest.bookAnnotation?.mode, 'model_generated'); assert.ok(!JSON.stringify(manifest.bookAnnotation).includes('annotatorId'));
  }
});

test('AI metadata rejects invented human review, absent validation and unrelated document hashes', () => {
  for (const change of [
    (a: any) => { a.humanReviewed = true; },
    (a: any) => { a.annotatorIds = ['a'.repeat(20)]; a.reviewedAt = '2026-10-05T01:01:00.000Z'; },
    (a: any) => { a.validation.status = 'pending'; },
    (a: any) => { a.documentHash = '0'.repeat(64); },
    (a: any) => { a.validation.reportHash = 'unverified'; },
  ]) {
    const bundle = fixture(); change(annotation(bundle)); rehash(bundle);
    assert.throws(() => importBundle(bundle), /model-generated annotation provenance/);
  }
});

test('canonical evidence rejects surrogate splits, codepoint offsets and cross-block spans without truncation', () => {
  const base = fixture(), first = base.freeze.questions[0]!.evidenceSets[0]![0]!;
  assert.equal(first.quote.slice(0, 2), '📚'); assert.doesNotThrow(() => importBundle(base));
  for (const change of [
    (span: any) => { span.end = 1; span.quote = first.quote.slice(0, 1); },
    (span: any) => { span.end--; },
    (span: any, bundle: DatasetBundle) => { const doc = bundle.freeze.documents[0]!; span.end = doc.blocks[1]!.end; span.quote = canonicalText(doc); },
  ]) {
    const bundle = fixture(); change(bundle.freeze.questions[0]!.evidenceSets[0]![0], bundle); rehash(bundle);
    assert.throws(() => importBundle(bundle), /Invalid evidence span/);
  }
});

test('book import enforces split, acquisition lock, category allocation and multi-section evidence', () => {
  const wrongSplit = fixture(); wrongSplit.sources[0]!.split = 'test'; assert.throws(() => importBundle(wrongSplit), /split mismatch/);
  const wrongLock = fixture(); wrongLock.sources[0]!.sourceLockHash = '0'.repeat(64); assert.throws(() => importBundle(wrongLock), /acquisition lock/);
  const wrongCount = fixture(); wrongCount.freeze.questions[0]!.questionType = 'explanatory'; rehash(wrongCount); assert.throws(() => importBundle(wrongCount), /4 factual/);
  const oneSection = fixture(); oneSection.freeze.questions[7]!.evidenceSets[0]!.pop(); rehash(oneSection); assert.throws(() => importBundle(oneSection), /at least two canonical sections/);
  const mixed = fixture(); mixed.freeze.questions[0]!.annotation = { mode: 'single_annotator', annotatorIds: ['a'.repeat(20)], reviewedAt: '2026-10-05T01:01:00.000Z' }; rehash(mixed);
  const originalHuman = structuredClone(mixed.freeze.questions[0]);
  const mixedResult = importBundle(mixed); assert.equal(mixedResult.provenance.annotationMode, 'mixed_human_model');
  assert.deepEqual(mixedResult.freeze.questions[0], originalHuman);
  const manifest = createManifest([mixedResult], config(), { id: 'mixed-ai', mock: false, phase: 'pilot' });
  assert.equal(manifest.bookAnnotation?.mode, 'mixed_human_model');
  if (manifest.bookAnnotation?.mode === 'mixed_human_model') { assert.equal(manifest.bookAnnotation.humanQuestions, 1); assert.equal(manifest.bookAnnotation.modelGeneratedQuestions, 19); }
  delete mixed.freeze.questions[0]!.annotation; rehash(mixed); assert.throws(() => importBundle(mixed), /confirmed personal review/);
  assert.throws(() => createManifest([fixture()], config(), { id: 'wrong-phase', mock: false, phase: 'test' }), /Development and test/);
});

test('provenance mutation changes freeze identity and cannot replace an immutable artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-books-'));
  try {
    const bundle = importBundle(fixture()), path = join(directory, 'books.json'); writeJson(path, bundle, true);
    const originalHash = bundle.freeze.hash; annotation(bundle).validation.reportHash = sha256('changed report');
    assert.throws(() => validateFreeze(bundle.freeze), /hash mismatch/);
    rehash(bundle); assert.notEqual(bundle.freeze.hash, originalHash);
    assert.throws(() => writeJson(path, bundle, true));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('AI authorship protocol has a separate immutable ledger key and rejects changes before any model initializes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-book-ledger-')), budgetPath = join(directory, 'study.sqlite');
  const bundle = importBundle(fixture()), manifest = createManifest([bundle], config(), { id: 'ai-pilot', mock: false, phase: 'pilot', budgetPath });
  const ledger = new Ledger(budgetPath);
  ledger.freeze('study:book-annotator', { mode: 'single_annotator', annotatorId: 'a'.repeat(20) });
  ledger.freeze('study:model-book-authoring', { ...manifest.bookAnnotation, promptHash: sha256('other protocol') }); ledger.close();
  try {
    await assert.rejects(runExperiment({ bundles: [bundle], config: config(), id: 'ai-pilot', directory: join(directory, 'run'), budgetPath, mock: false, allowPaid: false, phase: 'pilot' }), /Immutable/);
    const check = new Ledger(budgetPath);
    try { assert.equal(check.attempts().length, 0); assert.deepEqual(check.get('study:book-annotator'), { mode: 'single_annotator', annotatorId: 'a'.repeat(20) }); }
    finally { check.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
