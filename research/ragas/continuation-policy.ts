/** One explicitly authorized continuation; never reconciles or discounts unknown usage. */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ledger, PaidAttempt } from '../ledger.js';
import { hashObject, sha256 } from '../util.js';
import type { JudgeRequest } from './bridge.js';

export const CONTINUATION_RUN_ID = 'ragas-books-test-20261004-v1';
export const ACKNOWLEDGED_ATTEMPT_ID = '44aaf63e-7983-4dac-99c9-14a5d4a6fe44';
export const ACKNOWLEDGED_PAYLOAD_HASH = '5deb0544525bd8fb589588dac4d7e502ae7a108c47c4014b4a70d06827bcd5ce';
export interface FileReference { path: string; sha256: string; }
export interface ContinuationAcknowledgment {
  schemaVersion: 1; kind: 'ragas-judge-continuation'; runId: typeof CONTINUATION_RUN_ID;
  authorization: { literal: 'Si continua con las evaluaciones pendientes'; authorizedBy: 'Juan Terven'; authorizedAt: string };
  baseline: { configHash: string; configFileSha256: string; ledgerBackup: FileReference; phaseArchive: FileReference;
    results: { path: string; prefixBytes: number; prefixSha256: string; terminalRows: number }; input: FileReference };
  allowedUnknown: { attemptId: typeof ACKNOWLEDGED_ATTEMPT_ID; valueSha256: string; canonicalHash: string; payloadHash: typeof ACKNOWLEDGED_PAYLOAD_HASH; reservedUsd: '0.76192' };
  sources: { original: FileReference[]; continuation: FileReference[] };
}
function requireCondition(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Continuation guard: ${message}`); }
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pair = (sampleId: string, metric: string) => JSON.stringify([sampleId, metric]);
export function hashFile(path: string, prefixBytes?: number): string {
  const fd = openSync(resolve(path), 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try { while (prefixBytes === undefined || total < prefixBytes) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, prefixBytes === undefined ? buffer.length : prefixBytes - total), null); if (!n) break; digest.update(buffer.subarray(0, n)); total += n; } }
  finally { closeSync(fd); }
  requireCondition(prefixBytes === undefined || total === prefixBytes, 'file prefix is shorter than the acknowledged prefix');
  return digest.digest('hex');
}
function verifyFile(file: FileReference) {
  requireCondition(file && typeof file.path === 'string' && hash(file.sha256), 'invalid file reference');
  requireCondition(hashFile(file.path) === file.sha256, 'frozen file hash mismatch');
}
export function loadAcknowledgment(path: string): ContinuationAcknowledgment {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8')) as ContinuationAcknowledgment;
  requireCondition(value?.schemaVersion === 1 && value.kind === 'ragas-judge-continuation' && value.runId === CONTINUATION_RUN_ID, 'wrong continuation identity');
  requireCondition(value.authorization?.literal === 'Si continua con las evaluaciones pendientes' && value.authorization.authorizedBy === 'Juan Terven' && Number.isFinite(Date.parse(value.authorization.authorizedAt)), 'missing exact authorization');
  const allowed = value.allowedUnknown;
  requireCondition(allowed?.attemptId === ACKNOWLEDGED_ATTEMPT_ID && allowed.payloadHash === ACKNOWLEDGED_PAYLOAD_HASH && allowed.reservedUsd === '0.76192' && hash(allowed.valueSha256) && hash(allowed.canonicalHash), 'wrong acknowledged unknown');
  requireCondition(hash(value.baseline?.configHash) && hash(value.baseline.configFileSha256), 'invalid original config hashes');
  requireCondition(Array.isArray(value.sources?.original) && Array.isArray(value.sources?.continuation), 'missing source lineage');
  return value;
}
export function createContinuationPolicy(options: { acknowledgmentPath: string; ledger: Ledger; config: Record<string, unknown>; configPath: string }) {
  const ack = loadAcknowledgment(options.acknowledgmentPath), acknowledgmentFileHash = hashFile(options.acknowledgmentPath);
  requireCondition(options.config.runId === ack.runId && options.config.maxEvalUsd === '80' && options.config.globalBudgetUsd === '200' && options.config.concurrency === 2 && options.config.maxOutputTokens === 8192 && options.config.retries === 0, 'measurement settings or budget changed');
  requireCondition(hashObject(options.config) === ack.baseline.configHash && hashFile(options.configPath) === ack.baseline.configFileSha256, 'original config differs');
  requireCondition(hashObject(options.ledger.get(`ragas:${ack.runId}:config`)) === ack.baseline.configHash, 'original ledger config differs');
  requireCondition(options.config.inputHash === ack.baseline.input.sha256, 'input differs from original bridge config');
  for (const file of [ack.baseline.ledgerBackup, ack.baseline.phaseArchive, ack.baseline.input, ...ack.sources.original, ...ack.sources.continuation]) verifyFile(file);
  const requiredOriginal = ['./bridge.ts', './runtime.py', '../ledger.ts', '../util.ts', '../../server/engines/common.ts', '../../server/costs.ts'].map(p => fileURLToPath(new URL(p, import.meta.url)));
  const requiredContinuation = ['./continuation-bridge.ts', './continuation-policy.ts'].map(p => fileURLToPath(new URL(p, import.meta.url)));
  for (const [files, required] of [[ack.sources.original, requiredOriginal], [ack.sources.continuation, requiredContinuation]] as const) {
    requireCondition(new Set(files.map(f => resolve(f.path))).size === files.length, 'duplicate source references');
    for (const path of required) requireCondition(files.some(f => resolve(f.path) === path), 'missing executed source hash');
  }
  const prefix = ack.baseline.results;
  requireCondition(typeof prefix?.path === 'string' && Number.isSafeInteger(prefix.prefixBytes) && prefix.prefixBytes > 0 && Number.isSafeInteger(prefix.terminalRows) && prefix.terminalRows > 0 && hash(prefix.prefixSha256), 'invalid result prefix');
  requireCondition(hashFile(prefix.path, prefix.prefixBytes) === prefix.prefixSha256, 'terminal result prefix changed');
  const input = readFileSync(resolve(ack.baseline.input.path), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const allowedPairs = new Set<string>(), samples = new Set<string>();
  for (const sample of input) {
    requireCondition(typeof sample.id === 'string' && sample.id.length > 0 && !samples.has(sample.id) && Array.isArray(sample.metrics) && new Set(sample.metrics).size === sample.metrics.length, 'invalid or duplicate frozen sample'); samples.add(sample.id);
    for (const metric of sample.metrics) { requireCondition(['faithfulness', 'answer_accuracy'].includes(metric), 'metric outside approved scope'); allowedPairs.add(pair(sample.id, metric)); }
  }
  requireCondition(allowedPairs.size === 2874 && prefix.terminalRows === 1634, 'acknowledged baseline metric counts differ');
  const bytes = Buffer.alloc(prefix.prefixBytes), fd = openSync(resolve(prefix.path), 'r');
  try { let n = 0; while (n < bytes.length) { const read = readSync(fd, bytes, n, bytes.length - n, null); if (!read) break; n += read; } requireCondition(n === bytes.length, 'truncated terminal prefix'); }
  finally { closeSync(fd); }
  requireCondition(bytes.at(-1) === 10, 'terminal prefix must end at a complete JSONL row');
  const terminal = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line)), terminalPairs = new Set<string>();
  requireCondition(terminal.length === prefix.terminalRows, 'terminal row count differs');
  for (const row of terminal) {
    const key = pair(row.sampleId, row.metric);
    requireCondition(['completed', 'error', 'unscorable'].includes(row.status) && allowedPairs.has(key) && !terminalPairs.has(key), 'invalid or duplicate terminal metric'); terminalPairs.add(key); allowedPairs.delete(key);
  }
  requireCondition(Number(allowedPairs.size) === 1240 && terminal.filter(row => row.status === 'completed').length === 1632 && terminal.filter(row => row.status === 'error').length === 2, 'acknowledged terminal/missing counts differ');
  const assertUnknown = () => {
    const raw = options.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(ack.allowedUnknown.attemptId) as { value: string } | undefined;
    requireCondition(raw && sha256(raw.value) === ack.allowedUnknown.valueSha256, 'acknowledged unknown is missing or altered');
    const attempt = JSON.parse(raw.value) as PaidAttempt;
    requireCondition(hashObject(attempt) === ack.allowedUnknown.canonicalHash && attempt.id === ACKNOWLEDGED_ATTEMPT_ID && attempt.runId.startsWith(`${ack.runId}:`) && attempt.status === 'unknown' && attempt.costUsd === null && attempt.reservedUsd === '0.76192' && attempt.payloadHash === ACKNOWLEDGED_PAYLOAD_HASH, 'acknowledged unknown fields differ');
    requireCondition(!options.ledger.attempts().some(a => a.runId.startsWith(`${ack.runId}:`) && a.status === 'unknown' && a.id !== ACKNOWLEDGED_ATTEMPT_ID), 'another unknown halts continuation');
  };
  assertUnknown();
  requireCondition(!options.ledger.attempts().some(a => a.runId.startsWith(`${ack.runId}:`) && a.status === 'pending'), 'pending historical judge attempt');
  const lineage = { schemaVersion: 1, kind: 'ragas-judge-continuation-lineage', acknowledgment: ack, acknowledgmentHash: hashObject(ack), acknowledgmentFileHash, originalConfigHash: ack.baseline.configHash, continuationSourceHash: hashFile(fileURLToPath(new URL('./continuation-bridge.ts', import.meta.url))), policySourceHash: hashFile(fileURLToPath(new URL('./continuation-policy.ts', import.meta.url))) };
  return { ack, lineage,
    assertRequest(input: JudgeRequest) {
      requireCondition(allowedPairs.has(pair(input.sampleId, input.metric)), 'metric is terminal or outside frozen missing scope');
      const maxOrdinal = 2; // Official Faithfulness and AnswerAccuracy each use at most two calls.
      requireCondition(Array.from({ length: maxOrdinal }, (_, i) => `ragas:${hashObject([ack.runId, input.sampleId, input.metric, i + 1])}`).includes(input.requestId), 'request ID is not the original deterministic metric request');
    },
    beforeNewCall() {
      assertUnknown();
      requireCondition(hashFile(options.acknowledgmentPath) === acknowledgmentFileHash, 'acknowledgment changed');
      requireCondition(hashFile(options.configPath) === ack.baseline.configFileSha256 && hashObject(options.ledger.get(`ragas:${ack.runId}:config`)) === ack.baseline.configHash, 'original config changed');
      requireCondition(statSync(resolve(prefix.path)).size >= prefix.prefixBytes && hashFile(prefix.path, prefix.prefixBytes) === prefix.prefixSha256, 'terminal result prefix changed');
    },
  };
}
