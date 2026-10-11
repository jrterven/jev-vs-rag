import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planAblations } from '../ablations.js';
import { makeFreeze, textBlocks, validateFreeze } from '../datasets.js';
import { sha256, stableJson } from '../util.js';
import type { DatasetBundle, ResearchConfig } from '../types.js';

function config(): ResearchConfig { return JSON.parse(readFileSync(new URL('../config/protocol.json', import.meta.url), 'utf8')); }
function bundle(corpus: 'qasper-test' | 'openstax-books', positive = 50, negative = 5): DatasetBundle {
  const projectId = corpus, documentId = `${corpus}:document`, text = 'Canonical evidence with an emoji 🔬.';
  const blocks = textBlocks(documentId, [{ text }]);
  const document = { id: documentId, projectId, title: corpus, hash: sha256(text), version: 1, blockCount: 1, sections: [], blocks };
  const questions = Array.from({ length: positive + negative }, (_, index) => ({ id: `${corpus}:q:${String(index).padStart(3, '0')}`, documentId, question: `Question ${index}`, answer: index < positive ? 'Evidence' : '', unanswerable: index >= positive, evidenceSets: index < positive ? [[{ blockId: blocks[0]!.id, start: 0, end: text.length, quote: text }]] : [] }));
  return { schemaVersion: 1, freeze: makeFreeze(projectId, [document], questions), sources: [{ documentId, corpus, split: 'test', url: 'https://example.test/source', license: 'fixture', licenseUrl: 'https://example.test/license', acquiredAt: '2026-10-03T00:00:00.000Z', rawSha256: 'a'.repeat(64), textSha256: document.hash }], provenance: { fixture: true } };
}

test('the planner freezes 40+40 answerable IDs, preserves canonical evidence and does not alter its inputs', () => {
  const bundles = [bundle('qasper-test'), bundle('openstax-books')], base = config(), original = stableJson({ bundles, base });
  const plan = planAblations(bundles, base);
  assert.equal(plan.subsetQuestionIds.length, 80); assert.equal(new Set(plan.subsetQuestionIds).size, 80);
  assert.equal(plan.subsetQuestionIds.filter(id => id.startsWith('qasper-test:')).length, 40);
  assert.equal(plan.subsetQuestionIds.filter(id => id.startsWith('openstax-books:')).length, 40);
  const originals = new Map(bundles.flatMap(bundle => bundle.freeze.questions).map(question => [question.id, question]));
  for (const bundle of plan.bundles) {
    validateFreeze(bundle.freeze);
    for (const question of bundle.freeze.questions) { assert.equal(question.unanswerable, false); assert.deepEqual(question, originals.get(question.id)); }
    assert.equal((bundle.provenance.ablation as {subsetHash: string}).subsetHash, plan.subsetHash);
  }
  assert.equal(stableJson({ bundles, base }), original);
});

test('selection is seeded and invariant to the input bundle ordering', () => {
  const bundles = [bundle('qasper-test', 100), bundle('openstax-books', 100)], base = config();
  const first = planAblations(bundles, base), repeated = planAblations([...bundles].reverse(), base);
  assert.deepEqual(first.subsetQuestionIds, repeated.subsetQuestionIds); assert.equal(first.subsetHash, repeated.subsetHash);
  assert.deepEqual(first, repeated, 'Immutable plans must survive a repeated invocation and reversed input ordering.');
  const changed = planAblations(bundles, { ...base, seed: base.seed + 1 });
  assert.notDeepEqual(first.subsetQuestionIds, changed.subsetQuestionIds); assert.notEqual(first.subsetHash, changed.subsetHash);
});

test('window, retention and order variants change only one factor; structure has a matched two-method control', () => {
  const base = config(); base.jevWindowTokens = 8000; base.jevRetain = 20; base.chunkOrderSeed = 99; base.structure = true;
  const plan = planAblations([bundle('qasper-test'), bundle('openstax-books')], base);
  const baseline = plan.variants.find(variant => variant.factor === 'baseline')!;
  assert.equal(baseline.config.jevWindowTokens, 12000); assert.equal(baseline.config.jevRetain, 10);
  assert.equal(baseline.config.chunkOrderSeed, undefined); assert.equal(baseline.config.structure, false);
  assert.equal(plan.variants.length, 10);
  for (const variant of plan.variants) {
    assert.equal(variant.config.generation.questions, 0); assert.deepEqual(variant.config.timing, { questions: 80, rounds: 1 });
    assert.equal(variant.config.maxBudgetUsd, base.maxBudgetUsd);
    if (['window', 'retention', 'order'].includes(variant.factor)) {
      const key = variant.factor === 'window' ? 'jevWindowTokens' : variant.factor === 'retention' ? 'jevRetain' : 'chunkOrderSeed';
      const changed: Partial<ResearchConfig> = { ...variant.config }, original: Partial<ResearchConfig> = { ...baseline.config };
      delete changed[key]; delete original[key];
      assert.deepEqual(changed, original); assert.equal(variant.referenceId, baseline.id);
    }
  }
  const control = plan.variants.find(variant => variant.id === 'structure-control')!, structure = plan.variants.find(variant => variant.id === 'structure-inferred')!;
  assert.deepEqual(control.config.methods, ['jev-scan', 'openai-dense']); assert.equal(structure.referenceId, control.id);
  assert.deepEqual({ ...control.config, structure: true }, structure.config);
});

test('insufficient positives, development data and duplicate IDs are rejected before any execution', () => {
  assert.throws(() => planAblations([bundle('qasper-test', 39, 30), bundle('openstax-books')], config()), /at least 40/);
  const development = bundle('qasper-test'); development.sources[0]!.split = 'development';
  assert.throws(() => planAblations([development, bundle('openstax-books')], config()), /development/);
  const duplicated = bundle('qasper-test');
  assert.throws(() => planAblations([duplicated, duplicated, bundle('openstax-books')], config()), /Duplicate document/);
});
