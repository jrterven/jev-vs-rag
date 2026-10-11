import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mockDataset } from '../fixtures.js';
import { createManifest, loadConfig } from '../runner.js';
import { implementationSnapshot } from '../implementation.js';
import { evaluateExperiment } from '../report.js';
import { hashObject, readJson, sha256, writeJson } from '../util.js';
import type { PaidAttempt } from '../ledger.js';
import type { QueryRun, ResearchReport } from '../types.js';
import { primaryRetrievalFingerprint, ReadonlyReportLedger, snapshotRetrievalReport } from '../scripts/snapshot-retrieval-report.js';

// Synthetic accounting/guard fixtures only. Never exported as scientific evidence.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-snapshot-test-')), source = join(root, 'source'), backup = join(root, 'backup.sqlite'), output = join(root, 'new-snapshot');
  mkdirSync(source);
  const bundles = [mockDataset()], config = loadConfig();
  config.methods = ['bm25']; config.timing = { questions: 3, rounds: 1 }; config.generation.questions = 2; config.bootstrapSamples = 100;
  const manifest = createManifest(bundles, config, { id: 'snapshot-unit-fixture', mock: false, phase: 'test', budgetPath: join(root, 'live-never-open.sqlite') });
  writeJson(join(source, 'manifest.json'), manifest); writeJson(join(source, 'datasets.json'), bundles); writeJson(join(source, 'source-snapshot.json'), implementationSnapshot());
  writeFileSync(join(source, 'running.lock'), 'test marker: generation still active');
  writeFileSync(join(source, 'report.json'), 'must never read this unfinished report');
  const db = new DatabaseSync(backup);
  db.exec('CREATE TABLE immutable(key TEXT PRIMARY KEY, hash TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE attempts(id TEXT PRIMARY KEY, logical_key TEXT NOT NULL,value TEXT NOT NULL)');
  const freeze = (key: string, value: unknown) => db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value));
  freeze(`experiment:${manifest.id}`, manifest); freeze('budget-limit', { maxBudgetUsd: '200' });
  for (const doc of bundles[0].freeze.documents) freeze(`${manifest.id}:preparation:${doc.id}`, { phases: { localPreparationMs: 1 }, chunks: 1, tokens: 1 });
  const runs: QueryRun[] = manifest.schedule.map(scheduled => ({ ...scheduled, status: 'completed', startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:00:01Z', elapsedMs: 1,
    ranking: [], phases: {}, traces: [], timingValid: !['oracle', 'closed-book'].includes(scheduled.method) }));
  for (const run of runs) db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run));
  const gen = manifest.schedule.find(row => row.generate)!;
  const paid = (id: string, runId: string, operation: string, costUsd: string | null): PaidAttempt => ({ id, runId, operation, logicalKey: id, documentId: gen.documentId,
    method: gen.method, model: 'unit-fixture-only', payloadHash: 'a'.repeat(64), price: { input: '1', output: '0', date: 'fixture', source: 'fixture' },
    status: costUsd === null ? 'pending' : 'completed', reservedUsd: '0.01', costUsd, startedAt: '' });
  const attempts = [paid('pending-generation', gen.id, 'generation', null), paid('foreign-known', 'other-experiment:run', 'generation', '0.2')];
  for (const attempt of attempts) db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, attempt.logicalKey, JSON.stringify(attempt));
  db.close();
  const edit = (callback: (db: DatabaseSync) => void) => { const open = new DatabaseSync(backup); try { callback(open); } finally { open.close(); } };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, source, backup, output, manifest, bundles, runs, gen, edit, cleanup };
}

function fileEvidence(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(path => String(path)).filter(path => statSync(join(root, path)).isFile()).map(path => [path, { sha256: sha256(readFileSync(join(root, path))), mtimeMs: statSync(join(root, path)).mtimeMs }]));
}

test('snapshot is read-only, preserves metadata bytes/global budget, and marks partial generation separately', async () => {
  const f = fixture(), before = fileEvidence(f.root), previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Network must never be called'); }) as typeof fetch;
  try {
    const result = await snapshotRetrievalReport(f.source, f.backup, f.output);
    const report = readJson<ResearchReport>(join(f.output, 'report.json'));
    assert.equal(report.kind, 'measured'); assert.equal(report.experimentId, f.manifest.id);
    assert.equal(report.missingScheduledRuns, 0); assert.equal(result.retrieval.recorded, f.manifest.schedule.length);
    assert.equal(result.generation.pendingApiAttempts, 1); assert.ok(result.generation.pendingEligible > 0);
    assert.deepEqual(report.budget, { knownUsd: '0.2', reservedUsd: '0.01', committedUsd: '0.21', unknownAttempts: 1 });
    assert.equal(report.experimentObservedUsd, '0');
    const stage = readJson<Record<string, unknown>>(join(f.output, 'snapshot-stage.json'));
    assert.equal(stage.ragasEligible, false); assert.equal(stage.stage, 'retrieval-complete-generation-incomplete');
    assert.equal(stage.reportSha256, sha256(readFileSync(join(f.output, 'report.json'))));
    assert.equal(stage.primaryRetrievalSha256, primaryRetrievalFingerprint(report));
    for (const name of ['manifest.json', 'datasets.json', 'source-snapshot.json']) assert.deepEqual(readFileSync(join(f.output, name)), readFileSync(join(f.source, name)));
    assert.deepEqual(readFileSync(join(f.output, 'ledger-snapshot.sqlite')), readFileSync(f.backup));
    const after = fileEvidence(f.root);
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([path]) => !path.startsWith('new-snapshot/'))), before);
    assert.equal(existsSync(f.manifest.budgetPath), false);
    assert.equal(readdirSync(f.root).some(path => path.startsWith('.retrieval-snapshot-')), false);
  } finally { globalThis.fetch = previousFetch; f.cleanup(); }
});

test('missing/control/extra runs and running/interrupted/status or identity drift are rejected without publishing', async () => {
  for (const mode of ['missing', 'control', 'extra-replacing', 'running', 'interrupted', 'sql-status', 'identity']) {
    const f = fixture();
    try {
      f.edit(db => {
        const run = { ...f.runs[0] };
        if (mode === 'missing') db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
        else if (mode === 'control') db.prepare('DELETE FROM runs WHERE id=?').run(f.runs.find(row => row.method === 'oracle')!.id);
        else if (mode === 'extra-replacing') { db.prepare('DELETE FROM runs WHERE id=?').run(run.id); run.id = f.manifest.id + ':extra'; db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run)); }
        else if (mode === 'running' || mode === 'interrupted' || mode === 'sql-status') db.prepare('UPDATE runs SET status=? WHERE id=?').run(mode === 'sql-status' ? 'failed' : mode, run.id);
        else { run.questionId = 'wrong'; db.prepare('UPDATE runs SET value=? WHERE id=?').run(JSON.stringify(run), run.id); }
      });
      const before = fileEvidence(f.root);
      await assert.rejects(snapshotRetrievalReport(f.source, f.backup, f.output), /incomplete|Unexpected|mismatch|frozen schedule/);
      assert.equal(existsSync(f.output), false); assert.deepEqual(fileEvidence(f.root), before);
    } finally { f.cleanup(); }
  }
});

test('pending retrieval is rejected, while a terminal failed retrieval retains its assigned denominator', async () => {
  const pending = fixture();
  try {
    pending.edit(db => { const row = db.prepare('SELECT value FROM attempts WHERE id=?').get('pending-generation')!; const attempt = JSON.parse(String(row.value)); attempt.operation = 'window'; db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(attempt), attempt.id); });
    await assert.rejects(snapshotRetrievalReport(pending.source, pending.backup, pending.output), /pending paid attempt/);
  } finally { pending.cleanup(); }
  const failed = fixture();
  try {
    const target = failed.manifest.schedule.find(row => row.generate && row.id !== failed.gen.id && row.method === 'bm25')!;
    failed.edit(db => { const run = { ...failed.runs.find(row => row.id === target.id)!, status: 'failed', error: 'fixture transport failure', timingValid: false }; db.prepare('UPDATE runs SET status=?,value=? WHERE id=?').run('failed', JSON.stringify(run), run.id); });
    const result = await snapshotRetrievalReport(failed.source, failed.backup, failed.output);
    const report = readJson<ResearchReport>(join(failed.output, 'report.json'));
    assert.equal(result.retrieval.failed, 1); assert.equal(result.generation.unavailableRetrieval, 1);
    assert.equal(report.methods[0].nQueries, 3); assert.equal(report.methods[0].failures, 1);
  } finally { failed.cleanup(); }
});

test('existing directories, symlink aliases, output inside source and non-standalone backups are refused', async () => {
  for (const mode of ['existing', 'symlink', 'source', 'sidecar']) {
    const f = fixture();
    try {
      let output = f.output;
      if (mode === 'existing') mkdirSync(output);
      if (mode === 'symlink') symlinkSync(f.source, output);
      if (mode === 'source') output = join(f.source, 'nested');
      if (mode === 'sidecar') writeFileSync(f.backup + '-wal', 'requires SQLite backup');
      const before = fileEvidence(f.source);
      await assert.rejects(snapshotRetrievalReport(f.source, f.backup, output), /NEW|outside|standalone/);
      assert.deepEqual(fileEvidence(f.source), before);
    } finally { f.cleanup(); }
  }
});

test('frozen config/source/ledger hashes and a fully finished generation pass cannot masquerade as a partial snapshot', async () => {
  for (const mode of ['config', 'source', 'ledger', 'terminal']) {
    const f = fixture();
    try {
      if (mode === 'config') writeJson(join(f.source, 'manifest.json'), { ...f.manifest, configHash: '0'.repeat(64) });
      if (mode === 'source') writeJson(join(f.source, 'source-snapshot.json'), { ...implementationSnapshot(), files: { fake: 'different source' } });
      if (mode === 'ledger') f.edit(db => { db.prepare('UPDATE immutable SET hash=? WHERE key=?').run('0'.repeat(64), `experiment:${f.manifest.id}`); });
      if (mode === 'terminal') f.edit(db => {
        db.prepare('DELETE FROM attempts WHERE id=?').run('pending-generation');
        for (const row of f.manifest.schedule.filter(row => row.generate)) { const value = { generationError: 'fixture terminal error' }; db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(`${row.id}:generation-result`, hashObject(value), JSON.stringify(value)); }
      });
      await assert.rejects(snapshotRetrievalReport(f.source, f.backup, f.output), /hash|snapshot|terminal/);
      assert.equal(existsSync(f.output), false);
    } finally { f.cleanup(); }
  }
});

test('read-only evaluation view cannot write and the primary fingerprint survives final generation/billing changes', async () => {
  const f = fixture();
  try {
    const early = await snapshotRetrievalReport(f.source, f.backup, f.output);
    f.edit(db => {
      const raw = db.prepare('SELECT value FROM attempts WHERE id=?').get('pending-generation')!;
      const attempt = { ...JSON.parse(String(raw.value)), status: 'completed', costUsd: '0.002' };
      db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(attempt), attempt.id);
      for (const row of f.manifest.schedule.filter(row => row.generate)) { const value = { generationError: 'fixture final error' }; db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(`${row.id}:generation-result`, hashObject(value), JSON.stringify(value)); }
    });
    const ledger = new ReadonlyReportLedger(f.backup);
    try {
      assert.throws(() => ledger.db.exec("INSERT INTO immutable VALUES('forbidden','x','{}')"), /read.?only/i);
      assert.equal(typeof ledger.evaluationView().saveRun, 'undefined');
      const final = await evaluateExperiment(f.manifest, f.bundles, ledger.evaluationView());
      assert.equal(primaryRetrievalFingerprint(final), early.primaryRetrievalSha256);
      assert.notEqual(final.generationObservedUsd, '0');
      final.methods[0].coverage = 1;
      assert.notEqual(primaryRetrievalFingerprint(final), early.primaryRetrievalSha256);
    } finally { ledger.close(); }
  } finally { f.cleanup(); }
});
