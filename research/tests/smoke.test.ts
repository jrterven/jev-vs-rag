import test from 'node:test';
import assert from 'node:assert/strict';
import { importQasperRaw, type RawQasperDocument, validateFreeze } from '../datasets.js';
import { prepareDevelopmentSmoke } from '../smoke.js';
import { loadConfig, makeSchedule } from '../runner.js';
import { hashObject } from '../util.js';
import { METHOD_IDS } from '../types.js';

function fixture(count = 5) {
  const papers: Record<string, RawQasperDocument> = {};
  for (let i = 0; i < count; i++) papers[`unit-test-${i}`] = { title: `Test paper ${i}`, abstract: 'Test abstract.', full_text: [{ section_name: 'Methods', paragraphs: [`Full evidence paragraph ${i}.`, 'Source text. '.repeat(100)] }], qas: [0, 1].map(j => ({ question_id: `question-${i}-${j}`, question: 'What was observed?', answers: [{ worker_id: 'test-annotator', annotation_id: `${i}-${j}`, answer: { unanswerable: false, evidence: [`Full evidence paragraph ${i}.`], extractive_spans: [], free_form_answer: 'Test answer', yes_no: null } }] })) };
  return importQasperRaw(papers, { split: 'development', positiveCount: count * 2, rawSha256: 'unit-test-only' });
}

test('technical smoke freezes three complete distinct development documents and all seven methods', async () => {
  const source = fixture(), base = loadConfig(), before = hashObject(source);
  const first = await prepareDevelopmentSmoke(source, base, { python: '/remote/venv/bin/python' });
  const repeated = await prepareDevelopmentSmoke(source, base, { python: '/remote/venv/bin/python' });
  assert.deepEqual(first, repeated); validateFreeze(first.bundle.freeze);
  assert.equal(hashObject(source), before); assert.equal(first.bundle.freeze.questions.length, 3); assert.equal(first.bundle.freeze.documents.length, 3);
  for (const doc of first.bundle.freeze.documents) assert.deepEqual(doc, source.freeze.documents.find(d => d.id === doc.id));
  assert.deepEqual(first.config.methods, METHOD_IDS); assert.equal(first.config.local.device, 'cuda'); assert.equal(first.config.local.precision, 'fp32');
  for (const key of ['chunkTokens', 'overlapTokens', 'topK', 'hybridDepth', 'rrfK', 'jevWindowTokens', 'jevRetain', 'concurrency', 'requestTimeoutMs', 'maxBudgetUsd', 'models', 'rates'] as const) assert.deepEqual(first.config[key], base[key]);
  const schedule = makeSchedule([first.bundle], first.config, 'smoke', 'pilot');
  assert.equal(schedule.length, 63); assert.ok(schedule.every(row => row.timingSample && !row.generate));
  assert.equal(first.selection.sourceDatasetHash, source.freeze.hash); assert.equal(first.selection.paidCallsMade, false);
});

test('technical smoke refuses test sources, mocks and insufficient documents', async () => {
  const source = fixture(), base = loadConfig();
  await assert.rejects(prepareDevelopmentSmoke({ ...source, sources: source.sources.map(s => ({ ...s, split: 'test' })) }, base, { python: 'python3' }), /development/);
  await assert.rejects(prepareDevelopmentSmoke({ ...source, provenance: { ...source.provenance, mock: true } }, base, { python: 'python3' }), /real QASPER/);
  await assert.rejects(prepareDevelopmentSmoke(source, base, { python: '' }), /Python/);
  await assert.rejects(prepareDevelopmentSmoke(source, base, { python: 'python3', questions: 2 }), /3–5/);
  await assert.rejects(prepareDevelopmentSmoke(fixture(2), base, { python: 'python3' }), /distinct development documents/);
});
