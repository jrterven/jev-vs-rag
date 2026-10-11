import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Decimal } from 'decimal.js';
import { canonicalText, makeFreeze, prepareDocument, textBlocks, validateFreeze } from '../datasets.js';
import { Methods } from '../methods.js';
import { Ledger } from '../ledger.js';
import { loadConfig, runExperiment } from '../runner.js';
import { evaluateExperiment } from '../report.js';
import { sha256, hashObject } from '../util.js';
import { tokenCount, EngineError } from '../../server/engines/common.js';
import type { DatasetBundle, PreparedDocument, StageTrace } from '../types.js';

/** Artificial text and evidence are only executable test fixtures, never human gold. */
function syntheticDevelopment(): DatasetBundle {
  const projectId = 'SYNTHETIC-offline-development', id = 'SYNTHETIC-long-document';
  const blocks = textBlocks(id, Array.from({ length: 80 }, (_, index) => ({
    text: `SYNTHETIC BLOCK ${index}. ` + 'The neutral training text concerns observations and reproducible measurements. '.repeat(50)
      + (index === 79 ? ' THE_LAST_SENTINEL has code purple.' : ''),
  })));
  const document = { id, projectId, title: 'SYNTHETIC offline stress — not study data', hash: sha256(canonicalText({ blocks })), version: 1, blockCount: blocks.length, sections: [], blocks };
  const last = blocks.at(-1)!;
  const questions = [
    { id: 'SYNTHETIC-positive', documentId: id, question: 'What code belongs to THE_LAST_SENTINEL?', answer: 'purple', evidenceSets: [[{ blockId: last.id, start: last.start, end: last.end, quote: last.text }]], unanswerable: false },
    { id: 'SYNTHETIC-negative', documentId: id, question: 'What is the absent serial number?', answer: '', evidenceSets: [], unanswerable: true },
  ];
  const freeze = makeFreeze(projectId, [document], questions); freeze.createdAt = '2026-10-04T00:00:00.000Z';
  return { schemaVersion: 1, freeze, sources: [{ documentId: id, corpus: 'synthetic-development-stress', split: 'development', url: 'https://example.invalid/synthetic-offline-stress', license: 'CC0 synthetic test text, not study annotations', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', acquiredAt: freeze.createdAt, rawSha256: document.hash, textSha256: document.hash }], provenance: { synthetic: true, technicalOnly: true } };
}

let prepared: Promise<PreparedDocument> | undefined;
const longDocument = () => prepared ??= prepareDocument(syntheticDevelopment().freeze.documents[0]);
const equalSet = (a: string[], b: string[]) => assert.deepEqual([...a].sort(), [...b].sort());
const initialIds = (traces: StageTrace[]) => traces.filter(t => t.stage === 'window' && t.level === 0).flatMap(t => t.candidateIds);

test('long Jev scan covers every source chunk, reduces several levels, bills every simulated call and replays only the same run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-development-jev-')), ledger = new Ledger(join(directory, 'SIMULATED-budget.sqlite'));
  const config = loadConfig(), bundle = syntheticDevelopment(), doc = await longDocument();
  config.methods = ['jev-scan']; config.jevWindowTokens = 12000;
  const previousKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'OFFLINE-TEST-PLACEHOLDER';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network access in offline test.'); };
  let calls = 0, active = 0, maximumActive = 0;
  const weights = new Map(doc.chunks.map((c, i) => [c.id, i + 1]));
  const methods = new Methods({ config, ledger, experimentId: 'SYNTHETIC-calls', cacheDir: directory, mock: false, allowPaid: true, signal: new AbortController().signal,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), state = body.state as Array<{ id: string }>;
      assert.ok(tokenCount(JSON.stringify(body)) <= config.jevWindowTokens);
      assert.ok(state.length <= 255);
      calls++; active++; maximumActive = Math.max(maximumActive, active);
      await delay(15); active--;
      const sum = state.reduce((n, c) => n + weights.get(c.id)!, 0);
      return Response.json({ model: config.models.jev, usage: { input_tokens: 1000, output_tokens: 0 }, answers: { where: { probabilities: Object.fromEntries(state.map(c => [c.id, weights.get(c.id)! / sum])) }, exists: { noul: 0.9 } } });
    } });
  try {
    assert.ok(doc.chunks.length > 100, 'fixture must exercise actual pruning and several windows');
    const start = performance.now();
    const result = await methods.search('jev-scan', bundle.freeze.questions[0], doc, 'SYNTHETIC-calls:q:0', 0);
    const elapsedMs = performance.now() - start;
    assert.equal(maximumActive, 2); assert.equal(active, 0);
    const windows = result.traces.filter(t => t.stage === 'window' && t.level === 0);
    assert.ok(windows.length > 2); assert.ok(result.traces.some(t => t.stage === 'reduction' && t.level! >= 2));
    equalSet(initialIds(result.traces), doc.chunks.map(c => c.id));
    assert.equal(new Set(initialIds(result.traces)).size, doc.chunks.length);
    for (const retained of result.traces.filter(t => t.stage === 'retained')) {
      const next = result.traces.filter(t => ['window', 'reduction'].includes(t.stage) && t.level === retained.level! + 1).flatMap(t => t.candidateIds);
      equalSet(next, retained.retainedIds);
      assert.equal(new Set(next).size, next.length, 'no duplicate candidates between reduction windows');
    }
    assert.deepEqual(result.ranking.map(r => r.chunkId), doc.chunks.slice(-5).reverse().map(c => c.id));
    const final = result.traces.find(t => t.stage === 'final')!;
    assert.deepEqual(result.ranking.map(r => r.chunkId), final.retainedIds);
    assert.ok(result.phases.jevSearchMs <= elapsedMs && elapsedMs - result.phases.jevSearchMs < 100);
    assert.ok(result.phases.jevSearchMs >= Math.max(...ledger.attempts().map(a => a.elapsedMs!)), 'whole-search time includes provider waits');
    assert.equal(ledger.attempts().length, calls); assert.equal(calls, result.traces.filter(t => t.stage === 'request').length);
    assert.equal(new Set(ledger.attempts().map(a => a.logicalKey)).size, calls);
    assert.equal(ledger.totals().knownUsd, new Decimal(calls).mul(1000).mul('0.042').div(1e6).toFixed());
    assert.equal(ledger.totals().unknownAttempts, 0);
    const firstCalls = calls, firstCost = ledger.totals().knownUsd;
    await methods.search('jev-scan', bundle.freeze.questions[0], doc, 'SYNTHETIC-calls:q:0', 0);
    assert.equal(calls, firstCalls); assert.equal(ledger.totals().knownUsd, firstCost);
    config.rates.jevInput = '0.084';
    await methods.search('jev-scan', bundle.freeze.questions[0], doc, 'SYNTHETIC-calls:q:1', 1);
    assert.equal(calls, firstCalls * 2, 'new repetition sends every phase again');
    assert.equal(ledger.totals().knownUsd, new Decimal(firstCost).mul(3).toFixed());
    assert.ok(ledger.attempts().slice(0, firstCalls).every(a => a.price.input === '0.042'), 'historical price snapshots survive rate change');
  } finally { methods.close(); ledger.close(); globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey; rmSync(directory, { recursive: true, force: true }); }
});

test('both rerankers receive the identical frozen 50 candidates and Jev scans only that pool', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-development-candidates-')), ledger = new Ledger(join(directory, 'SIMULATED-budget.sqlite'));
  const config = loadConfig(), bundle = syntheticDevelopment(), doc = await longDocument();
  const methods = new Methods({ config, ledger, experimentId: 'SYNTHETIC-pools', cacheDir: directory, mock: true, allowPaid: false, signal: new AbortController().signal });
  try {
    const outputs = await Promise.all(['hybrid', 'hybrid-bge', 'hybrid-jev'].map(method => methods.search(method as 'hybrid', bundle.freeze.questions[0], doc, `SYNTHETIC-pools:${method}`, 0)));
    const pools = outputs.map(r => r.traces.find(t => t.stage === 'hybrid50')!.retainedIds);
    assert.equal(pools[0].length, 50); assert.ok(doc.chunks.length > pools[0].length);
    assert.deepEqual(pools[0], pools[1]); assert.deepEqual(pools[0], pools[2]);
    equalSet(outputs[1].traces.find(t => t.stage === 'rerank')!.candidateIds, pools[0]);
    equalSet(initialIds(outputs[2].traces), pools[0]);
    for (const result of outputs) { assert.equal(result.ranking.length, 5); assert.equal(new Set(result.ranking.map(r => r.chunkId)).size, 5); assert.ok(result.ranking.every(r => Number.isFinite(r.score) && pools[0].includes(r.chunkId))); }
    assert.equal(ledger.attempts().length, 0, 'mock outputs cannot create reported API consumption');
  } finally { methods.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a long search failure stops new windows, keeps completed and unknown consumption, and never retries transient errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-development-failure-')), ledger = new Ledger(join(directory, 'SIMULATED-budget.sqlite'));
  const config = loadConfig(), doc = await longDocument(), question = syntheticDevelopment().freeze.questions[0]; config.methods = ['jev-scan'];
  const previousKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'OFFLINE-TEST-PLACEHOLDER';
  let calls = 0;
  const methods = new Methods({ config, ledger, experimentId: 'SYNTHETIC-failure', cacheDir: directory, mock: false, allowPaid: true, signal: new AbortController().signal,
    fetcher: async () => { const n = ++calls; await delay(5); if (n === 1) throw new Error('simulated timeout'); return Response.json({ model: config.models.jev, usage: { input_tokens: 7, output_tokens: 0 }, error: { message: 'simulated unavailable' } }, { status: 503 }); } });
  try {
    await assert.rejects(methods.search('jev-scan', question, doc, 'SYNTHETIC-failure:q', 0), (error: unknown) => {
      assert.ok(error instanceof EngineError); assert.equal(error.metrics.chunksCovered, 0); assert.ok(error.metrics.windowsTotal > 2); return true;
    });
    assert.equal(calls, 2, 'only the two already in flight, with no search retry');
    assert.equal(ledger.attempts().length, 2);
    assert.deepEqual(ledger.attempts().map(a => a.status), ['unknown', 'failed']);
    assert.equal(ledger.totals().unknownAttempts, 1);
    assert.equal(ledger.totals().knownUsd, new Decimal(7).mul('0.042').div(1e6).toFixed());
    assert.equal(ledger.totals().reservedUsd, '0.042');
    assert.ok(new Decimal(ledger.totals().committedUsd).gt(ledger.totals().knownUsd));
  } finally { methods.close(); ledger.close(); if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey; rmSync(directory, { recursive: true, force: true }); }
});

test('negative development cases run and generate controls without fabricated positive retrieval metrics; restart keeps runs immutable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-development-negative-')), bundle = syntheticDevelopment(), config = loadConfig();
  config.methods = ['openai-dense', 'jev-scan']; config.timing = { questions: 2, rounds: 2 }; config.generation.questions = 2; config.bootstrapSamples = 100;
  const options = { directory: join(directory, 'run'), budgetPath: join(directory, 'SIMULATED-budget.sqlite'), bundles: [bundle], config, id: 'SYNTHETIC-negative', mock: true, allowPaid: false, phase: 'pilot' as const };
  try {
    validateFreeze(bundle.freeze);
    const manifest = await runExperiment(options);
    const ledger = new Ledger(options.budgetPath), before = hashObject(ledger.runs());
    const report = await evaluateExperiment(manifest, [bundle], ledger);
    const runs = report.perQuery as Array<{ questionId: string; method: string; metrics: unknown; generation?: { abstained: boolean; citations: unknown[] }; timingValid: boolean; elapsedMs: number; phases: Record<string, number> }>;
    assert.equal(report.kind, 'mock'); assert.equal(report.missingScheduledRuns, 0);
    assert.ok(report.methods.every(m => m.nQueries === 2 && m.nAnswerable === 1 && m.nTimingRuns === 4));
    assert.ok(runs.filter(r => r.questionId === 'SYNTHETIC-negative').every(r => r.metrics === null));
    const negativeOracle = runs.find(r => r.questionId === 'SYNTHETIC-negative' && r.method === 'oracle')!;
    assert.deepEqual(negativeOracle.generation?.citations, []); assert.equal(negativeOracle.generation?.abstained, true); assert.equal(negativeOracle.timingValid, false);
    for (const run of runs.filter(r => r.timingValid)) { assert.ok(run.elapsedMs >= 0); assert.ok(Object.values(run.phases).every(ms => Number.isFinite(ms) && ms >= 0)); assert.ok(Object.values(run.phases).reduce((a, b) => a + b, 0) <= run.elapsedMs); }
    assert.equal(ledger.attempts().length, 0); ledger.close();
    await runExperiment(options);
    const restarted = new Ledger(options.budgetPath); assert.equal(hashObject(restarted.runs()), before); assert.equal(restarted.attempts().length, 0); restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
