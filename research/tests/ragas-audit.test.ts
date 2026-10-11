import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditRagas, recomputeJudgeCost } from '../ragas/audit.js';
import { hashObject, sha256 } from '../util.js';
import type { PaidAttempt } from '../ledger.js';

const price = { input: '2', cachedInput: '0.10', cacheWrite: '2.50', output: '10', inputTokenLimit: 272000, date: '2026-10-04', source: 'official historical fixture' };
const usage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 }, output_tokens_details: { reasoning_tokens: 90 } };
function fixture(phaseCount = 1) {
  const root = mkdtempSync(join(tmpdir(), 'ragas-audit-')), ledgerPath = join(root, 'backup.sqlite');
  const db = new DatabaseSync(ledgerPath);
  db.exec('CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT,value TEXT); CREATE TABLE attempts(id TEXT PRIMARY KEY,logical_key TEXT,value TEXT); CREATE TABLE responses(key TEXT PRIMARY KEY,value TEXT)');
  const freeze = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value));
  const save = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\n'); };
  const cases: Array<Record<string, any>> = [];
  for (let index = 0; index < phaseCount; index++) {
    const directory = join(root, `phase-${index}`), runId = `run-${index}`, sampleId = `sample-${index}`, metric = 'faithfulness';
    const sample = { id: sampleId, question: '¿Dónde? 📚', response: 'Aquí.', contexts: ['Aquí.'], reference: 'Aquí.', metrics: [metric], metadata: { cohort: 'offline-fixture' } };
    for (const file of ['all-inputs.jsonl', 'controls.jsonl']) save(join(directory, file), sample);
    for (const [file, content] of [['ragas/bridge.ts', 'historical bridge'], ['ledger.ts', 'historical ledger'], ['ragas/runtime.py', 'historical runtime']]) {
      const path = join(directory, 'source-snapshot', file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    }
    const config = { schemaVersion: 1, kind: 'ragas-judge', runId, model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, serviceTier: 'default', store: false, maxOutputTokens: 8192, maxEvalUsd: '20', globalBudgetUsd: '200', retries: 0, price, cachePolicy: 'implicit', inputHash: sha256(readFileSync(join(directory, 'all-inputs.jsonl'))), bridgeSourceHash: sha256('historical bridge'), ledgerSourceHash: sha256('historical ledger') };
    save(join(directory, 'bridge/bridge-config.json'), config); freeze(`ragas:${runId}:config`, config); freeze(`budget-scope:${runId}:`, { runPrefix: `${runId}:`, maxBudgetUsd: '20' });
    const requestId = `ragas:${sha256(JSON.stringify([runId, sampleId, metric, 1]))}`, key = sha256(requestId), logicalKey = `${runId}:judge:${key}`;
    const request = { requestId, sampleId, metric, messages: [{ role: 'user', content: 'Judge the frozen input 📚' }], schemaName: 'Result', schema: { type: 'object', properties: { statements: { type: 'array', items: { type: 'string' } } }, required: ['statements'], additionalProperties: false } };
    const providerBody = { model: config.model, store: false, service_tier: 'default', reasoning: config.reasoning, max_output_tokens: 8192, prompt_cache_options: { mode: 'implicit' }, input: request.messages, text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } } };
    const record = { requestHash: hashObject(request), payloadHash: hashObject(providerBody), promptHash: hashObject(request.messages), schemaHash: hashObject(request.schema), request, providerBody };
    save(join(directory, `bridge/requests/${key}.json`), record); freeze(`${logicalKey}:input`, record);
    const rawText = '{"statements":[]}', providerResponse = { id: `resp-${index}`, model: config.model, status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: rawText }] }] };
    const attempt: PaidAttempt = { id: `attempt-${index}`, logicalKey, runId: `${runId}:${key}`, documentId: sampleId, method: 'ragas-judge', operation: `ragas_${metric}`, model: config.model, reportedModel: config.model, payloadHash: record.payloadHash, price, reservedUsd: '.76192', status: 'completed', costUsd: '0.00277', inputTokens: 1000, outputTokens: 100, cachedTokens: 200, cacheWriteTokens: 300, usage, responseId: providerResponse.id, responseStatus: 'completed', startedAt: '2026-10-04T12:00:00Z', finishedAt: '2026-10-04T12:00:01Z' };
    db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, logicalKey, JSON.stringify(attempt));
    db.prepare('INSERT INTO responses VALUES(?,?)').run(logicalKey, JSON.stringify({ status: 200, data: providerResponse, attemptId: attempt.id, payloadHash: record.payloadHash }));
    const response = { ok: true, text: rawText, attemptId: attempt.id, model: config.model };
    freeze(`${logicalKey}:result`, response); save(join(directory, `bridge/requests/${key}.response.json`), { ...response, providerResponse, attempt });
    const row = { schemaVersion: 1, sampleId, id: sampleId, metric, status: 'unscorable', score: null, metadata: sample.metadata, calls: [{ requestId, schemaName: 'Result', attemptId: attempt.id, model: config.model, status: 'completed', rawText, response: { statements: [] } }], attemptIds: [attempt.id] };
    save(join(directory, 'controls.results.jsonl'), row);
    save(join(directory, 'controls.results.jsonl.manifest.json'), { runId, judgeModel: config.model, retries: 0, runtimeSha256: sha256('historical runtime'), inputSha256: config.inputHash });
    cases.push({ directory, config, attempt, key, logicalKey, record, row, providerResponse, sample });
  }
  db.close();
  const mutate = (fn: (db: DatabaseSync) => void) => { const connection = new DatabaseSync(ledgerPath); try { fn(connection); } finally { connection.close(); } };
  return { root, ledgerPath, phaseDirectories: cases.map(c => c.directory), cases, save, mutate, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('audit reconciles phases once, keeps unscorable terminal outcomes and never writes the backup', () => {
  const f = fixture(2);
  try {
    const hash = sha256(readFileSync(f.ledgerPath)), files = readdirSync(f.root);
    const report = auditRagas(f);
    assert.deepEqual(report.issues, []); assert.equal(report.ok, true); assert.equal(report.complete, true);
    assert.equal(report.global.knownUsd, '0.00554'); assert.equal(report.judge.knownUsd, '0.00554');
    assert.equal(report.phases[0].statusCounts.unscorable, 1); assert.equal(report.phases[0].totals.knownUsd, '0.00277');
    assert.equal(report.phases[0].attemptAudits[0].recomputedCostUsd, '0.00277');
    assert.equal(sha256(readFileSync(f.ledgerPath)), hash); assert.deepEqual(readdirSync(f.root), files);
    const duplicate = auditRagas({ ledgerPath: f.ledgerPath, phaseDirectories: [...f.phaseDirectories, f.phaseDirectories[0]] });
    assert.ok(duplicate.issues.some(i => i.code === 'duplicate_phase')); assert.equal(duplicate.judge.knownUsd, '0.00554');
  } finally { f.cleanup(); }
});

test('historical rates charge cache writes instead of ordinary input and never double-charge reasoning', () => {
  const f = fixture();
  try {
    const a = f.cases[0].attempt as PaidAttempt;
    assert.equal(recomputeJudgeCost(a), '0.00277');
    assert.equal(recomputeJudgeCost({ ...a, price: { ...a.price, cacheWrite: '5' } }), '0.00352');
    assert.equal(recomputeJudgeCost({ ...a, reportedModel: 'unpriced' }), null);
    assert.equal(recomputeJudgeCost({ ...a, usage: { ...usage, input_tokens_details: { cached_tokens: 200 } } }), null);
    assert.equal(recomputeJudgeCost({ ...a, usage: { ...usage, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 300 } } }), null);
    f.mutate(db => db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify({ ...a, costUsd: '.00337' }), a.id));
    assert.ok(auditRagas(f).issues.some(i => i.code === 'cost_mismatch'));
  } finally { f.cleanup(); }
});

test('provider-body and immutable-config tampering are reported without copying prompt text into audit', () => {
  const f = fixture();
  try {
    const c = f.cases[0], secretLike = 'PRIVATE-TAMPERED-PROMPT';
    f.save(join(c.directory, `bridge/requests/${c.key}.json`), { ...c.record, providerBody: { ...c.record.providerBody, input: [{ role: 'user', content: secretLike }] } });
    f.mutate(db => db.prepare('UPDATE immutable SET hash=? WHERE key=?').run('0'.repeat(64), `ragas:${c.config.runId}:config`));
    const report = auditRagas(f);
    assert.equal(report.ok, false); assert.ok(report.issues.some(i => i.code === 'request_hash_mismatch'));
    assert.ok(report.issues.some(i => i.code === 'attempt_payload_hash_mismatch'));
    assert.ok(report.issues.some(i => i.code === 'immutable_hash_mismatch'));
    assert.ok(!JSON.stringify(report).includes(secretLike));
  } finally { f.cleanup(); }
});

test('reusing one paid attempt across terminal metrics is detected and not charged twice', () => {
  const f = fixture();
  try {
    const c = f.cases[0], second = { ...c.row, metric: 'factual_correctness' };
    writeFileSync(join(c.directory, 'controls.results.jsonl'), [c.row, second].map(row => JSON.stringify(row)).join('\n') + '\n');
    const report = auditRagas(f);
    assert.ok(report.issues.some(i => i.code === 'attempt_reused_by_terminal_calls'));
    assert.equal(report.judge.attempts, 1); assert.equal(report.judge.knownUsd, '0.00277');
  } finally { f.cleanup(); }
});

test('unknown and pending consumption remains reserved and incomplete, not zero expenditure', () => {
  const f = fixture();
  try {
    const c = f.cases[0];
    f.mutate(db => {
      for (const status of ['unknown', 'pending']) {
        const a = { ...c.attempt, id: status, logicalKey: `${c.logicalKey}-${status}`, runId: `${c.config.runId}:${status}`, costUsd: null, status, usage: undefined, reportedModel: undefined };
        db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(a.id, a.logicalKey, JSON.stringify(a));
      }
    });
    const report = auditRagas(f);
    assert.equal(report.complete, false); assert.equal(report.judge.pendingAttempts, 1); assert.equal(report.judge.unknownAttempts, 1);
    assert.equal(report.judge.reservedUsd, '1.52384'); assert.equal(report.judge.committedUsd, '1.52661');
    assert.equal(report.judge.knownUsd, '0.00277'); assert.ok(report.issues.some(i => i.code === 'paid_attempt_not_in_terminal_results'));
  } finally { f.cleanup(); }
});

test('historical tariff must match frozen phase configuration even when the altered amount is self-consistent', () => {
  const f = fixture();
  try {
    const c = f.cases[0], a = { ...c.attempt, price: { ...price, cacheWrite: '5' }, costUsd: '0.00352' };
    f.mutate(db => db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(a), a.id));
    assert.ok(auditRagas(f).issues.some(i => i.code === 'attempt_config_mismatch'));
  } finally { f.cleanup(); }
});

test('an operational lineage sidecar requires an explicit verified receipt', () => {
  const f = fixture();
  try {
    f.save(join(f.cases[0].directory, 'bridge/continuation.json'), {});
    const report = auditRagas(f);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(i => i.code === 'operational_continuation_required'));
    assert.equal(report.operationalContinuation, undefined);
  } finally { f.cleanup(); }
});

test('a supplied invalid operational receipt cannot suppress unrelated audit errors', () => {
  const f = fixture();
  try {
    const c = f.cases[0], receiptPath = join(f.root, 'receipt.json');
    f.save(join(c.directory, 'bridge/continuation.json'), {});
    f.save(receiptPath, { ok: true, preflight: false });
    f.mutate(db => db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify({ ...c.attempt, costUsd: '0.01' }), c.attempt.id));
    const report = auditRagas({ ...f, operationalContinuationPath: receiptPath });
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(i => i.code === 'operational_continuation_invalid'));
    assert.ok(report.issues.some(i => i.code === 'operational_continuation_not_bound'));
    assert.ok(report.issues.some(i => i.code === 'cost_mismatch'));
    assert.equal(report.operationalContinuation, undefined);
  } finally { f.cleanup(); }
});
