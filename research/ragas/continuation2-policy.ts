/** Second explicitly authorized continuation; never reconciles or discounts unknown usage. */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ledger, PaidAttempt } from '../ledger.js';
import { hashObject, sha256 } from '../util.js';
import type { JudgeRequest } from './bridge.js';

export const CONTINUATION_RUN_ID = 'ragas-books-test-20261004-v1';
export const ACKNOWLEDGED_UNKNOWNS = [
  { attemptId: '44aaf63e-7983-4dac-99c9-14a5d4a6fe44', payloadHash: '5deb0544525bd8fb589588dac4d7e502ae7a108c47c4014b4a70d06827bcd5ce' },
  { attemptId: '5494ddf7-e3a9-4863-9e32-e17d21c9b0d2', payloadHash: '4d0ccea82bdce6dea96dd6d907408129738751a768328f6c3aaa1ca499f554c0' },
] as const;
export interface FileReference { path: string; sha256: string; }
export interface Continuation2Acknowledgment {
  schemaVersion: 1; kind: 'ragas-judge-continuation2'; runId: typeof CONTINUATION_RUN_ID;
  authorization: { literal: 'ok termina los exprimentos y el paper'; authorizedBy: 'Juan Terven'; authorizedAt: string };
  baseline: { configHash: string; configFileSha256: string; ledgerBackup: FileReference; phaseArchive: FileReference;
    results: { path: string; prefixBytes: number; prefixSha256: string; terminalRows: number }; input: FileReference };
  allowedUnknowns: Array<{ attemptId: string; valueSha256: string; canonicalHash: string; payloadHash: string; reservedUsd: '0.76192' }>;
  priorContinuation: { acknowledgment: FileReference; lineage: FileReference; lineageHash: string; budget: FileReference };
  sources: { original: FileReference[]; priorContinuation: FileReference[]; continuation: FileReference[] };
}
function requireCondition(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Continuation2 guard: ${message}`); }
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
export function loadAcknowledgment(path: string): Continuation2Acknowledgment {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8')) as Continuation2Acknowledgment;
  requireCondition(value?.schemaVersion === 1 && value.kind === 'ragas-judge-continuation2' && value.runId === CONTINUATION_RUN_ID, 'wrong continuation identity');
  requireCondition(value.authorization?.literal === 'ok termina los exprimentos y el paper' && value.authorization.authorizedBy === 'Juan Terven' && Number.isFinite(Date.parse(value.authorization.authorizedAt)), 'missing exact authorization');
  requireCondition(Array.isArray(value.allowedUnknowns) && value.allowedUnknowns.length === 2 && new Set(value.allowedUnknowns.map(a => a.attemptId)).size === 2, 'exactly two distinct acknowledged unknowns required');
  for (const expected of ACKNOWLEDGED_UNKNOWNS) {
    const allowed = value.allowedUnknowns.find(a => a.attemptId === expected.attemptId);
    requireCondition(allowed?.payloadHash === expected.payloadHash && allowed.reservedUsd === '0.76192' && hash(allowed.valueSha256) && hash(allowed.canonicalHash), 'wrong acknowledged unknown');
  }
  requireCondition(value.priorContinuation && hash(value.priorContinuation.lineageHash), 'missing prior continuation lineage');
  requireCondition(hash(value.baseline?.configHash) && hash(value.baseline.configFileSha256), 'invalid original config hashes');
  requireCondition(Array.isArray(value.sources?.original) && Array.isArray(value.sources?.priorContinuation) && Array.isArray(value.sources?.continuation), 'missing source lineage');
  return value;
}
export function createContinuation2Policy(options: { acknowledgmentPath: string; ledger: Ledger; config: Record<string, unknown>; configPath: string }) {
  const ack = loadAcknowledgment(options.acknowledgmentPath), acknowledgmentFileHash = hashFile(options.acknowledgmentPath);
  requireCondition(options.config.runId === ack.runId && options.config.maxEvalUsd === '80' && options.config.globalBudgetUsd === '200' && options.config.concurrency === 2 && options.config.maxOutputTokens === 8192 && options.config.retries === 0, 'measurement settings or budget changed');
  requireCondition(hashObject(options.config) === ack.baseline.configHash && hashFile(options.configPath) === ack.baseline.configFileSha256, 'original config differs');
  requireCondition(hashObject(options.ledger.get(`ragas:${ack.runId}:config`)) === ack.baseline.configHash, 'original ledger config differs');
  requireCondition(options.config.inputHash === ack.baseline.input.sha256, 'input differs from original bridge config');
  for (const file of [ack.baseline.ledgerBackup, ack.baseline.phaseArchive, ack.baseline.input, ack.priorContinuation.acknowledgment, ack.priorContinuation.lineage, ack.priorContinuation.budget, ...ack.sources.original, ...ack.sources.priorContinuation, ...ack.sources.continuation]) verifyFile(file);
  const requiredOriginal = ['./bridge.ts', './runtime.py', '../ledger.ts', '../util.ts', '../../server/engines/common.ts', '../../server/costs.ts'].map(p => fileURLToPath(new URL(p, import.meta.url)));
  const requiredPrior = ['./continuation-bridge.ts', './continuation-policy.ts', '../../output/study-runbook-20261005/resume-ragas-test.py'].map(p => fileURLToPath(new URL(p, import.meta.url)));
  const requiredContinuation = ['./continuation2-bridge.ts', './continuation2-policy.ts', '../../output/study-runbook-20261005/resume-ragas-test-second.py'].map(p => fileURLToPath(new URL(p, import.meta.url)));
  for (const [files, required] of [[ack.sources.original, requiredOriginal], [ack.sources.priorContinuation, requiredPrior], [ack.sources.continuation, requiredContinuation]] as const) {
    requireCondition(new Set(files.map(f => resolve(f.path))).size === files.length, 'duplicate source references');
    for (const path of required) requireCondition(files.some(f => resolve(f.path) === path), 'missing executed source hash');
  }
  const priorAck = JSON.parse(readFileSync(resolve(ack.priorContinuation.acknowledgment.path), 'utf8'));
  const priorLineage = JSON.parse(readFileSync(resolve(ack.priorContinuation.lineage.path), 'utf8'));
  const priorAcknowledgmentHash = hashObject(priorAck);
  const inventoryHash = (files: FileReference[]) => hashObject(files.map(file => ({ path: resolve(file.path), sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en')));
  requireCondition(Array.isArray(priorAck.sources?.original) && Array.isArray(priorAck.sources?.continuation) && inventoryHash(priorAck.sources.original) === inventoryHash(ack.sources.original) && inventoryHash(priorAck.sources.continuation) === inventoryHash(ack.sources.priorContinuation), 'prior software inventory changed');
  const priorSourceHashes = new Map(ack.sources.priorContinuation.map(file => [resolve(file.path), file.sha256]));
  requireCondition(priorAck.schemaVersion === 1 && priorAck.kind === 'ragas-judge-continuation' && priorAck.runId === ack.runId && priorAck.baseline?.configHash === ack.baseline.configHash, 'prior acknowledgment identity differs');
  requireCondition(priorAck.allowedUnknown?.attemptId === ACKNOWLEDGED_UNKNOWNS[0].attemptId && hashObject(priorAck.allowedUnknown) === hashObject(ack.allowedUnknowns.find(a => a.attemptId === ACKNOWLEDGED_UNKNOWNS[0].attemptId)), 'first acknowledged unknown changed');
  requireCondition(priorLineage.schemaVersion === 1 && priorLineage.kind === 'ragas-judge-continuation-lineage' && hashObject(priorLineage) === ack.priorContinuation.lineageHash && hashObject(priorLineage.acknowledgment) === priorAcknowledgmentHash && priorLineage.acknowledgmentHash === priorAcknowledgmentHash && priorLineage.acknowledgmentFileHash === ack.priorContinuation.acknowledgment.sha256 && priorLineage.originalConfigHash === ack.baseline.configHash, 'prior continuation lineage differs');
  requireCondition(priorLineage.continuationSourceHash === priorSourceHashes.get(requiredPrior[0]) && priorLineage.policySourceHash === priorSourceHashes.get(requiredPrior[1]), 'prior continuation software differs');
  const assertPrior = () => {
    for (const file of [ack.priorContinuation.acknowledgment, ack.priorContinuation.lineage, ack.priorContinuation.budget]) verifyFile(file);
    requireCondition(hashObject(options.ledger.get(`ragas:${ack.runId}:continuation`)) === ack.priorContinuation.lineageHash, 'prior ledger lineage changed');
  };
  assertPrior();
  const prefix = ack.baseline.results;
  requireCondition(typeof prefix?.path === 'string' && Number.isSafeInteger(prefix.prefixBytes) && prefix.prefixBytes > 0 && Number.isSafeInteger(prefix.terminalRows) && prefix.terminalRows > 0 && hash(prefix.prefixSha256), 'invalid result prefix');
  requireCondition(hashFile(prefix.path, prefix.prefixBytes) === prefix.prefixSha256, 'terminal result prefix changed');
  const input = readFileSync(resolve(ack.baseline.input.path), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const allowedPairs = new Set<string>(), samples = new Set<string>();
  for (const sample of input) {
    requireCondition(typeof sample.id === 'string' && sample.id.length > 0 && !samples.has(sample.id) && Array.isArray(sample.metrics) && new Set(sample.metrics).size === sample.metrics.length, 'invalid or duplicate frozen sample'); samples.add(sample.id);
    for (const metric of sample.metrics) { requireCondition(['faithfulness', 'answer_accuracy'].includes(metric), 'metric outside approved scope'); allowedPairs.add(pair(sample.id, metric)); }
  }
  requireCondition(allowedPairs.size === 2874 && prefix.terminalRows === 2507, 'acknowledged baseline metric counts differ');
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
  requireCondition(Number(allowedPairs.size) === 367 && terminal.filter(row => row.status === 'completed').length === 2503 && terminal.filter(row => row.status === 'error').length === 4, 'acknowledged terminal/missing counts differ');
  const assertUnknown = () => {
    for (const allowed of ack.allowedUnknowns) {
      const raw = options.ledger.db.prepare('SELECT value FROM attempts WHERE id=?').get(allowed.attemptId) as { value: string } | undefined;
      requireCondition(raw && sha256(raw.value) === allowed.valueSha256, 'acknowledged unknown is missing or altered');
      const attempt = JSON.parse(raw.value) as PaidAttempt;
      requireCondition(hashObject(attempt) === allowed.canonicalHash && attempt.id === allowed.attemptId && attempt.runId.startsWith(`${ack.runId}:`) && attempt.status === 'unknown' && attempt.costUsd === null && attempt.reservedUsd === '0.76192' && attempt.payloadHash === allowed.payloadHash, 'acknowledged unknown fields differ');
    }
    requireCondition(!options.ledger.attempts().some(a => a.runId.startsWith(`${ack.runId}:`) && a.status === 'unknown' && !ack.allowedUnknowns.some(allowed => allowed.attemptId === a.id)), 'another unknown halts continuation');
  };
  assertUnknown();
  requireCondition(!options.ledger.attempts().some(a => a.runId.startsWith(`${ack.runId}:`) && a.status === 'pending'), 'pending historical judge attempt');
  const lineage = { schemaVersion: 1, kind: 'ragas-judge-continuation2-lineage', acknowledgment: ack, acknowledgmentHash: hashObject(ack), acknowledgmentFileHash, originalConfigHash: ack.baseline.configHash, continuationSourceHash: hashFile(fileURLToPath(new URL('./continuation2-bridge.ts', import.meta.url))), policySourceHash: hashFile(fileURLToPath(new URL('./continuation2-policy.ts', import.meta.url))), priorAcknowledgmentHash, priorAcknowledgmentFileHash: ack.priorContinuation.acknowledgment.sha256, priorLineageHash: ack.priorContinuation.lineageHash, priorLineageFileHash: ack.priorContinuation.lineage.sha256, priorBudgetFileHash: ack.priorContinuation.budget.sha256 };
  return { ack, lineage,
    assertRequest(input: JudgeRequest) {
      requireCondition(allowedPairs.has(pair(input.sampleId, input.metric)), 'metric is terminal or outside frozen missing scope');
      const maxOrdinal = 2; // Official Faithfulness and AnswerAccuracy each use at most two calls.
      requireCondition(Array.from({ length: maxOrdinal }, (_, i) => `ragas:${hashObject([ack.runId, input.sampleId, input.metric, i + 1])}`).includes(input.requestId), 'request ID is not the original deterministic metric request');
    },
    beforeNewCall() {
      assertUnknown();
      assertPrior();
      requireCondition(hashFile(options.acknowledgmentPath) === acknowledgmentFileHash, 'acknowledgment changed');
      requireCondition(hashFile(options.configPath) === ack.baseline.configFileSha256 && hashObject(options.ledger.get(`ragas:${ack.runId}:config`)) === ack.baseline.configHash, 'original config changed');
      requireCondition(statSync(resolve(prefix.path)).size >= prefix.prefixBytes && hashFile(prefix.path, prefix.prefixBytes) === prefix.prefixSha256, 'terminal result prefix changed');
    },
  };
}
