import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bindOperationalContinuation } from '../ragas/operational-audit.js';
import { hashObject, sha256 } from '../util.js';
import type { AuditTotals } from '../ragas/audit.js';

const RUN = 'ragas-books-test-20261004-v1', UNKNOWN = '44aaf63e-7983-4dac-99c9-14a5d4a6fe44';
const PAYLOAD = '5deb0544525bd8fb589588dac4d7e502ae7a108c47c4014b4a70d06827bcd5ce';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ragas-operational-audit-')), ledgerPath = join(directory, 'backup.sqlite');
  const db = new DatabaseSync(ledgerPath);
  db.exec('CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT,value TEXT); CREATE TABLE attempts(id TEXT PRIMARY KEY,value TEXT)');
  const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\n'); };
  const freeze = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value));
  const hash = (path: string) => sha256(readFileSync(path));
  const config = { runId: RUN, maxEvalUsd: '80', globalBudgetUsd: '200', concurrency: 2, maxOutputTokens: 8192, retries: 0, stopOnSettledUnknownUsage: true };
  put(join(directory, 'bridge/bridge-config.json'), config);
  const attempt = { id: UNKNOWN, runId: RUN + ':request', status: 'unknown', costUsd: null, reservedUsd: '0.76192', payloadHash: PAYLOAD, error: 'fetch failed' };
  const raw = JSON.stringify(attempt); db.prepare('INSERT INTO attempts VALUES(?,?)').run(UNKNOWN, raw);
  const ack = { schemaVersion: 1, kind: 'ragas-judge-continuation', runId: RUN,
    authorization: { literal: 'Si continua con las evaluaciones pendientes', authorizedBy: 'Juan Terven', authorizedAt: '2026-10-05T23:23:33Z' },
    baseline: { configHash: hashObject(config), configFileSha256: hash(join(directory, 'bridge/bridge-config.json')), ledgerBackup: { sha256: 'a'.repeat(64) } },
    allowedUnknown: { attemptId: UNKNOWN, payloadHash: PAYLOAD, reservedUsd: '0.76192', valueSha256: sha256(raw), canonicalHash: hashObject(attempt) },
    sources: { original: [{ path: 'research/ragas/bridge.ts', sha256: 'b'.repeat(64) }], continuation: [
      { path: 'research/ragas/continuation-bridge.ts', sha256: 'c'.repeat(64) }, { path: 'research/ragas/continuation-policy.ts', sha256: 'd'.repeat(64) }] } };
  const ackPath = join(directory, 'continuation-20261005/acknowledgment.json'); put(ackPath, ack);
  const lineage = { schemaVersion: 1, kind: 'ragas-judge-continuation-lineage', acknowledgment: ack, acknowledgmentHash: hashObject(ack),
    acknowledgmentFileHash: hash(ackPath), originalConfigHash: hashObject(config), continuationSourceHash: 'c'.repeat(64), policySourceHash: 'd'.repeat(64) };
  put(join(directory, 'bridge/continuation.json'), lineage);
  freeze(`ragas:${RUN}:continuation`, lineage); freeze(`ragas:${RUN}:config`, config);
  freeze('budget-limit', { maxBudgetUsd: '200' }); freeze(`budget-scope:${RUN}:`, { runPrefix: RUN + ':', maxBudgetUsd: '80' });
  const phaseTotals: AuditTotals = { attempts: 2, knownUsd: '0.00277', reservedUsd: '0.76192', committedUsd: '0.76469', pendingAttempts: 0, unknownAttempts: 1, missingCostAttempts: 1 };
  const budgetTotals = { knownUsd: phaseTotals.knownUsd, reservedUsd: phaseTotals.reservedUsd, committedUsd: phaseTotals.committedUsd, unknownAttempts: 1 };
  put(join(directory, 'bridge/budget.json'), { runId: RUN, maxEvalUsd: '80', evaluation: { ...budgetTotals, knownUsd: '0', committedUsd: '0.76192' } });
  put(join(directory, 'bridge/continuation-budget.json'), { runId: RUN, maxEvalUsd: '80', evaluation: budgetTotals, global: budgetTotals });
  put(join(directory, 'study.results.jsonl'), { fixture: 'terminal rows are verified by the parent audit' });
  put(join(directory, 'study.results.jsonl.calls.jsonl'), { fixture: 'call trace bytes' });
  const receiptPath = join(directory, 'receipt.json');
  const receipt = { schemaVersion: 1, kind: 'verified-ragas-continuation-lineage', ok: true, preflight: false, runId: RUN,
    ledgerSha256: hash(ledgerPath), baselineLedgerSha256: 'a'.repeat(64),
    resultsSha256: hash(join(directory, 'study.results.jsonl')), callsSha256: hash(join(directory, 'study.results.jsonl.calls.jsonl')),
    lineageSha256: hash(join(directory, 'bridge/continuation.json')), historicalBudgetSha256: hash(join(directory, 'bridge/budget.json')),
    continuationBudgetSha256: hash(join(directory, 'bridge/continuation-budget.json')), acknowledgmentSha256: hash(ackPath),
    originalTerminalMetrics: 1634, expectedMetrics: 2874, terminalMetrics: 1634, newTerminalMetrics: 0, missingMetrics: 1240, allMetricsTerminal: false,
    terminalStatusCounts: { completed: 1632, error: 2 }, newUnknownAttempts: 0,
    sourceHashes: Object.fromEntries([...ack.sources.original, ...ack.sources.continuation].map(row => [row.path, row.sha256])),
    acknowledgedUnknownPreserved: { attemptId: UNKNOWN, rawValueSha256: sha256(raw), reservedUsd: '0.76192', status: 'unknown', costUsd: null } };
  put(receiptPath, receipt);
  const options = () => ({ directory, receiptPath, config, db, ledgerSha256: hash(ledgerPath), phaseTotals, globalTotals: phaseTotals,
    expectedMetrics: 2874, terminalMetrics: 1634, statusCounts: { completed: 1632, error: 2, unscorable: 0 } });
  return { directory, ledgerPath, db, receipt, receiptPath, put, hash, freeze, options, raw, ack, lineage, config,
    refresh() { receipt.ledgerSha256 = hash(ledgerPath); put(receiptPath, receipt); },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('verified operational binding preserves unknown reserve and historical budget without exposing acknowledgment text', () => {
  const f = fixture();
  try {
    const oldBudget = readFileSync(join(f.directory, 'bridge/budget.json')), oldLedger = f.hash(f.ledgerPath);
    const result = bindOperationalContinuation(f.options());
    assert.equal(result.kind, 'verified-ragas-operational-continuation-binding');
    assert.equal(result.newUnknownAttempts, 0); assert.equal(result.missingMetrics, 1240);
    assert.ok('acknowledgedUnknownPreserved' in result);
    assert.equal(result.acknowledgedUnknownPreserved.costUsd, null);
    assert.equal(result.acknowledgedUnknownPreserved.reservedUsd, '0.76192');
    assert.equal(result.receiptSha256, f.hash(f.receiptPath));
    assert.ok(!JSON.stringify(result).includes('Juan Terven'));
    assert.ok(readFileSync(join(f.directory, 'bridge/budget.json')).equals(oldBudget));
    assert.equal(f.hash(f.ledgerPath), oldLedger);
  } finally { f.close(); }
});

function secondFixture() {
  const f = fixture(), id = '5494ddf7-e3a9-4863-9e32-e17d21c9b0d2';
  const payload = '4d0ccea82bdce6dea96dd6d907408129738751a768328f6c3aaa1ca499f554c0';
  const attempt = { id, runId: RUN + ':second-request', status: 'unknown', costUsd: null, reservedUsd: '0.76192', payloadHash: payload, error: 'invalid response JSON' };
  const raw = JSON.stringify(attempt); f.db.prepare('INSERT INTO attempts VALUES(?,?)').run(id, raw);
  const prior = { acknowledgment: { path: 'continuation-20261005/acknowledgment.json', sha256: f.receipt.acknowledgmentSha256 },
    lineage: { path: 'bridge/continuation.json', sha256: f.receipt.lineageSha256 }, lineageHash: hashObject(f.lineage),
    budget: { path: 'bridge/continuation-budget.json', sha256: f.receipt.continuationBudgetSha256 } };
  const baseline = '8b1c36d6f1cba3f305295118eb9324e5278d4b8d6afb4a8c848b238c16e04ac3';
  const ack = { schemaVersion: 1, kind: 'ragas-judge-continuation2', runId: RUN,
    authorization: { literal: 'ok termina los exprimentos y el paper', authorizedBy: 'Juan Terven', authorizedAt: '2026-10-06T12:40:00Z' },
    baseline: { ...f.ack.baseline, ledgerBackup: { sha256: baseline } }, priorContinuation: prior,
    allowedUnknowns: [f.ack.allowedUnknown, { attemptId: id, payloadHash: payload, reservedUsd: '0.76192', valueSha256: sha256(raw), canonicalHash: hashObject(attempt) }],
    sources: { original: f.ack.sources.original, priorContinuation: f.ack.sources.continuation,
      continuation: [{ path: 'research/ragas/continuation2-bridge.ts', sha256: 'e'.repeat(64) }, { path: 'research/ragas/continuation2-policy.ts', sha256: 'f'.repeat(64) }] } };
  const ackPath = join(f.directory, 'continuation2-20261006/acknowledgment.json'); f.put(ackPath, ack);
  const lineage = { schemaVersion: 1, kind: 'ragas-judge-continuation2-lineage', acknowledgment: ack, acknowledgmentHash: hashObject(ack),
    acknowledgmentFileHash: f.hash(ackPath), originalConfigHash: hashObject(f.config), continuationSourceHash: 'e'.repeat(64), policySourceHash: 'f'.repeat(64),
    priorAcknowledgmentHash: hashObject(f.ack), priorAcknowledgmentFileHash: prior.acknowledgment.sha256,
    priorLineageHash: prior.lineageHash, priorLineageFileHash: prior.lineage.sha256, priorBudgetFileHash: prior.budget.sha256 };
  f.put(join(f.directory, 'bridge/continuation2.json'), lineage); f.freeze(`ragas:${RUN}:continuation2`, lineage);
  const phaseTotals: AuditTotals = { attempts: 4, knownUsd: '0.003', reservedUsd: '1.52384', committedUsd: '1.52684', pendingAttempts: 0, unknownAttempts: 2, missingCostAttempts: 2 };
  const budgetTotals = { knownUsd: phaseTotals.knownUsd, reservedUsd: phaseTotals.reservedUsd, committedUsd: phaseTotals.committedUsd, unknownAttempts: 2 };
  f.put(join(f.directory, 'bridge/continuation2-budget.json'), { runId: RUN, maxEvalUsd: '80', evaluation: budgetTotals, global: budgetTotals });
  const receipt = { ...f.receipt, schemaVersion: 2, kind: 'verified-ragas-second-continuation-lineage', baselineLedgerSha256: baseline,
    baselineArchiveSha256: 'b24d153c6b40e30d50b65578ff365f84adf3256a509dbcbbdb7c4b1de5eb93ce', baselineArchiveFilesVerified: 10108, priorOperationFilesPreserved: 10106,
    acknowledgmentSha256: f.hash(ackPath), lineageSha256: f.hash(join(f.directory, 'bridge/continuation2.json')),
    continuationBudgetSha256: f.hash(join(f.directory, 'bridge/continuation2-budget.json')),
    priorAcknowledgmentSha256: prior.acknowledgment.sha256, priorLineageSha256: prior.lineage.sha256,
    priorContinuationBudgetSha256: prior.budget.sha256, priorLineageCanonicalHash: prior.lineageHash,
    originalTerminalMetrics: 2507, terminalMetrics: 2507, missingMetrics: 367, terminalStatusCounts: { completed: 2503, error: 4 },
    sourceHashes: Object.fromEntries(Object.values(ack.sources).flat().map(row => [row.path, row.sha256])),
    acknowledgedUnknownsPreserved: ack.allowedUnknowns.map(u => ({ attemptId: u.attemptId, rawValueSha256: u.valueSha256, canonicalHash: u.canonicalHash,
      payloadHash: u.payloadHash, reservedUsd: '0.76192', status: 'unknown', costUsd: null })) };
  const options = () => ({ ...f.options(), phaseTotals, globalTotals: phaseTotals, terminalMetrics: 2507, statusCounts: { completed: 2503, error: 4, unscorable: 0 } });
  const refresh = () => { receipt.ledgerSha256 = f.hash(f.ledgerPath); f.put(f.receiptPath, receipt); }; refresh();
  return { ...f, receipt, ack, lineage, options, refresh, secondId: id };
}

test('second continuation binds both immutable unknowns and both operational histories without rewriting either', () => {
  const f = secondFixture();
  try {
    const ledger = f.hash(f.ledgerPath), prior = f.hash(join(f.directory, 'bridge/continuation.json'));
    const result = bindOperationalContinuation(f.options());
    assert.equal(result.schemaVersion, 2); assert.equal(result.kind, 'verified-ragas-second-operational-continuation-binding');
    assert.ok('acknowledgedUnknownsPreserved' in result);
    assert.equal(result.acknowledgedUnknownsPreserved.length, 2);
    assert.ok(result.acknowledgedUnknownsPreserved.every(u => u.costUsd === null && u.reservedUsd === '0.76192' && u.status === 'unknown'));
    assert.equal(result.newUnknownAttempts, 0); assert.equal(result.missingMetrics, 367);
    assert.equal(result.priorLineageSha256, prior);
    assert.equal(f.hash(f.ledgerPath), ledger); assert.equal(f.hash(join(f.directory, 'bridge/continuation.json')), prior);
    assert.ok(!JSON.stringify(result).includes('Juan Terven'));
  } finally { f.close(); }
});

test('second continuation rejects stale first receipts and altered chain, baseline or either unknown', () => {
  for (const attack of ['first-receipt', 'baseline', 'archive', 'prior-ack', 'prior-lineage', 'prior-budget', 'prior-freeze', 'first-unknown', 'second-unknown', 'new-unknown', 'status']) {
    const f = secondFixture();
    try {
      if (attack === 'first-receipt') { f.receipt.schemaVersion = 1; f.receipt.kind = 'verified-ragas-continuation-lineage'; }
      if (attack === 'baseline') f.receipt.baselineLedgerSha256 = 'a'.repeat(64);
      if (attack === 'archive') f.receipt.baselineArchiveFilesVerified = 10107;
      if (attack === 'prior-ack') f.receipt.priorAcknowledgmentSha256 = 'a'.repeat(64);
      if (attack === 'prior-lineage') f.receipt.priorLineageCanonicalHash = 'a'.repeat(64);
      if (attack === 'prior-budget') f.receipt.priorContinuationBudgetSha256 = 'a'.repeat(64);
      if (attack === 'prior-freeze') f.db.prepare('DELETE FROM immutable WHERE key=?').run(`ragas:${RUN}:continuation`);
      if (attack.endsWith('-unknown') && attack !== 'new-unknown') {
        const id = attack === 'first-unknown' ? UNKNOWN : f.secondId;
        const row = f.db.prepare('SELECT value FROM attempts WHERE id=?').get(id) as { value: string };
        f.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.value), costUsd: '0' }), id);
      }
      if (attack === 'new-unknown') f.receipt.newUnknownAttempts = 1;
      if (attack === 'status') f.receipt.terminalStatusCounts.error = 3;
      f.refresh();
      assert.throws(() => bindOperationalContinuation(f.options()), /Operational|operational|Acknowledged/);
    } finally { f.close(); }
  }
});

test('stale receipts, preflight evidence and changed artifact hashes fail closed', () => {
  for (const field of ['ledgerSha256', 'resultsSha256', 'callsSha256', 'lineageSha256', 'historicalBudgetSha256', 'continuationBudgetSha256', 'acknowledgmentSha256', 'preflight']) {
    const f = fixture();
    try {
      (f.receipt as Record<string, unknown>)[field] = field === 'preflight' ? true : '0'.repeat(64);
      f.put(f.receiptPath, f.receipt);
      assert.throws(() => bindOperationalContinuation(f.options()), /Operational|operational/);
    } finally { f.close(); }
  }
});

test('altered source lineage or missing immutable continuation cannot activate the budget override', () => {
  for (const target of ['source', 'freeze']) {
    const f = fixture();
    try {
      if (target === 'source') f.receipt.sourceHashes['research/ragas/continuation-policy.ts'] = '0'.repeat(64);
      else f.db.prepare('DELETE FROM immutable WHERE key=?').run(`ragas:${RUN}:continuation`);
      f.refresh();
      assert.throws(() => bindOperationalContinuation(f.options()), /source set|freeze/);
    } finally { f.close(); }
  }
});

test('acknowledged unknown row changes are rejected even when the ledger receipt is refreshed', () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(f.raw), error: 'rewritten history' }), UNKNOWN);
    f.refresh();
    assert.throws(() => bindOperationalContinuation(f.options()), /unknown was changed/);
  } finally { f.close(); }
});

test('current totals, metric denominators and cap violations stay errors', () => {
  const f = fixture();
  try {
    const options = f.options();
    assert.throws(() => bindOperationalContinuation({ ...options, phaseTotals: { ...options.phaseTotals, knownUsd: '0' } }), /current budget/);
    assert.throws(() => bindOperationalContinuation({ ...options, phaseTotals: { ...options.phaseTotals, committedUsd: '81' } }), /cap exceeded/);
    assert.throws(() => bindOperationalContinuation({ ...options, terminalMetrics: 1635 }), /metric accounting/);
    assert.throws(() => bindOperationalContinuation({ ...options, phaseTotals: { ...options.phaseTotals, unknownAttempts: 2 } }), /unknown count/);
  } finally { f.close(); }
});

function cohortFixture() {
  const f = secondFixture(), id = '1467db16-ea6a-4646-ae28-2de7b8a0ff8f';
  const payload='e0e398e1020897fcffb3e3dc930af05b87015382e3164fc88b8139b1c7fba63d';
  const a={id,runId:RUN+':third',status:'unknown',costUsd:null,reservedUsd:'0.76192',payloadHash:payload};
  const raw=JSON.stringify(a);f.db.prepare('INSERT INTO attempts VALUES(?,?)').run(id,raw);
  const prior={acknowledgment:{path:'continuation2-20261006/acknowledgment.json',sha256:f.receipt.acknowledgmentSha256},lineage:{path:'bridge/continuation2.json',sha256:f.receipt.lineageSha256},lineageHash:hashObject(f.lineage),budget:{path:'bridge/continuation2-budget.json',sha256:f.receipt.continuationBudgetSha256}};
  const baseline='c01011e9d126dc117ea4db674cd864d64b65639926ada083c4e81c8e1ca66141';
  const ack={...f.ack,kind:'ragas-judge-cohort',authorization:{literal:'autorizo terminar los 329 missing sample/metric pairs',authorizedBy:'Juan Terven',authorizedAt:'2026-10-06T16:44:14Z'},baseline:{...f.ack.baseline,ledgerBackup:{sha256:baseline}},priorContinuation:prior,allowedUnknowns:[...f.ack.allowedUnknowns,{attemptId:id,payloadHash:payload,reservedUsd:'0.76192',valueSha256:sha256(raw),canonicalHash:hashObject(a)}],sources:{original:f.ack.sources.original,priorContinuation:[...f.ack.sources.priorContinuation,...f.ack.sources.continuation],continuation:[{path:'research/ragas/cohort-bridge.ts',sha256:'1'.repeat(64)},{path:'research/ragas/cohort-policy.ts',sha256:'2'.repeat(64)}]}};
  const ackPath=join(f.directory,'cohort-20261006/acknowledgment.json');f.put(ackPath,ack);
  const lineage={...f.lineage,kind:'ragas-judge-cohort-lineage',acknowledgment:ack,acknowledgmentHash:hashObject(ack),acknowledgmentFileHash:f.hash(ackPath),continuationSourceHash:'1'.repeat(64),policySourceHash:'2'.repeat(64),priorAcknowledgmentHash:hashObject(f.ack),priorAcknowledgmentFileHash:prior.acknowledgment.sha256,priorLineageHash:prior.lineageHash,priorLineageFileHash:prior.lineage.sha256,priorBudgetFileHash:prior.budget.sha256};
  f.put(join(f.directory,'bridge/cohort.json'),lineage);f.freeze(`ragas:${RUN}:cohort`,lineage);
  f.put(join(f.directory,'cohort-20261006/provider-events.jsonl'),{fixture:true});
  const phaseTotals:AuditTotals={attempts:5,knownUsd:'0.003',reservedUsd:'2.28576',committedUsd:'2.28876',pendingAttempts:0,unknownAttempts:3,missingCostAttempts:3};
  const budget={knownUsd:phaseTotals.knownUsd,reservedUsd:phaseTotals.reservedUsd,committedUsd:phaseTotals.committedUsd,unknownAttempts:3};
  f.put(join(f.directory,'bridge/cohort-budget.json'),{runId:RUN,maxEvalUsd:'80',evaluation:budget,global:budget});
  const receipt={...f.receipt,schemaVersion:3,kind:'verified-ragas-cohort-continuation-lineage',baselineLedgerSha256:baseline,baselineArchiveSha256:'f53fbc3575b3e0d2bf1c699b9cbc210bbbb0e068ec614aa62fbdfc138067fb8b',baselineArchiveFilesVerified:10273,priorOperationFilesPreserved:10271,acknowledgmentSha256:f.hash(ackPath),lineageSha256:f.hash(join(f.directory,'bridge/cohort.json')),continuationBudgetSha256:f.hash(join(f.directory,'bridge/cohort-budget.json')),priorAcknowledgmentSha256:prior.acknowledgment.sha256,priorLineageSha256:prior.lineage.sha256,priorContinuationBudgetSha256:prior.budget.sha256,priorLineageCanonicalHash:prior.lineageHash,providerEventsSha256:f.hash(join(f.directory,'cohort-20261006/provider-events.jsonl')),originalTerminalMetrics:2545,terminalMetrics:2545,missingMetrics:329,terminalStatusCounts:{completed:2540,error:5},sourceHashes:Object.fromEntries(Object.values(ack.sources).flat().map(r=>[r.path,r.sha256])),acknowledgedUnknownsPreserved:[ack.allowedUnknowns[0],ack.allowedUnknowns[2],ack.allowedUnknowns[1]].map(u=>({attemptId:u.attemptId,rawValueSha256:u.valueSha256,canonicalHash:u.canonicalHash,payloadHash:u.payloadHash,reservedUsd:'0.76192',status:'unknown',costUsd:null}))};
  const options=()=>({...f.options(),phaseTotals,globalTotals:phaseTotals,terminalMetrics:2545,statusCounts:{completed:2540,error:5,unscorable:0}});
  const refresh=()=>{receipt.ledgerSha256=f.hash(f.ledgerPath);f.put(f.receiptPath,receipt)};refresh();
  return {...f,receipt,options,refresh};
}
test('cohort binding preserves all three unknowns and complete chain; old receipt cannot conceal it',()=>{
 const f=cohortFixture();try{const result=bindOperationalContinuation(f.options());assert.equal(result.schemaVersion,3);assert.equal(result.missingMetrics,329);f.receipt.schemaVersion=2;f.receipt.kind='verified-ragas-second-continuation-lineage';f.refresh();assert.throws(()=>bindOperationalContinuation(f.options()),/Cohort/)}finally{f.close()}
});
test('cohort binding rejects rewritten events, reservations and historical outcomes',()=>{
 for(const target of ['events','reserve','count']){const f=cohortFixture();try{
  if(target==='events')f.receipt.providerEventsSha256='0'.repeat(64);
  if(target==='reserve')f.options().phaseTotals.reservedUsd='0';
  if(target==='count')f.receipt.terminalStatusCounts.error=4;
  f.refresh();assert.throws(()=>bindOperationalContinuation(f.options()));
 }finally{f.close()}}
});
