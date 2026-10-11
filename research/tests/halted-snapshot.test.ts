import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mockDataset } from '../fixtures.js';
import { createManifest, loadConfig } from '../runner.js';
import { implementationSnapshot } from '../implementation.js';
import { prepareDocument } from '../datasets.js';
import { evaluateExperiment } from '../report.js';
import { hashObject, readJson, sha256, writeJson } from '../util.js';
import type { QueryRun, ResearchReport } from '../types.js';
import { ReadonlyReportLedger, snapshotRetrievalReport } from '../scripts/snapshot-retrieval-report.js';
import { qualitySnapshot, snapshotHaltedReport } from '../scripts/snapshot-halted-report.js';

// Synthetic guard/accounting fixture only, never measured scientific evidence.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'halted-snapshot-test-')), source = join(root, 'source'), backup = join(root, 'backup.sqlite'), output = join(root, 'halted');
  mkdirSync(source);
  const bundles = [mockDataset()], config = loadConfig();
  config.timing = { questions: 3, rounds: 3 }; config.generation.questions = 2; config.bootstrapSamples = 100;
  const manifest = createManifest(bundles, config, { id: 'halt-unit-fixture', mock: false, phase: 'test', budgetPath: join(root, 'live-never-open.sqlite') });
  for (const [name, value] of Object.entries({ manifest, datasets: bundles, 'source-snapshot': implementationSnapshot() })) writeJson(join(source, name + '.json'), value);
  const db = new DatabaseSync(backup);
  db.exec('CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT,value TEXT);CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,value TEXT);CREATE TABLE attempts(id TEXT PRIMARY KEY,logical_key TEXT,value TEXT)');
  const freeze = (key: string, value: unknown) => db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value));
  freeze(`experiment:${manifest.id}`, manifest);
  const prepared = new Map(await Promise.all(bundles[0].freeze.documents.map(async doc => [doc.id, await prepareDocument(doc)] as const)));
  for (const [id, doc] of prepared) freeze(`${manifest.id}:preparation:${id}`, { phases: {}, chunks: doc.chunks.length, tokens: doc.tokenCount });
  const base = manifest.schedule.filter(row => row.round === 0 && config.methods.includes(row.method as any));
  const later = manifest.schedule.filter(row => row.round === 1), paid = later.find(row => row.method === 'jev-scan')!, interrupted = later.find(row => row.id !== paid.id)!;
  const runs: QueryRun[] = [...base, paid, interrupted].map(row => {
    const doc = prepared.get(row.documentId)!, ids = doc.chunks.map(chunk => chunk.id), chosen = ids.slice(0, 5);
    return { ...row, status: row.id === paid.id ? 'failed' : row.id === interrupted.id ? 'interrupted' : 'completed', startedAt: '', finishedAt: '', elapsedMs: 1,
      timingValid: row.round === 0, ranking: chosen.map(chunkId => ({ chunkId, score: 1 })), phases: {},
      traces: row.method === 'jev-scan' && row.round === 0 ? [{ stage: 'window', level: 0, candidateIds: ids, retainedIds: [], payloadHash: 'fixture' }, { stage: 'final', level: 0, candidateIds: ids, retainedIds: chosen, payloadHash: 'fixture' }] : [] };
  });
  for (const run of runs) db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run));
  const attempt = { id: 'payment-402', logicalKey: 'payment-402', runId: paid.id, documentId: paid.documentId, method: paid.method, operation: 'window', model: config.models.jev,
    status: 'unknown', costUsd: null, reservedUsd: '0.042', price: { input: '0.042', output: '0', date: 'fixture', source: 'fixture' }, error: 'HTTP 402', payloadHash: 'a'.repeat(64), startedAt: '' };
  db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, attempt.logicalKey, JSON.stringify(attempt)); db.close();
  const edit = (fn: (db: DatabaseSync) => void) => { const open = new DatabaseSync(backup); try { fn(open); } finally { open.close(); } };
  return { root, source, backup, output, manifest, bundles, base, runs, paid, interrupted, edit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const evidence = (directory: string) => Object.fromEntries(readdirSync(directory).filter(name => statSync(join(directory, name)).isFile()).map(name => [name, [sha256(readFileSync(join(directory, name))), statSync(join(directory, name)).mtimeMs]]));

test('halted snapshot keeps all base assignments, interrupted repetitions and unrun controls distinct without writes', async () => {
  const f = await fixture(), before = evidence(f.source), backupBefore = evidence(f.root), fetcher = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('No provider call permitted'); }) as typeof fetch;
  try {
    const result = await snapshotHaltedReport(f.source, f.backup, f.output), report = readJson<ResearchReport>(join(f.output, 'report.json'));
    assert.equal(result.retrievalQualityComplete, true); assert.equal(result.timingComplete, false); assert.equal(result.ragasEligible, false);
    assert.equal(result.primaryBase.recorded, 21); assert.equal(result.primaryBase.remaining, 0); assert.equal(result.laterRetrieval.interrupted, 1);
    assert.equal(result.controls.recorded, 0); assert.equal(result.controls.remaining, 4); assert.equal(result.generation.attempted, 0);
    assert.equal(result.haltEvidence.payment402Attempts, 1); assert.equal(result.accounting.knownObservedUsd, '0'); assert.equal(result.accounting.unresolvedReservationUsd, '0.042');
    assert.equal(report.missingScheduledRuns, f.manifest.schedule.length - f.runs.length); assert.equal((report.perQuery as unknown[]).length, f.runs.length);
    assert.ok(report.methods.every(row => row.nQueries === 3 && row.failures === 0));
    assert.deepEqual(evidence(f.source), before); assert.deepEqual(evidence(f.root), backupBefore); assert.equal(existsSync(f.manifest.budgetPath), false);
    for (const name of ['manifest.json', 'datasets.json', 'source-snapshot.json']) assert.deepEqual(readFileSync(join(f.source, name)), readFileSync(join(f.output, name)));
    const ledger = new ReadonlyReportLedger(f.backup);
    try { assert.deepEqual(report, await evaluateExperiment(f.manifest, f.bundles, ledger.evaluationView())); } finally { ledger.close(); }
    await assert.rejects(snapshotRetrievalReport(f.source, f.backup, join(f.root, 'strict')), /incomplete/);
  } finally { globalThis.fetch = fetcher; f.cleanup(); }
});

test('missing/interrupted base, running, pending, generation, wrong identity and absent HTTP402 evidence are refused', async () => {
  for (const mode of ['base-missing', 'base-interrupted', 'running', 'pending', 'generation-attempt', 'generation-checkpoint', 'identity', 'no402']) {
    const f = await fixture();
    try {
      f.edit(db => {
        if (mode === 'base-missing') db.prepare('DELETE FROM runs WHERE id=?').run(f.base[0].id);
        if (mode === 'base-interrupted' || mode === 'running' || mode === 'identity') { const run = { ...f.runs[0] }; if (mode === 'identity') run.questionId = 'wrong'; else (run as any).status = mode === 'running' ? 'running' : 'interrupted'; db.prepare('UPDATE runs SET status=?,value=? WHERE id=?').run(run.status, JSON.stringify(run), run.id); }
        if (['pending', 'generation-attempt', 'no402'].includes(mode)) { const attempt = JSON.parse(String(db.prepare('SELECT value FROM attempts').get()!.value)); if (mode === 'pending') attempt.status = 'pending'; if (mode === 'generation-attempt') attempt.operation = 'generation'; if (mode === 'no402') attempt.error = 'HTTP 500'; db.prepare('UPDATE attempts SET value=?').run(JSON.stringify(attempt)); }
        if (mode === 'generation-checkpoint') { const value = { generationError: 'not allowed' }; db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(`${f.base[0].id}:generation-result`, hashObject(value), JSON.stringify(value)); }
      });
      await assert.rejects(snapshotHaltedReport(f.source, f.backup, f.output), /incomplete|later retrieval|Running|Pending|Generation|frozen schedule|HTTP 402/);
      assert.equal(existsSync(f.output), false);
    } finally { f.cleanup(); }
  }
});

test('quality fingerprint excludes future timing/billing/completion but detects base or semantic changes', async () => {
  const f = await fixture();
  try {
    const initial = await snapshotHaltedReport(f.source, f.backup, f.output), report = readJson<ResearchReport>(join(f.output, 'report.json'));
    const changed = structuredClone(report);
    changed.missingScheduledRuns = 0; changed.budget = { changed: true };
    for (const method of changed.methods) { method.latencyP50Ms = 999; method.nTimingRuns = 999; method.queryMeanUsd = '10'; method.unknownCostAttempts = 0; }
    assert.equal(hashObject(await qualitySnapshot(changed, f.bundles, f.manifest)), initial.primaryQualitySha256);
    changed.methods[0].coverage = .123456;
    assert.notEqual(hashObject(await qualitySnapshot(changed, f.bundles, f.manifest)), initial.primaryQualitySha256);
    const quality = readJson<any>(join(f.output, 'primary-quality.json'));
    assert.equal(quality.semanticRetentionSummary.length, 4); assert.equal(quality.perQueryBase.length, 21);
    assert.ok(quality.perQueryBase.every((row: any) => row.elapsedMs === undefined && row.round === 0));
  } finally { f.cleanup(); }
});
