import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalText, makeFreeze, QASPER_TEST_SHA, textBlocks } from '../datasets.js';
import { implementationSnapshot } from '../implementation.js';
import { inventoryQasper, numericInventory } from '../scripts/corpus-inventory.js';
import { hashObject, sha256, writeJson } from '../util.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'corpus-inventory-')), bundlePath = join(root, 'bundle.json'), manifestPath = join(root, 'planned.json');
  const blocks = textBlocks('qasper:fixture', [{ text: 'Full paragraph including a Unicode character 🧪.', heading: 'Evidence' }]);
  const doc = { id: 'qasper:fixture', projectId: 'fixture', title: 'Document fixture', hash: sha256(canonicalText({ blocks })), version: 1, blockCount: blocks.length, sections: [], blocks };
  const freeze = makeFreeze('fixture', [doc], [{ id: 'positive', documentId: doc.id, question: 'What is present?', answer: 'A character', evidenceSets: [[{ blockId: blocks[0]!.id, start: 0, end: blocks[0]!.end, quote: blocks[0]!.text }]] }, { id: 'negative', documentId: doc.id, question: 'What is absent?', answer: '', unanswerable: true, evidenceSets: [] }]);
  const bundle = { schemaVersion: 1, freeze, sources: [{ documentId: doc.id, corpus: 'qasper-test', split: 'test', url: 'https://example.test/source', textSha256: doc.hash, rawSha256: QASPER_TEST_SHA }], provenance: {} };
  const config = { chunkTokens: 500, overlapTokens: 75, maxDocumentTokens: 1_000_000 };
  const schedule = Array.from({ length: 3 }, (_, round) => ['bm25', 'jev-scan'].map(method => ({ id: `r${round}-${method}`, questionId: 'positive', documentId: doc.id, corpus: 'qasper-test', method, round, timingSample: true, generate: round === 0 }))).flat();
  const manifest = { id: 'planned', phase: 'test', config, configHash: hashObject(config), implementationHash: implementationSnapshot().hash, datasetHashes: [freeze.hash], datasetHash: hashObject(freeze.hash), schedule };
  writeJson(bundlePath, bundle); writeJson(manifestPath, manifest);
  return { root, bundle, manifest, bundlePath, manifestPath, options: { bundlePaths: [bundlePath], manifestPath }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('inventory counts complete documents and deduplicates timing/generation questions across methods and rounds', async () => {
  const f = fixture();
  try {
    const inventory = await inventoryQasper(f.options), summary = inventory.summaries[0]!, row = inventory.rows[0]!;
    assert.equal(summary.questions, 2); assert.equal(summary.positiveQuestions, 1); assert.equal(summary.negativeQuestions, 1);
    assert.equal(summary.timingQuestions, 1); assert.equal(summary.generationQuestions, 1);
    assert.equal(summary.plannedTimingRuns, 6); assert.equal(summary.plannedGenerationRuns, 2);
    assert.equal(row.canonicalUtf16Length, f.bundle.freeze.documents[0]!.blocks[0]!.text.length);
    assert.ok(row.tokens > 0); assert.equal(row.chunks, 1);
    assert.equal(inventory.inputBundles[0]!.freezeHash, f.bundle.freeze.hash);
    assert.deepEqual(numericInventory([10, 20, 30, 40]), { count: 4, total: 100, min: 10, median: 25, max: 40 });
  } finally { f.cleanup(); }
});

test('inventory rejects source hash changes and altered canonical text', async () => {
  for (const mode of ['source', 'document'] as const) {
    const f = fixture();
    try {
      if (mode === 'source') f.bundle.sources[0]!.rawSha256 = '0'.repeat(64);
      else f.bundle.freeze.documents[0]!.blocks[0]!.text += ' changed';
      writeJson(f.bundlePath, f.bundle);
      await assert.rejects(inventoryQasper(f.options), /source hash mismatch|Frozen dataset hash mismatch/);
    } finally { f.cleanup(); }
  }
});

test('inventory rejects planned questions joined to the wrong document or an absent freeze', async () => {
  for (const mode of ['document', 'freeze'] as const) {
    const f = fixture();
    try {
      if (mode === 'document') f.manifest.schedule[0]!.documentId = 'different';
      else f.manifest.datasetHashes = ['0'.repeat(64)];
      writeJson(f.manifestPath, f.manifest);
      await assert.rejects(inventoryQasper(f.options), /different question\/document|absent from the planned main/);
    } finally { f.cleanup(); }
  }
});
