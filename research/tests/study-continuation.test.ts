import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mockDataset } from '../fixtures.js';
import { prepareDocument } from '../datasets.js';
import { implementationSnapshot } from '../implementation.js';
import { evaluateExperiment } from '../report.js';
import { hashObject, readJson, sha256, writeJson } from '../util.js';
import { createManifest, loadConfig } from '../runner.js';
import { snapshotHaltedReport } from '../scripts/snapshot-halted-report.js';
import { ReadonlyReportLedger } from '../scripts/snapshot-retrieval-report.js';
import type { PaidAttempt } from '../ledger.js';
import type { ExperimentManifest } from '../runner.js';
import type { QueryRun, ResearchReport } from '../types.js';
import { continuationAttempts, continuationOutcomes, verifyStudyContinuation } from '../scripts/verify-study-continuation.js';

// Synthetic operational fixture only; these values are never scientific results.
function fixture() {
  const scheduled = (id: string, method = 'hybrid', generate = false, round = 0) => ({ id: `unit:${id}`, questionId: id, documentId: 'doc', corpus: 'books', method, generate, round, timingSample: true });
  const schedule = [scheduled('base', 'hybrid', true), scheduled('transport', 'jev-scan', true), scheduled('payment', 'jev-scan', false, 1), scheduled('interrupt', 'hybrid', false, 1), scheduled('new', 'hybrid', true, 2), scheduled('oracle', 'oracle', true)];
  const row = (n: number, status = 'completed') => ({ ...schedule[n], status, startedAt: 'old', finishedAt: 'old', elapsedMs: 1, ranking: [], traces: [], phases: {}, resumed: false, timingValid: status === 'completed', metrics: null });
  const before = [row(0), row(1, 'failed'), row(2, 'failed'), row(3, 'interrupted')];
  const after = [...structuredClone(before), row(4), row(5)];
  Object.assign(after[3], { status: 'completed', resumed: true, timingValid: false, startedAt: 'new', finishedAt: 'new', elapsedMs: 2 });
  Object.assign(after[0], { generation: { text: 'response', abstained: false } });
  Object.assign(after[4], { generationError: 'provider failure' });
  Object.assign(after[5], { generationError: 'Oracle control ineligible: unavailable reference' });
  return { manifest: { schedule } as unknown as ExperimentManifest, before: { perQuery: before, missingScheduledRuns: 2 } as unknown as ResearchReport & { perQuery: QueryRun[] },
    after: { perQuery: after, missingScheduledRuns: 0 } as unknown as ResearchReport & { perQuery: QueryRun[] } };
}

function unknown(id = 'prior', runId = 'unit:payment'): PaidAttempt {
  return { id, logicalKey: id, runId, documentId: 'doc', method: 'jev-scan', operation: 'window', model: 'jev-1.13.0', status: 'unknown', costUsd: null,
    reservedUsd: '0.042', price: { input: '0.042', output: '0', date: 'fixture', source: 'fixture' }, error: 'HTTP 402', payloadHash: 'a'.repeat(64), startedAt: '' } as PaidAttempt;
}

test('continuation retains old transport/payment failures, excludes resumed timing and accounts distinct terminal generation outcomes', () => {
  const f = fixture(), result = continuationOutcomes(f.manifest, f.before, f.after);
  assert.equal(result.terminalRetrievalPreserved, 3); assert.deepEqual(result.interruptedRunsResumed, ['unit:interrupt']);
  assert.deepEqual(result.finalRetrieval, { assigned: 6, completed: 4, failed: 2 });
  assert.deepEqual(Object.fromEntries(Object.entries(result.generation).filter(([key]) => key !== 'perRun')), {
    assigned: 4, completed: 1, oracleIneligible: 1, failed: 1, unavailableAfterRetrievalFailure: 1, pending: 0,
  });
  assert.deepEqual(result.timing.find(row => row.method === 'hybrid' && row.round === 1), {
    corpus: 'books', method: 'hybrid', round: 1, assigned: 1, completedValid: 0, failed: 0, completedTimingInvalid: 1, resumed: 1,
    medianMs: null, p95Ms: null, firstStartedAt: 'new', lastFinishedAt: 'new',
    interpretation: 'Descriptive temporal-block audit; valid completed elapsed times only. Planned primary latency still pools valid runs over all three rounds.',
  });
});

test('pending generation cannot be relabeled missing or treated as a completed study', () => {
  const f = fixture(); delete (f.after.perQuery[4] as QueryRun).generationError;
  assert.throws(() => continuationOutcomes(f.manifest, f.before, f.after), /Pending generation/);
});

test('rewritten base/failure records, hidden pending retrieval and valid resumed timing are refused', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[0] as QueryRun).elapsedMs = 999; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[2] as QueryRun).status = 'completed'; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[3] as QueryRun).timingValid = true; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[3] as QueryRun).resumed = false; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[4] as QueryRun).status = 'interrupted'; },
    (f: ReturnType<typeof fixture>) => { f.after.perQuery.pop(); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => continuationOutcomes(f.manifest, f.before, f.after), /changed|invalid timing|explicitly resumed|incomplete|Nonterminal/); }
});

test('generation cannot coexist with failure, appear outside schedule, or use a changed assignment', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[0] as QueryRun).generationError = 'also failed'; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[1] as QueryRun).generationError = 'not called'; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[3] as QueryRun).generationError = 'unscheduled'; },
    (f: ReturnType<typeof fixture>) => { (f.after.perQuery[4] as QueryRun).questionId = 'other'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => continuationOutcomes(f.manifest, f.before, f.after), /Contradictory|unexpectedly|Unscheduled|differs/); }
});

test('all historical unknown attempts and reserves are retained separately from observed spend', () => {
  const f = fixture(), old = [unknown()], next = [unknown(), unknown('new', 'unit:new')];
  const result = continuationAttempts(old, next, f.before.perQuery as QueryRun[], 'unit');
  assert.equal(result.oldGlobalAttemptsPreserved, 1); assert.equal(result.oldUnknownAttemptsPreserved, 1);
  assert.equal(result.unknownAttempts, 2); assert.equal(result.knownObservedUsd, '0'); assert.equal(result.unresolvedReservationUsd, '0.084');
  assert.equal(result.historical402AttemptsPreserved, 1); assert.deepEqual(result.historical402RunIds, ['unit:payment']);
});

test('reconciliation without evidence, erased/reserved charges, pending calls and retrying terminal cases are refused', () => {
  const f = fixture(), old = [unknown()];
  for (const next of [
    [],
    [{ ...unknown(), reservedUsd: '0' }],
    [{ ...unknown(), costUsd: '0', status: 'failed' }],
    [unknown(), { ...unknown('new', 'unit:new'), status: 'pending' }],
    [unknown(), unknown('retry', 'unit:payment')],
    [unknown(), { ...unknown('prep', 'unit:preparation:doc'), operation: 'document_embedding' }],
  ]) assert.throws(() => continuationAttempts(old, next as PaidAttempt[], f.before.perQuery as QueryRun[], 'unit'), /changed|pending|charged again/);
});

test('end-to-end offline guard compares halted quality and SQLite lineage without touching inputs or making calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-continuation-test-')), final = join(root, 'final'), oldBackup = join(root, 'old.sqlite'), finalBackup = join(root, 'final.sqlite'), halted = join(root, 'halted');
  mkdirSync(final);
  const originalFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('No API calls permitted'); }) as typeof fetch;
  try {
    const bundles = [mockDataset()], config = loadConfig(); config.timing = { questions: 3, rounds: 3 }; config.generation.questions = 2; config.bootstrapSamples = 100;
    const manifest = createManifest(bundles, config, { id: 'continue-unit-fixture', mock: false, phase: 'test', budgetPath: join(root, 'live-never-open.sqlite') });
    for (const [name, value] of Object.entries({ manifest, datasets: bundles, 'source-snapshot': implementationSnapshot() })) writeJson(join(final, name + '.json'), value);
    const docs = new Map(await Promise.all(bundles[0].freeze.documents.map(async doc => [doc.id, await prepareDocument(doc)] as const)));
    const base = manifest.schedule.filter(run => run.round === 0 && config.methods.includes(run.method as any));
    const payment = manifest.schedule.find(run => run.round === 1 && run.method === 'jev-scan')!, interrupted = manifest.schedule.find(run => run.round === 1 && run.method === 'hybrid')!;
    const makeRun = (scheduled: typeof manifest.schedule[number]): QueryRun => {
      const ids = docs.get(scheduled.documentId)!.chunks.map(chunk => chunk.id), selected = ids.slice(0, 5);
      return { ...scheduled, status: 'completed', startedAt: 'fixture-old', finishedAt: 'fixture-old', elapsedMs: 1, resumed: false, timingValid: !['oracle', 'closed-book'].includes(scheduled.method),
        ranking: selected.map(chunkId => ({ chunkId, score: 1 })), phases: {}, traces: scheduled.method === 'jev-scan' ? [{ stage: 'window', level: 0, candidateIds: ids, retainedIds: [], payloadHash: 'fixture' }, { stage: 'final', level: 0, candidateIds: ids, retainedIds: selected, payloadHash: 'fixture' }] : [] };
    };
    const oldRuns = [...base, payment, interrupted].map(scheduled => {
      const run = makeRun(scheduled);
      if (run.id === payment.id || run.id === interrupted.id) { run.status = run.id === payment.id ? 'failed' : 'interrupted'; run.timingValid = false; run.ranking = []; }
      return run;
    });
    const db = new DatabaseSync(oldBackup);
    db.exec('CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT,value TEXT);CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,value TEXT);CREATE TABLE attempts(id TEXT PRIMARY KEY,logical_key TEXT,value TEXT)');
    const freeze = (key: string, value: unknown) => db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value));
    freeze(`experiment:${manifest.id}`, manifest);
    for (const [id, doc] of docs) freeze(`${manifest.id}:preparation:${id}`, { phases: {}, chunks: doc.chunks.length, tokens: doc.tokenCount });
    for (const run of oldRuns) db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run));
    const attempt = { ...unknown(), runId: payment.id, documentId: payment.documentId, model: config.models.jev };
    db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, attempt.logicalKey, JSON.stringify(attempt)); db.close();
    await snapshotHaltedReport(final, oldBackup, halted);
    copyFileSync(oldBackup, finalBackup);
    const writable = new DatabaseSync(finalBackup), oldById = new Map(oldRuns.map(run => [run.id, run]));
    for (const scheduled of manifest.schedule) {
      let run = oldById.get(scheduled.id) ?? makeRun(scheduled);
      if (scheduled.id === interrupted.id) run = { ...makeRun(scheduled), resumed: true, timingValid: false, startedAt: 'fixture-resumed' };
      writable.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run));
      if (scheduled.generate && run.status === 'completed') {
        const result = { generation: { text: 'Synthetic guard test response', citations: [], abstained: false, elapsedMs: 1 } };
        writable.prepare('INSERT INTO immutable VALUES(?,?,?)').run(`${run.id}:generation-result`, hashObject(result), JSON.stringify(result));
      }
    }
    writable.close();
    const ledger = new ReadonlyReportLedger(finalBackup);
    try { writeJson(join(final, 'report.json'), await evaluateExperiment(manifest, bundles, ledger.evaluationView())); } finally { ledger.close(); }
    const inputPaths = [oldBackup, finalBackup, join(final, 'report.json'), join(halted, 'report.json'), join(halted, 'ledger-snapshot.sqlite')];
    const hashes = () => inputPaths.map(path => sha256(readFileSync(path)));
    const before = hashes(), output = join(root, 'verified.json');
    const result = await verifyStudyContinuation(halted, final, finalBackup, output);
    assert.equal(result.finalRetrieval.assigned, manifest.schedule.length); assert.equal(result.finalRetrieval.failed, 1);
    assert.equal(result.generation.pending, 0); assert.equal(result.accounting.unresolvedReservationUsd, '0.042');
    const audit = readJson<any>(output); assert.equal(audit.primaryQualityUnchanged, true); assert.equal(audit.allGenerationTerminal, true);
    assert.equal(audit.ragasInputReady, true); assert.equal(audit.judgeLaunchAuthorized, false);
    assert.deepEqual(before, hashes()); assert.equal(existsSync(manifest.budgetPath), false);
    await assert.rejects(verifyStudyContinuation(halted, final, finalBackup, output), /Output must be new/);
    // A different quality result cannot replace the preserved primary fingerprint.
    const corrupt = readJson<ResearchReport>(join(final, 'report.json')); corrupt.methods[0].coverage = .4321; writeJson(join(final, 'report.json'), corrupt);
    await assert.rejects(verifyStudyContinuation(halted, final, finalBackup, join(root, 'refused.json')), /Primary quality\/retention fingerprint/);
    assert.equal(existsSync(join(root, 'refused.json')), false);
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});
