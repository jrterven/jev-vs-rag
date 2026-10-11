import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildJudgeBridge, JUDGE_MODEL, JUDGE_PRICE, type JudgeRequest } from '../ragas/bridge.js';
import { buildContinuationJudgeBridge, type BridgeOptions } from '../ragas/continuation-bridge.js';
import { ACKNOWLEDGED_ATTEMPT_ID, ACKNOWLEDGED_PAYLOAD_HASH, CONTINUATION_RUN_ID, hashFile, type ContinuationAcknowledgment } from '../ragas/continuation-policy.js';
import { hashObject, sha256 } from '../util.js';
import type { PaidAttempt } from '../ledger.js';

const token = 'b'.repeat(64), runId = CONTINUATION_RUN_ID;
const request = (sampleId = 'missing', metric: JudgeRequest['metric'] = 'faithfulness', ordinal = 1): JudgeRequest => ({ requestId: `ragas:${hashObject([runId, sampleId, metric, ordinal])}`, sampleId, metric, messages: [{ role: 'user', content: 'Pregunta α 📚: evidencia íntegra.' }], schemaName: 'Verdict', schema: { type: 'object', properties: { verdict: { type: 'boolean' } }, required: ['verdict'], additionalProperties: false } });
const response = () => Response.json({ id: 'offline-response', model: JUDGE_MODEL, status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: '{"verdict":true}' }] }] });
const call = (app: ReturnType<typeof buildJudgeBridge>['app'], payload = request()) => app.inject({ method: 'POST', url: '/judge', headers: { authorization: `Bearer ${token}` }, payload });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'judge-continuation-')), directory = join(root, 'bridge'), ledgerPath = join(root, 'ledger.sqlite'), inputPath = join(root, 'input.jsonl'), resultPath = join(root, 'results.jsonl');
  const terminal = Array.from({ length: 1634 }, (_, i) => ({ sampleId: `terminal-${i}`, metric: 'faithfulness', status: i < 1632 ? 'completed' : 'error' }));
  const samples = [...terminal.map(row => ({ id: row.sampleId, metrics: ['faithfulness'] })), { id: 'missing', metrics: ['faithfulness', 'answer_accuracy'] }, { id: 'other', metrics: ['faithfulness'] }, ...Array.from({ length: 1237 }, (_, i) => ({ id: `missing-${i}`, metrics: ['faithfulness'] }))];
  writeFileSync(inputPath, samples.map(x => JSON.stringify(x)).join('\n') + '\n'); writeFileSync(resultPath, terminal.map(x => JSON.stringify(x)).join('\n') + '\n');
  const originalOptions = { runId, directory, ledgerPath, apiKey: 'offline-test-key', token, allowPaid: true, inputHash: hashFile(inputPath), maxEvalUsd: '80', maxOutputTokens: 8192 as const, concurrency: 2, fetcher: async () => response() };
  const original = buildJudgeBridge(originalOptions);
  // A partial metric already has its first subcall; recovery must not call again.
  assert.equal((await call(original.app, request('other'))).statusCode, 200);
  const unknown: PaidAttempt = { id: ACKNOWLEDGED_ATTEMPT_ID, logicalKey: `${runId}:judge:fixture-unknown`, runId: `${runId}:fixture-unknown`, documentId: 'terminal-1632', method: 'ragas-judge', operation: 'ragas_faithfulness', model: JUDGE_MODEL, payloadHash: ACKNOWLEDGED_PAYLOAD_HASH, price: JUDGE_PRICE, reservedUsd: '0.76192', status: 'unknown', costUsd: null, startedAt: '2026-10-05T22:11:00.000Z', finishedAt: '2026-10-05T22:11:01.096Z', elapsedMs: 1096, error: 'fetch failed' };
  const raw = JSON.stringify(unknown); original.ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(unknown.id, unknown.logicalKey, raw);
  const originalConfigBytes = readFileSync(join(directory, 'bridge-config.json'));
  await original.app.close();
  const backup = join(root, 'baseline.sqlite'); copyFileSync(ledgerPath, backup);
  const archive = join(root, 'phase.tar'); writeFileSync(archive, 'offline-fixture-archive');
  const ref = (path: string) => ({ path, sha256: hashFile(path) });
  const ack: ContinuationAcknowledgment = { schemaVersion: 1, kind: 'ragas-judge-continuation', runId, authorization: { literal: 'Si continua con las evaluaciones pendientes', authorizedBy: 'Juan Terven', authorizedAt: '2026-10-05T23:00:00.000Z' }, baseline: { configHash: hashObject(original.config), configFileSha256: sha256(originalConfigBytes), ledgerBackup: ref(backup), phaseArchive: ref(archive), results: { path: resultPath, prefixBytes: readFileSync(resultPath).length, prefixSha256: hashFile(resultPath), terminalRows: 1634 }, input: ref(inputPath) }, allowedUnknown: { attemptId: ACKNOWLEDGED_ATTEMPT_ID, valueSha256: sha256(raw), canonicalHash: hashObject(unknown), payloadHash: ACKNOWLEDGED_PAYLOAD_HASH, reservedUsd: '0.76192' }, sources: { original: ['research/ragas/bridge.ts', 'research/ragas/runtime.py', 'research/ledger.ts', 'research/util.ts', 'server/engines/common.ts', 'server/costs.ts'].map(p => ref(resolve(p))), continuation: ['research/ragas/continuation-bridge.ts', 'research/ragas/continuation-policy.ts'].map(p => ref(resolve(p))) } };
  const acknowledgmentPath = join(root, 'ack.json'); writeFileSync(acknowledgmentPath, JSON.stringify(ack, null, 2) + '\n');
  const options: BridgeOptions = { ...originalOptions, acknowledgmentPath };
  return { root, options, originalOptions, ack, raw, originalConfigBytes, resultPath, writeAck() { writeFileSync(acknowledgmentPath, JSON.stringify(ack, null, 2) + '\n'); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('default bridge still halts unknown; continuation permits only missing deterministic calls with unchanged payload/config/accounting', async () => {
  const s = await setup(); let calls = 0, sent: unknown;
  try {
    const unchanged = buildJudgeBridge(s.originalOptions);
    try { assert.equal((await call(unchanged.app)).json().code, 'usage_unknown'); }
    finally { await unchanged.app.close(); }
    const bridge = buildContinuationJudgeBridge({ ...s.options, fetcher: async (_url, init) => { calls++; sent = JSON.parse(String(init?.body)); return response(); } });
    try {
      assert.equal((await call(bridge.app)).statusCode, 200);
      assert.equal((await call(bridge.app)).statusCode, 200); assert.equal(calls, 1);
      assert.equal((await call(bridge.app, { ...request(), messages: [{ role: 'user', content: 'Changed original payload' }] })).statusCode, 409); assert.equal(calls, 1);
      assert.equal((await call(bridge.app, request('other'))).statusCode, 200); assert.equal(calls, 1, 'old settled subcall replay is free');
      assert.equal((await call(bridge.app, request('missing', 'answer_accuracy', 1))).statusCode, 200);
      assert.equal((await call(bridge.app, request('missing', 'answer_accuracy', 2))).statusCode, 200);
      assert.equal((await call(bridge.app, request('missing', 'answer_accuracy', 3))).statusCode, 409);
      assert.equal((await call(bridge.app, request('terminal-1633'))).statusCode, 409, 'terminal no-attempt error cannot be retried');
      assert.equal((await call(bridge.app, request('terminal-0'))).statusCode, 409);
      assert.equal(calls, 3);
      const oldRecord = JSON.parse(readFileSync(join(s.options.directory, 'requests', `${sha256(request('other').requestId)}.json`), 'utf8'));
      assert.deepEqual(sent, oldRecord.providerBody, 'provider payload stays identical to the original bridge for the same prompt/schema');
      assert.deepEqual((sent as { input: unknown }).input, request().messages);
      assert.deepEqual((sent as { reasoning: unknown }).reasoning, { effort: 'medium' });
      assert.equal(readFileSync(join(s.options.directory, 'bridge-config.json')).equals(s.originalConfigBytes), true);
      assert.equal((bridge.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(ACKNOWLEDGED_ATTEMPT_ID) as { value: string }).value, s.raw);
      assert.equal(bridge.ledger.totals(`${runId}:`).reservedUsd, '0.76192');
      assert.ok(bridge.ledger.get(`ragas:${runId}:continuation`));
      assert.deepEqual(JSON.parse(readFileSync(join(s.options.directory, 'continuation.json'), 'utf8')), bridge.ledger.get(`ragas:${runId}:continuation`));
    } finally { await bridge.app.close(); }
  } finally { s.cleanup(); }
});

test('altered or missing acknowledgment, source, config and shortened result prefix fail closed before provider calls', async () => {
  for (const change of ['authorization', 'unknownHash', 'source', 'prefix', 'config'] as const) {
    const s = await setup();
    try {
      if (change === 'authorization') s.ack.authorization.literal = 'wrong' as never;
      if (change === 'unknownHash') s.ack.allowedUnknown.valueSha256 = '0'.repeat(64);
      if (change === 'source') s.ack.sources.original[0].sha256 = '0'.repeat(64);
      if (change === 'prefix') { const row = readFileSync(s.resultPath).subarray(0, readFileSync(s.resultPath).indexOf(10) + 1); s.ack.baseline.results.prefixBytes = row.length; s.ack.baseline.results.prefixSha256 = sha256(row); s.ack.baseline.results.terminalRows = 1; }
      if (change === 'config') s.options.concurrency = 4;
      s.writeAck(); assert.throws(() => buildContinuationJudgeBridge(s.options), /Continuation guard/);
    } finally { s.cleanup(); }
  }
  const s = await setup(); try { assert.throws(() => buildContinuationJudgeBridge({ ...s.options, acknowledgmentPath: join(s.root, 'absent') }), /ENOENT/); } finally { s.cleanup(); }
});

test('full unknown row is rechecked immediately before every new call; new unknown halts queued work and settled failures never retry', async () => {
  const s = await setup(); let calls = 0;
  const bridge = buildContinuationJudgeBridge({ ...s.options, fetcher: async () => { calls++; throw new Error('simulated offline transport failure'); } });
  try {
    const changed = { ...JSON.parse(s.raw), error: 'changed historical error' };
    bridge.ledger.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(changed), ACKNOWLEDGED_ATTEMPT_ID);
    assert.equal((await call(bridge.app)).json().code, 'usage_unknown'); assert.equal(calls, 0);
    bridge.ledger.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(s.raw, ACKNOWLEDGED_ATTEMPT_ID);
    assert.equal((await call(bridge.app)).statusCode, 502); assert.equal(calls, 1);
    assert.equal((await call(bridge.app)).statusCode, 409); assert.equal(calls, 1);
    assert.equal((await call(bridge.app, request('missing', 'faithfulness', 2))).json().code, 'usage_unknown'); assert.equal(calls, 1);
    assert.equal(bridge.ledger.totals(`${runId}:`).reservedUsd, '1.52384');
  } finally { await bridge.app.close(); s.cleanup(); }
});

test('historical unknown reservation remains inside both scoped80 and global200 budget guards', async () => {
  for (const global of [false, true]) {
    const s = await setup(); let calls = 0;
    const bridge = buildContinuationJudgeBridge({ ...s.options, fetcher: async () => { calls++; return response(); } });
    try {
      const prefix = global ? 'other-study:' : `${runId}:`;
      bridge.ledger.reserve({ logicalKey: prefix + 'reservation', runId: prefix + 'reservation', documentId: 'other', method: 'other', operation: 'other', model: 'other', payloadHash: 'fixture', price: JUDGE_PRICE, reservedUsd: global ? '198.5' : '78.5' });
      assert.equal((await call(bridge.app)).statusCode, 402); assert.equal(calls, 0);
      assert.equal((bridge.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(ACKNOWLEDGED_ATTEMPT_ID) as { value: string }).value, s.raw);
    } finally { await bridge.app.close(); s.cleanup(); }
  }
});

test('a newly unknown in-flight attempt prevents queued calls from reaching the provider at concurrency two', async () => {
  const s = await setup(); let calls = 0;
  let failFirst: (() => void) | undefined, finishSecond: (() => void) | undefined;
  const bridge = buildContinuationJudgeBridge({ ...s.options, fetcher: async () => {
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
