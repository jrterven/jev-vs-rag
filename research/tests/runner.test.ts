import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDataset } from '../fixtures.js';
import { createManifest, loadConfig, runExperiment, makeSchedule } from '../runner.js';
import { Ledger } from '../ledger.js';
import { evaluateExperiment } from '../report.js';
import { annotationExports } from '../annotations.js';
import { hashObject, shuffled, readJson, writeJson } from '../util.js';
import { prepareDocument, textBlocks } from '../datasets.js';
import { Methods } from '../methods.js';
import { METHOD_IDS } from '../types.js';

test('offline seven-method study completes, exports neutral citations, resumes without changes or charges', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-e2e-')), budgetPath = join(directory, 'study.sqlite'), bundles = [mockDataset()], config = loadConfig();
  config.generation.questions = 3; config.timing.questions = 3; config.bootstrapSamples = 100;
  const options = { directory: join(directory, 'run'), budgetPath, bundles, config, id: 'offline-e2e', mock: true, allowPaid: false, phase: 'test' as const };
  try {
    const manifest = await runExperiment(options), ledger = new Ledger(budgetPath, config.maxBudgetUsd);
    const before = ledger.runs(); assert.equal(before.length, 69); assert.ok(before.every(r => r.status === 'completed'));
    for (const run of before.filter(r => METHOD_IDS.includes(r.method as typeof METHOD_IDS[number]))) assert.ok(run.ranking.length > 0);
    assert.equal(ledger.attempts().length, 0);
    const report = await evaluateExperiment(manifest, bundles, ledger); assert.equal(report.kind, 'mock'); assert.equal(report.methods.length, 7); assert.equal(report.missingScheduledRuns, 0);
    assert.ok(report.methods.every(m => m.nTimingRuns === 9 && m.failures === 0));
    const payloads = annotationExports(manifest, bundles, ledger, ['reviewer-one', 'reviewer-two']);
    assert.equal(payloads.reduce((n, p) => n + p.answers.length, 0), 9);
    for (const answer of payloads.flatMap(p => p.answers)) for (const c of answer.citations) assert.match(c.label, /^C[1-9][0-9]*$/);
    const beforeHash = hashObject(before); ledger.close();
    await runExperiment({ ...options, bundles: [mockDataset()] });
    const resumed = new Ledger(budgetPath, config.maxBudgetUsd); assert.equal(hashObject(resumed.runs()), beforeHash); assert.equal(resumed.attempts().length, 0); resumed.close();
    await assert.rejects(runExperiment({ ...options, config: { ...config, jevRetain: 5 } }), /immutable/);
    await assert.rejects(evaluateExperiment({ ...manifest, implementationHash: '0'.repeat(64) }, bundles, resumed), /implementation differs/);
    assert.throws(() => annotationExports({ ...manifest, implementationHash: '0'.repeat(64) }, bundles, resumed, ['reviewer-one', 'reviewer-two']), /implementation differs/);
    const saved = readJson<Record<string, unknown>>(join(options.directory, 'manifest.json'));
    writeJson(join(options.directory, 'manifest.json'), { ...saved, implementationHash: '0'.repeat(64) });
    await assert.rejects(runExperiment(options), /immutable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('pending measured search recovery remains quality-usable but excluded from latency', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-recovery-')), config = loadConfig(), bundles = [mockDataset()], budgetPath = join(directory, 'study.sqlite');
  config.methods = ['bm25']; config.generation.questions = 0; config.timing.questions = 1; config.timing.rounds = 1;
  const manifest = createManifest(bundles, config, { id: 'recovery', mock: true, phase: 'test', budgetPath });
  const setup = new Ledger(budgetPath, config.maxBudgetUsd); setup.startRun(manifest.schedule[0].id, { marker: 'simulated crash after provider stage' }); setup.close();
  try {
    await runExperiment({ directory: join(directory, 'run'), budgetPath, bundles, config, id: 'recovery', mock: true, allowPaid: false, phase: 'test' });
    const ledger = new Ledger(budgetPath, config.maxBudgetUsd), recovered = ledger.runs().find(r => r.id === manifest.schedule[0].id)!;
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.resumed, true); assert.equal(recovered.timingValid, false); ledger.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('inferred structure uses common prefix, stable checkpoint and order ablation submits every chunk', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-structure-')), config = loadConfig(), bundle = mockDataset(), ledger = new Ledger(join(directory, 'study.sqlite'));
  config.methods = ['jev-scan', 'openai-dense']; config.structure = true; config.chunkOrderSeed = 43;
  const methods = new Methods({ config, ledger, experimentId: 'structured', cacheDir: directory, mock: true, allowPaid: false, signal: new AbortController().signal });
  try {
    await methods.initialize(); const doc = await prepareDocument(bundle.freeze.documents[0]), original = doc.chunks.map(c => ({ id: c.id, start: c.start, end: c.end }));
    await methods.prepare(doc); assert.ok(doc.chunks.some(c => c.text.startsWith('Document sections:')));
    assert.deepEqual(doc.chunks.map(c => ({ id: c.id, start: c.start, end: c.end })), original);
    const result = await methods.search('jev-scan', bundle.freeze.questions[0], doc, 'structured:q1', 0);
    assert.deepEqual(result.traces.find(t => t.stage === 'window')!.candidateIds, shuffled(doc.chunks, 43).map(c => c.id));
    assert.ok(ledger.traces('structured:q1').length >= 2);
    const replay = await prepareDocument(bundle.freeze.documents[0]); await methods.prepare(replay); assert.deepEqual(replay.chunks, doc.chunks);
  } finally { methods.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schedule keeps methods adjacent within question and finishes each timing block before the next', () => {
  const config = loadConfig(); config.generation.questions = 0; config.timing.questions = 3;
  const schedule = makeSchedule([mockDataset()], config, 'schedule');
  assert.deepEqual([...new Set(schedule.map(r => r.round))], [0, 1, 2]);
  for (let i = 0; i < schedule.length; i += 7) { const group = schedule.slice(i, i + 7); assert.equal(new Set(group.map(r => r.questionId)).size, 1); assert.equal(new Set(group.map(r => r.method)).size, 7); }
  assert.deepEqual(schedule, makeSchedule([mockDataset()], config, 'schedule'));
});


test('identical Jev payloads at successive levels each incur a call, but same-run recovery does not', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-jev-calls-')), ledger = new Ledger(join(directory, 'study.sqlite')), config = loadConfig(), bundle = mockDataset();
  config.methods = ['jev-scan']; config.jevWindowTokens = 4000;
  const previousKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'unit-test-only';
  const sent: string[] = [];
  const methods = new Methods({ config, ledger, experimentId: 'levels', cacheDir: directory, mock: false, allowPaid: true, signal: new AbortController().signal, fetcher: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)), state = body.state as Array<{ id: string }>;
    sent.push(hashObject(body));
    return Response.json({ model: config.models.jev, usage: { input_tokens: 100, output_tokens: 0 }, answers: { where: { probabilities: Object.fromEntries(state.map(c => [c.id, 1 / state.length])) }, exists: { noul: 0.8 } } });
  }) as typeof fetch });
  try {
    const source = bundle.freeze.documents[0], doc = await prepareDocument({ ...source, blocks: textBlocks(source.id, [{ text: 'star '.repeat(10000) }]) });
    const result = await methods.search('jev-scan', bundle.freeze.questions[0], doc, 'levels:query', 0);
    assert.equal(result.ranking.length, 5, 'a stalled 500-token reduction must preserve five finalists');
    assert.ok(new Set(sent).size < sent.length, 'fixture must repeat an identical group at later levels');
    assert.equal(ledger.attempts().length, result.traces.filter(t => t.stage === 'request').length);
    assert.equal(ledger.attempts().length, sent.length);
    assert.equal(new Set(ledger.attempts().map(a => a.logicalKey)).size, sent.length);
    assert.ok(ledger.attempts().every(a => a.reportedModel === config.models.jev));
    const count = sent.length; await methods.search('jev-scan', bundle.freeze.questions[0], doc, 'levels:query', 0);
    assert.equal(sent.length, count); assert.equal(ledger.attempts().length, count);
    const tooLarge = await prepareDocument({ ...source, blocks: textBlocks(source.id, [{ text: 'star '.repeat(10000) }]) }, 1500, 75);
    await assert.rejects(methods.search('jev-scan', bundle.freeze.questions[0], tooLarge, 'levels:cannot-fit-five', 0), /cinco finalistas/);
  } finally { if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey; methods.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
