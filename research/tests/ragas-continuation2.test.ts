import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildJudgeBridge, JUDGE_MODEL, JUDGE_PRICE, type JudgeRequest } from '../ragas/bridge.js';
import { buildContinuation2JudgeBridge, type BridgeOptions } from '../ragas/continuation2-bridge.js';
import { ACKNOWLEDGED_UNKNOWNS, CONTINUATION_RUN_ID, hashFile, type Continuation2Acknowledgment } from '../ragas/continuation2-policy.js';
import { hashObject, sha256 } from '../util.js';
import type { PaidAttempt } from '../ledger.js';

const token = 'b'.repeat(64), runId = CONTINUATION_RUN_ID;
const ACKNOWLEDGED_ATTEMPT_ID = ACKNOWLEDGED_UNKNOWNS[0].attemptId, ACKNOWLEDGED_PAYLOAD_HASH = ACKNOWLEDGED_UNKNOWNS[0].payloadHash;
const request = (sampleId = 'missing', metric: JudgeRequest['metric'] = 'faithfulness', ordinal = 1): JudgeRequest => ({ requestId: `ragas:${hashObject([runId, sampleId, metric, ordinal])}`, sampleId, metric, messages: [{ role: 'user', content: 'Pregunta α 📚: evidencia íntegra.' }], schemaName: 'Verdict', schema: { type: 'object', properties: { verdict: { type: 'boolean' } }, required: ['verdict'], additionalProperties: false } });
const response = () => Response.json({ id: 'offline-response', model: JUDGE_MODEL, status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: '{"verdict":true}' }] }] });
const call = (app: ReturnType<typeof buildJudgeBridge>['app'], payload = request()) => app.inject({ method: 'POST', url: '/judge', headers: { authorization: `Bearer ${token}` }, payload });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'judge-continuation-')), directory = join(root, 'bridge'), ledgerPath = join(root, 'ledger.sqlite'), inputPath = join(root, 'input.jsonl'), resultPath = join(root, 'results.jsonl');
  const terminal = Array.from({ length: 2507 }, (_, i) => ({ sampleId: `terminal-${i}`, metric: 'faithfulness', status: i < 2503 ? 'completed' : 'error' }));
  const samples = [...terminal.map(row => ({ id: row.sampleId, metrics: ['faithfulness'] })), { id: 'missing', metrics: ['faithfulness', 'answer_accuracy'] }, { id: 'other', metrics: ['faithfulness'] }, ...Array.from({ length: 364 }, (_, i) => ({ id: `missing-${i}`, metrics: ['faithfulness'] }))];
  writeFileSync(inputPath, samples.map(x => JSON.stringify(x)).join('\n') + '\n'); writeFileSync(resultPath, terminal.map(x => JSON.stringify(x)).join('\n') + '\n');
  const originalOptions = { runId, directory, ledgerPath, apiKey: 'offline-test-key', token, allowPaid: true, inputHash: hashFile(inputPath), maxEvalUsd: '80', maxOutputTokens: 8192 as const, concurrency: 2, fetcher: async () => response() };
  const original = buildJudgeBridge(originalOptions);
  // A partial metric already has its first subcall; recovery must not call again.
  assert.equal((await call(original.app, request('other'))).statusCode, 200);
  const unknown: PaidAttempt = { id: ACKNOWLEDGED_ATTEMPT_ID, logicalKey: `${runId}:judge:fixture-unknown`, runId: `${runId}:fixture-unknown`, documentId: 'terminal-2503', method: 'ragas-judge', operation: 'ragas_faithfulness', model: JUDGE_MODEL, payloadHash: ACKNOWLEDGED_PAYLOAD_HASH, price: JUDGE_PRICE, reservedUsd: '0.76192', status: 'unknown', costUsd: null, startedAt: '2026-10-05T22:11:00.000Z', finishedAt: '2026-10-05T22:11:01.096Z', elapsedMs: 1096, error: 'fetch failed' };
  const raw = JSON.stringify(unknown); original.ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(unknown.id, unknown.logicalKey, raw);
  const second: PaidAttempt = { ...unknown, id: ACKNOWLEDGED_UNKNOWNS[1].attemptId, logicalKey: `${runId}:judge:fixture-unknown2`, runId: `${runId}:fixture-unknown2`, documentId: 'terminal-2505', payloadHash: ACKNOWLEDGED_UNKNOWNS[1].payloadHash, error: 'Unexpected HTML; JSON parse failed', elapsedMs: 35492.768764 };
  const raw2 = JSON.stringify(second); original.ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(second.id, second.logicalKey, raw2);
  const originalConfigBytes = readFileSync(join(directory, 'bridge-config.json'));
  const ref = (path: string) => ({ path, sha256: hashFile(path) });
  const originalSources = ['research/ragas/bridge.ts', 'research/ragas/runtime.py', 'research/ledger.ts', 'research/util.ts', 'server/engines/common.ts', 'server/costs.ts'].map(p => ref(resolve(p)));
  const priorSources = ['research/ragas/continuation-bridge.ts', 'research/ragas/continuation-policy.ts', 'output/study-runbook-20261005/resume-ragas-test.py'].map(p => ref(resolve(p)));
  const allowedUnknowns = [unknown, second].map((attempt, i) => ({ attemptId: attempt.id, valueSha256: sha256(i === 0 ? raw : raw2), canonicalHash: hashObject(attempt), payloadHash: attempt.payloadHash, reservedUsd: '0.76192' as const }));
  const priorAckPath = join(root, 'prior-ack.json'), priorLineagePath = join(directory, 'continuation.json'), priorBudgetPath = join(directory, 'continuation-budget.json');
  const priorAck = { schemaVersion: 1, kind: 'ragas-judge-continuation', runId, baseline: { configHash: hashObject(original.config) }, allowedUnknown: allowedUnknowns[0], sources: { original: originalSources, continuation: priorSources } };
  writeFileSync(priorAckPath, JSON.stringify(priorAck, null, 2) + '\n');
  const priorLineage = { schemaVersion: 1, kind: 'ragas-judge-continuation-lineage', acknowledgment: priorAck, acknowledgmentHash: hashObject(priorAck), acknowledgmentFileHash: hashFile(priorAckPath), originalConfigHash: hashObject(original.config), continuationSourceHash: priorSources[0].sha256, policySourceHash: priorSources[1].sha256 };
  writeFileSync(priorLineagePath, JSON.stringify(priorLineage, null, 2) + '\n'); original.ledger.freeze(`ragas:${runId}:continuation`, priorLineage);
  await original.app.close();
  copyFileSync(join(directory, 'budget.json'), priorBudgetPath);
  const backup = join(root, 'baseline.sqlite'); copyFileSync(ledgerPath, backup);
  const archive = join(root, 'phase.tar'); writeFileSync(archive, 'offline-fixture-archive');
  const ack: Continuation2Acknowledgment = { schemaVersion: 1, kind: 'ragas-judge-continuation2', runId, authorization: { literal: 'ok termina los exprimentos y el paper', authorizedBy: 'Juan Terven', authorizedAt: '2026-10-06T12:48:10.567150+00:00' }, baseline: { configHash: hashObject(original.config), configFileSha256: sha256(originalConfigBytes), ledgerBackup: ref(backup), phaseArchive: ref(archive), results: { path: resultPath, prefixBytes: readFileSync(resultPath).length, prefixSha256: hashFile(resultPath), terminalRows: 2507 }, input: ref(inputPath) }, allowedUnknowns, priorContinuation: { acknowledgment: ref(priorAckPath), lineage: ref(priorLineagePath), lineageHash: hashObject(priorLineage), budget: ref(priorBudgetPath) }, sources: { original: originalSources, priorContinuation: priorSources, continuation: ['research/ragas/continuation2-bridge.ts', 'research/ragas/continuation2-policy.ts', 'output/study-runbook-20261005/resume-ragas-test-second.py'].map(p => ref(resolve(p))) } };
  const acknowledgmentPath = join(root, 'ack2.json'); writeFileSync(acknowledgmentPath, JSON.stringify(ack, null, 2) + '\n');
  const preserved = [priorAckPath, priorLineagePath, priorBudgetPath, join(directory, 'budget.json')].map(path => ({ path, bytes: readFileSync(path) }));
  const options: BridgeOptions = { ...originalOptions, acknowledgmentPath };
  return { root, options, originalOptions, ack, raw, raw2, preserved, originalConfigBytes, resultPath, writeAck() { writeFileSync(acknowledgmentPath, JSON.stringify(ack, null, 2) + '\n'); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('default bridge still halts unknown; second continuation accepts exactly two unknowns and only missing deterministic calls with unchanged payload/config/accounting', async () => {
  const s = await setup(); let calls = 0, sent: unknown;
  try {
    const unchanged = buildJudgeBridge(s.originalOptions);
    try { assert.equal((await call(unchanged.app)).json().code, 'usage_unknown'); }
    finally { await unchanged.app.close(); }
    const bridge = buildContinuation2JudgeBridge({ ...s.options, fetcher: async (_url, init) => { calls++; sent = JSON.parse(String(init?.body)); return response(); } });
    try {
      assert.equal((await call(bridge.app)).statusCode, 200);
      assert.equal((await call(bridge.app)).statusCode, 200); assert.equal(calls, 1);
      assert.equal((await call(bridge.app, { ...request(), messages: [{ role: 'user', content: 'Changed original payload' }] })).statusCode, 409); assert.equal(calls, 1);
      assert.equal((await call(bridge.app, request('other'))).statusCode, 200); assert.equal(calls, 1, 'old settled subcall replay is free');
      assert.equal((await call(bridge.app, request('missing', 'answer_accuracy', 1))).statusCode, 200);
      assert.equal((await call(bridge.app, request('missing', 'answer_accuracy', 2))).statusCode, 200);
      assert.equal((await call(bridge.app, request('missing', 'answer_accuracy', 3))).statusCode, 409);
      for (let i = 2503; i < 2507; i++) assert.equal((await call(bridge.app, request(`terminal-${i}`))).statusCode, 409, 'all four terminal errors, including no-attempt errors, stay terminal');
      assert.equal((await call(bridge.app, request('terminal-0'))).statusCode, 409);
      assert.equal(calls, 3);
      const oldRecord = JSON.parse(readFileSync(join(s.options.directory, 'requests', `${sha256(request('other').requestId)}.json`), 'utf8'));
      assert.deepEqual(sent, oldRecord.providerBody, 'provider payload stays identical to the original bridge for the same prompt/schema');
      assert.deepEqual((sent as { input: unknown }).input, request().messages);
      assert.deepEqual((sent as { reasoning: unknown }).reasoning, { effort: 'medium' });
      assert.equal(readFileSync(join(s.options.directory, 'bridge-config.json')).equals(s.originalConfigBytes), true);
      assert.equal((bridge.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(ACKNOWLEDGED_ATTEMPT_ID) as { value: string }).value, s.raw);
      assert.equal(bridge.ledger.totals(`${runId}:`).reservedUsd, '1.52384');
      assert.equal((bridge.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(ACKNOWLEDGED_UNKNOWNS[1].attemptId) as { value: string }).value, s.raw2);
      for (const file of s.preserved) assert.equal(readFileSync(file.path).equals(file.bytes), true, 'prior lineage/budget bytes are preserved');
      assert.ok(bridge.ledger.get(`ragas:${runId}:continuation2`));
      assert.deepEqual(JSON.parse(readFileSync(join(s.options.directory, 'continuation2.json'), 'utf8')), bridge.ledger.get(`ragas:${runId}:continuation2`));
    } finally { await bridge.app.close(); }
  } finally { s.cleanup(); }
});

test('altered or missing acknowledgment, source, config and shortened result prefix fail closed before provider calls', async () => {
  for (const change of ['authorization', 'unknownHash', 'source', 'prefix', 'config', 'unknownDuplicate', 'priorSource', 'priorLineage'] as const) {
    const s = await setup();
    try {
      if (change === 'authorization') s.ack.authorization.literal = 'wrong' as never;
      if (change === 'unknownHash') s.ack.allowedUnknowns[0].valueSha256 = '0'.repeat(64);
      if (change === 'source') s.ack.sources.original[0].sha256 = '0'.repeat(64);
      if (change === 'prefix') { const row = readFileSync(s.resultPath).subarray(0, readFileSync(s.resultPath).indexOf(10) + 1); s.ack.baseline.results.prefixBytes = row.length; s.ack.baseline.results.prefixSha256 = sha256(row); s.ack.baseline.results.terminalRows = 1; }
      if (change === 'config') s.options.concurrency = 4;
      if (change === 'unknownDuplicate') s.ack.allowedUnknowns[1] = s.ack.allowedUnknowns[0];
      if (change === 'priorSource') s.ack.sources.priorContinuation.pop();
      if (change === 'priorLineage') s.ack.priorContinuation.lineageHash = '0'.repeat(64);
      s.writeAck(); assert.throws(() => buildContinuation2JudgeBridge(s.options), /Continuation2 guard/);
    } finally { s.cleanup(); }
  }
  const s = await setup(); try { assert.throws(() => buildContinuation2JudgeBridge({ ...s.options, acknowledgmentPath: join(s.root, 'absent') }), /ENOENT/); } finally { s.cleanup(); }
});

test('full unknown row is rechecked immediately before every new call; new unknown halts queued work and settled failures never retry', async () => {
  const s = await setup(); let calls = 0;
  const bridge = buildContinuation2JudgeBridge({ ...s.options, fetcher: async () => { calls++; throw new Error('simulated offline transport failure'); } });
  try {
    for (const [i, raw] of [s.raw, s.raw2].entries()) {
      const changed = { ...JSON.parse(raw), error: 'changed historical error' };
      bridge.ledger.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(changed), ACKNOWLEDGED_UNKNOWNS[i].attemptId);
      assert.equal((await call(bridge.app)).json().code, 'usage_unknown'); assert.equal(calls, 0);
      bridge.ledger.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(raw, ACKNOWLEDGED_UNKNOWNS[i].attemptId);
    }
    assert.equal((await call(bridge.app)).statusCode, 502); assert.equal(calls, 1);
    assert.equal((await call(bridge.app)).statusCode, 409); assert.equal(calls, 1);
    assert.equal((await call(bridge.app, request('missing', 'faithfulness', 2))).json().code, 'usage_unknown'); assert.equal(calls, 1);
    assert.equal(bridge.ledger.totals(`${runId}:`).reservedUsd, '2.28576');
  } finally { await bridge.app.close(); s.cleanup(); }
});

test('historical unknown reservation remains inside both scoped80 and global200 budget guards', async () => {
  for (const global of [false, true]) {
    const s = await setup(); let calls = 0;
    const bridge = buildContinuation2JudgeBridge({ ...s.options, fetcher: async () => { calls++; return response(); } });
    try {
      const prefix = global ? 'other-study:' : `${runId}:`;
      bridge.ledger.reserve({ logicalKey: prefix + 'reservation', runId: prefix + 'reservation', documentId: 'other', method: 'other', operation: 'other', model: 'other', payloadHash: 'fixture', price: JUDGE_PRICE, reservedUsd: global ? '198' : '78' });
      assert.equal((await call(bridge.app)).statusCode, 402); assert.equal(calls, 0);
      assert.equal((bridge.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(ACKNOWLEDGED_ATTEMPT_ID) as { value: string }).value, s.raw);
    } finally { await bridge.app.close(); s.cleanup(); }
  }
});

test('a newly unknown in-flight attempt prevents queued calls from reaching the provider at concurrency two', async () => {
  const s = await setup(); let calls = 0;
  let failFirst: (() => void) | undefined, finishSecond: (() => void) | undefined;
  const bridge = buildContinuation2JudgeBridge({ ...s.options, fetcher: async () => {
    calls++;
    if (calls === 1) return new Promise<Response>((_resolve, reject) => { failFirst = () => reject(new Error('offline failure')); });
    if (calls === 2) return new Promise<Response>(resolveResponse => { finishSecond = () => resolveResponse(response()); });
    throw new Error('A queued call incorrectly reached provider');
  } });
  try {
    const first = call(bridge.app, request('missing-0')), second = call(bridge.app, request('missing-1')), queued = call(bridge.app, request('missing-2'));
    const deadline = performance.now() + 2000;
    while (!failFirst || !finishSecond) { assert.ok(performance.now() < deadline); await new Promise(resolveDone => setTimeout(resolveDone, 1)); }
    failFirst(); assert.equal((await first).statusCode, 502);
    const rejected = await queued; assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().code, 'usage_unknown');
    assert.equal(calls, 2); finishSecond(); assert.equal((await second).statusCode, 200);
  } finally { failFirst?.(); finishSecond?.(); await bridge.app.close(); s.cleanup(); }
});

test('prior acknowledgment, sidecar and budget remain bound before every new call', async () => {
  const s = await setup(); let calls = 0;
  const bridge = buildContinuation2JudgeBridge({ ...s.options, fetcher: async () => { calls++; return response(); } });
  try {
    for (const file of s.preserved.slice(0, 3)) {
      writeFileSync(file.path, Buffer.concat([file.bytes, Buffer.from(' ')]));
      assert.equal((await call(bridge.app)).json().code, 'usage_unknown'); assert.equal(calls, 0);
      writeFileSync(file.path, file.bytes);
    }
    const key = `ragas:${runId}:continuation`;
    const row = bridge.ledger.db.prepare('SELECT value,hash FROM immutable WHERE key=?').get(key) as { value: string; hash: string };
    const altered = { ...JSON.parse(row.value), originalConfigHash: '0'.repeat(64) };
    bridge.ledger.db.prepare('UPDATE immutable SET value=?,hash=? WHERE key=?').run(JSON.stringify(altered), hashObject(altered), key);
    assert.equal((await call(bridge.app)).json().code, 'usage_unknown'); assert.equal(calls, 0);
    bridge.ledger.db.prepare('UPDATE immutable SET value=?,hash=? WHERE key=?').run(row.value, row.hash, key);
    assert.equal((await call(bridge.app)).statusCode, 200); assert.equal(calls, 1);
  } finally { await bridge.app.close(); s.cleanup(); }
});
