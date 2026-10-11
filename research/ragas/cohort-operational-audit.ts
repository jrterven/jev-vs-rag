/** Offline binding of the explicitly acknowledged judge continuation. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Decimal } from 'decimal.js';
import { hashObject, sha256 } from '../util.js';
import type { AuditTotals } from './audit.js';

type Json = Record<string, any>;
const RUN = 'ragas-books-test-20261004-v1';
const UNKNOWN = '44aaf63e-7983-4dac-99c9-14a5d4a6fe44';
const PAYLOAD = '5deb0544525bd8fb589588dac4d7e502ae7a108c47c4014b4a70d06827bcd5ce';
const SECOND_UNKNOWN = '5494ddf7-e3a9-4863-9e32-e17d21c9b0d2';
const SECOND_PAYLOAD = '4d0ccea82bdce6dea96dd6d907408129738751a768328f6c3aaa1ca499f554c0';
const SECOND_BASELINE = 'c01011e9d126dc117ea4db674cd864d64b65639926ada083c4e81c8e1ca66141';
const SECOND_ARCHIVE = 'f53fbc3575b3e0d2bf1c699b9cbc210bbbb0e068ec614aa62fbdfc138067fb8b';
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a: unknown, b: unknown) => a !== undefined && b !== undefined && hashObject(a) === hashObject(b);
function fileHash(path: string): string {
  const stat = lstatSync(path); need(stat.isFile() && !stat.isSymbolicLink(), 'Expected regular continuation artifact');
  const fd = openSync(path, 'r'), value = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) value.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return value.digest('hex');
}
const read = (path: string): Json => { fileHash(path); return JSON.parse(readFileSync(path, 'utf8')); };

export function bindCohortOperationalContinuation(options: {
  receiptPath: string; directory: string; config: Json; db: DatabaseSync; ledgerSha256: string;
  phaseTotals: AuditTotals; globalTotals: AuditTotals; expectedMetrics: number; terminalMetrics: number; statusCounts: Json;
}) {
  const { directory, config, db } = options;
  const receipt = read(options.receiptPath), receiptSha256 = fileHash(options.receiptPath);
  const second = receipt.schemaVersion === 3 && receipt.kind === 'verified-ragas-cohort-continuation-lineage';
  need((second) && receipt.ok === true
    && receipt.preflight === false && receipt.runId === RUN && config.runId === RUN, 'Invalid operational continuation receipt');
  // Presence of a later sidecar must never be hidden by supplying an earlier receipt.
  if (!second) need(!existsSync(join(directory, 'bridge/continuation2.json'))
    && !db.prepare('SELECT key FROM immutable WHERE key=?').get(`ragas:${RUN}:continuation2`), 'Second operational continuation requires its own receipt');
  const suffix = 'cohort';
  const ackPath = 'cohort-20261006/acknowledgment.json';
  const originalTerminalMetrics = second ? 2545 : 1634;
  need(receipt.ledgerSha256 === options.ledgerSha256 && digest(receipt.baselineLedgerSha256), 'Operational ledger differs');
  for (const [key, path] of Object.entries({ resultsSha256: 'study.results.jsonl', callsSha256: 'study.results.jsonl.calls.jsonl',
    lineageSha256: `bridge/${suffix}.json`, historicalBudgetSha256: 'bridge/budget.json',
    continuationBudgetSha256: `bridge/${suffix}-budget.json`, acknowledgmentSha256: ackPath,
    ...(second ? { priorAcknowledgmentSha256: 'continuation2-20261006/acknowledgment.json', priorLineageSha256: 'bridge/continuation2.json',
      priorContinuationBudgetSha256: 'bridge/continuation2-budget.json' } : {}) })) {
    need(digest(receipt[key]) && receipt[key] === fileHash(join(directory, path)), 'Operational artifact hash differs: ' + key);
  }
  need(receipt.originalTerminalMetrics === originalTerminalMetrics && receipt.expectedMetrics === 2874
    && receipt.expectedMetrics === options.expectedMetrics && receipt.terminalMetrics === options.terminalMetrics
    && Number.isSafeInteger(receipt.terminalMetrics) && receipt.terminalMetrics >= originalTerminalMetrics && receipt.terminalMetrics <= 2874
    && receipt.newTerminalMetrics === receipt.terminalMetrics - originalTerminalMetrics && receipt.missingMetrics === 2874 - receipt.terminalMetrics
    && receipt.allMetricsTerminal === (receipt.missingMetrics === 0), 'Operational metric accounting differs');
  need(receipt.terminalStatusCounts && Object.keys(receipt.terminalStatusCounts).every(k => ['completed', 'error', 'unscorable'].includes(k))
    && ['completed', 'error', 'unscorable'].every(k => (receipt.terminalStatusCounts[k] ?? 0) === options.statusCounts[k]), 'Operational status counts differ');
  const ack = read(join(directory, ackPath));
  const lineage = read(join(directory, `bridge/${suffix}.json`));
  need(ack.schemaVersion === 1 && ack.kind === `ragas-judge-${suffix}` && ack.runId === RUN
    && ack.authorization?.literal === (second ? 'autorizo terminar los 329 missing sample/metric pairs' : 'Si continua con las evaluaciones pendientes') && ack.authorization.authorizedBy === 'Juan Terven'
    && Number.isFinite(Date.parse(ack.authorization.authorizedAt)), 'Operational authorization differs');
  need(lineage.schemaVersion === 1 && lineage.kind === `ragas-judge-${suffix}-lineage`
    && equal(lineage.acknowledgment, ack) && lineage.acknowledgmentHash === hashObject(ack)
    && lineage.acknowledgmentFileHash === receipt.acknowledgmentSha256
    && lineage.originalConfigHash === hashObject(config) && ack.baseline?.configHash === hashObject(config)
    && ack.baseline.configFileSha256 === fileHash(join(directory, 'bridge/bridge-config.json'))
    && ack.baseline.ledgerBackup?.sha256 === receipt.baselineLedgerSha256, 'Operational lineage differs');
  need(config.maxEvalUsd === '80' && config.globalBudgetUsd === '200' && config.concurrency === 2
    && config.maxOutputTokens === 8192 && config.retries === 0 && config.stopOnSettledUnknownUsage === true, 'Operational settings differ');
  const sourceHashes: Record<string, string> = {};
  for (const group of (second ? ['original', 'priorContinuation', 'continuation'] : ['original', 'continuation'])) {
    need(Array.isArray(ack.sources?.[group]) && ack.sources[group].length > 0, 'Operational sources missing');
    for (const source of ack.sources[group]) {
      need(typeof source.path === 'string' && !(source.path in sourceHashes) && digest(source.sha256), 'Invalid operational source');
      sourceHashes[source.path] = source.sha256;
    }
  }
  need(equal(sourceHashes, receipt.sourceHashes), 'Operational source set differs');
  for (const [file, key] of [[`${suffix}-bridge.ts`, 'continuationSourceHash'], [`${suffix}-policy.ts`, 'policySourceHash']]) {
    const refs = ack.sources.continuation.filter((r: Json) => basename(r.path) === file);
    need(refs.length === 1 && lineage[key] === refs[0].sha256, 'Operational executable hash differs');
  }
  const frozen = (key: string, expected: unknown) => {
    const row = db.prepare('SELECT hash,value FROM immutable WHERE key=?').get(key) as { hash: string; value: string } | undefined;
    need(row, 'Operational freeze missing'); const value = JSON.parse(row.value);
    need(row.hash === hashObject(value) && equal(value, expected), 'Operational freeze differs');
  };
  frozen(`ragas:${RUN}:${suffix}`, lineage); frozen(`ragas:${RUN}:config`, config);
  frozen('budget-limit', { maxBudgetUsd: '200' }); frozen(`budget-scope:${RUN}:`, { runPrefix: RUN + ':', maxBudgetUsd: '80' });
  if (second) {
    need(receipt.baselineLedgerSha256 === SECOND_BASELINE && receipt.baselineArchiveSha256 === SECOND_ARCHIVE
      && receipt.baselineArchiveFilesVerified === 10273 && receipt.priorOperationFilesPreserved === 10271, 'Operational second baseline differs');
    need(options.statusCounts.completed >= 2540 && options.statusCounts.error >= 5, 'Operational second historical outcomes differ');
    const priorAck = read(join(directory, 'continuation2-20261006/acknowledgment.json'));
    const priorLineage = read(join(directory, 'bridge/continuation2.json'));
    need(priorAck.schemaVersion === 1 && priorAck.kind === 'ragas-judge-continuation2' && priorAck.runId === RUN
      && priorAck.authorization?.literal === 'ok termina los exprimentos y el paper' && priorAck.authorization.authorizedBy === 'Juan Terven'
      && Number.isFinite(Date.parse(priorAck.authorization.authorizedAt)) && priorAck.baseline?.configHash === hashObject(config)
      && priorAck.baseline.configFileSha256 === fileHash(join(directory, 'bridge/bridge-config.json')), 'Operational prior authorization differs');
    need(priorLineage.schemaVersion === 1 && priorLineage.kind === 'ragas-judge-continuation2-lineage'
      && equal(priorLineage.acknowledgment, priorAck) && priorLineage.acknowledgmentHash === hashObject(priorAck)
      && priorLineage.acknowledgmentFileHash === receipt.priorAcknowledgmentSha256 && priorLineage.originalConfigHash === hashObject(config)
      && lineage.priorAcknowledgmentHash === hashObject(priorAck) && lineage.priorAcknowledgmentFileHash === receipt.priorAcknowledgmentSha256
      && lineage.priorLineageHash === hashObject(priorLineage) && receipt.priorLineageCanonicalHash === hashObject(priorLineage)
      && lineage.priorLineageFileHash === receipt.priorLineageSha256 && lineage.priorBudgetFileHash === receipt.priorContinuationBudgetSha256
      && ack.priorContinuation?.acknowledgment?.sha256 === receipt.priorAcknowledgmentSha256
      && ack.priorContinuation.lineage?.sha256 === receipt.priorLineageSha256 && ack.priorContinuation.lineageHash === hashObject(priorLineage)
      && ack.priorContinuation.budget?.sha256 === receipt.priorContinuationBudgetSha256, 'Operational prior lineage differs');
    frozen(`ragas:${RUN}:continuation2`, priorLineage);
    const firstAck = read(join(directory,'continuation-20261005/acknowledgment.json'));
    const firstLineage = read(join(directory,'bridge/continuation.json'));
    need(equal(firstLineage.acknowledgment,firstAck) && firstLineage.acknowledgmentHash===hashObject(firstAck)
      && priorLineage.priorAcknowledgmentHash===hashObject(firstAck) && priorLineage.priorLineageHash===hashObject(firstLineage), 'First continuation lineage changed');
    for (const [key,path] of Object.entries({acknowledgment:'continuation-20261005/acknowledgment.json',lineage:'bridge/continuation.json',budget:'bridge/continuation-budget.json'})) {
      need(priorAck.priorContinuation[key].sha256===fileHash(join(directory,path)), 'First continuation artifact changed');
    }
    frozen(`ragas:${RUN}:continuation`,firstLineage);
    need(equal(priorAck.sources?.original, ack.sources.original) && equal([...priorAck.sources.priorContinuation,...priorAck.sources.continuation], ack.sources.priorContinuation), 'Operational prior source chain differs');
    for (const [file, key] of [['continuation2-bridge.ts', 'continuationSourceHash'], ['continuation2-policy.ts', 'policySourceHash']]) {
      const refs = priorAck.sources.continuation.filter((r: Json) => basename(r.path) === file);
      need(refs.length === 1 && priorLineage[key] === refs[0].sha256, 'Operational prior executable hash differs');
    }
    need(Array.isArray(ack.allowedUnknowns) && ack.allowedUnknowns.length === 3
      && priorAck.allowedUnknowns.length === 2 && priorAck.allowedUnknowns.every((old:Json)=>equal(old,ack.allowedUnknowns.find((u:Json)=>u.attemptId===old.attemptId))), 'Operational original unknown acknowledgment differs');
  }
  const expectedUnknowns = second ? [[UNKNOWN, PAYLOAD], ['1467db16-ea6a-4646-ae28-2de7b8a0ff8f', 'e0e398e1020897fcffb3e3dc930af05b87015382e3164fc88b8139b1c7fba63d'], [SECOND_UNKNOWN, SECOND_PAYLOAD]] : [[UNKNOWN, PAYLOAD]];
  const unknowns = second ? ack.allowedUnknowns : [ack.allowedUnknown];
  const acknowledgedUnknownsPreserved = expectedUnknowns.map(([id, payload]) => {
    const row = db.prepare('SELECT value FROM attempts WHERE id=?').get(id) as { value: string } | undefined;
    need(row, 'Acknowledged unknown missing'); const attempt = JSON.parse(row.value);
    const matches = unknowns.filter((u: Json) => u?.attemptId === id); need(matches.length === 1, 'Acknowledged unknown set differs'); const unknown = matches[0];
    need(unknown.payloadHash === payload && unknown.reservedUsd === '0.76192'
      && sha256(row.value) === unknown.valueSha256 && hashObject(attempt) === unknown.canonicalHash
      && attempt.id === id && attempt.runId.startsWith(RUN + ':') && attempt.payloadHash === payload
      && attempt.status === 'unknown' && attempt.costUsd === null && attempt.reservedUsd === '0.76192', 'Acknowledged unknown was changed');
    return { attemptId: id, rawValueSha256: unknown.valueSha256, ...(second ? { canonicalHash: unknown.canonicalHash, payloadHash: payload } : {}), reservedUsd: '0.76192', status: 'unknown', costUsd: null };
  });
  const acknowledgedUnknownPreserved = acknowledgedUnknownsPreserved[0];
  need(equal(second ? receipt.acknowledgedUnknownsPreserved : receipt.acknowledgedUnknownPreserved,
    second ? acknowledgedUnknownsPreserved : acknowledgedUnknownPreserved), 'Operational unknown receipt differs');
  need(Number.isSafeInteger(receipt.newUnknownAttempts) && receipt.newUnknownAttempts >= 0
    && receipt.newUnknownAttempts === options.phaseTotals.unknownAttempts - expectedUnknowns.length, 'Operational unknown count differs');
  need(new Decimal(options.phaseTotals.committedUsd).lte(80) && new Decimal(options.globalTotals.committedUsd).lte(200), 'Operational budget cap exceeded');
  need(receipt.providerEventsSha256 === fileHash(join(directory,'cohort-20261006/provider-events.jsonl')), 'Provider outcome log differs');
  const historicalBudget = read(join(directory, 'bridge/budget.json'));
  const budget = read(join(directory, `bridge/${suffix}-budget.json`));
  need(historicalBudget.runId === RUN && historicalBudget.maxEvalUsd === '80'
    && budget.runId === RUN && budget.maxEvalUsd === '80', 'Operational budget identity differs');
  for (const [key, totals] of [['evaluation', options.phaseTotals], ['global', options.globalTotals]] as const) {
    need(equal(budget[key], { knownUsd: totals.knownUsd, reservedUsd: totals.reservedUsd, committedUsd: totals.committedUsd,
      unknownAttempts: totals.missingCostAttempts }), 'Operational current budget differs');
  }
  return { schemaVersion: second ? 3 : 1, kind: second ? 'verified-ragas-cohort-operational-continuation-binding' : 'verified-ragas-operational-continuation-binding', runId: RUN, receiptSha256, providerEventsSha256: receipt.providerEventsSha256,
    acknowledgmentSha256: receipt.acknowledgmentSha256, lineageSha256: receipt.lineageSha256,
    historicalBudgetSha256: receipt.historicalBudgetSha256, continuationBudgetSha256: receipt.continuationBudgetSha256,
    ledgerSha256: options.ledgerSha256, resultsSha256: receipt.resultsSha256, callsSha256: receipt.callsSha256,
    originalConfigHash: hashObject(config), sourceHashes,
    ...(second ? { acknowledgedUnknownsPreserved, priorAcknowledgmentSha256: receipt.priorAcknowledgmentSha256, priorLineageSha256: receipt.priorLineageSha256,
      priorContinuationBudgetSha256: receipt.priorContinuationBudgetSha256, priorLineageCanonicalHash: receipt.priorLineageCanonicalHash,
      baselineLedgerSha256: receipt.baselineLedgerSha256, baselineArchiveSha256: receipt.baselineArchiveSha256 } : { acknowledgedUnknownPreserved }),
    originalTerminalMetrics: receipt.originalTerminalMetrics, expectedMetrics: receipt.expectedMetrics,
    terminalMetrics: receipt.terminalMetrics, missingMetrics: receipt.missingMetrics, newUnknownAttempts: receipt.newUnknownAttempts };
}
