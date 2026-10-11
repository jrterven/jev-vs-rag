/** Offline completion gate after the recorded Jev HTTP 402 halt.
 * tsx research/scripts/verify-study-continuation.ts HALTED_DIR FINAL_DIR FINAL_BACKUP NEW_JSON
 * Does not launch RAGAS, modify the experiment, or call any provider.
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Decimal } from 'decimal.js';
import { implementationSnapshot } from '../implementation.js';
import type { PaidAttempt } from '../ledger.js';
import { combineBundles, makeSchedule, type ExperimentManifest } from '../runner.js';
import { type DatasetBundle, type QueryRun, type ResearchReport } from '../types.js';
import { hashObject, quantile, sha256, stableJson } from '../util.js';
import { qualitySnapshot } from './snapshot-halted-report.js';
import { ReadonlyReportLedger } from './snapshot-retrieval-report.js';
import { auditAttemptCost } from './study-readout.js';

type Run = QueryRun & { generate?: boolean; metrics?: unknown };
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function raw(run: Run) { const { generation: _generation, generationError: _error, metrics: _metrics, ...retrieval } = run; return retrieval; }
function fileHash(path: string) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); return hash.digest('hex'); }
  finally { closeSync(fd); }
}

/** All terminal old retrievals stay byte-equivalent after generation is removed. */
export function continuationOutcomes(manifest: ExperimentManifest, previous: ResearchReport, final: ResearchReport) {
  const before = previous.perQuery as Run[], after = final.perQuery as Run[];
  const assigned = new Map(manifest.schedule.map(run => [run.id, run])), byId = new Map(after.map(run => [run.id, run]));
  check(assigned.size === manifest.schedule.length && byId.size === after.length, 'Duplicate assigned/final run IDs.');
  check(final.missingScheduledRuns === 0 && byId.size === assigned.size, 'The final retrieval schedule is incomplete.');
  for (const run of after) {
    const planned = assigned.get(run.id); check(planned, 'Unscheduled final run.');
    for (const key of ['questionId', 'documentId', 'corpus', 'method', 'round', 'timingSample', 'generate'] as const) check(run[key] === planned[key], `Final run differs from schedule: ${key}`);
    check(['completed', 'failed'].includes(run.status), 'Nonterminal final retrieval.');
    if (run.resumed) check(run.timingValid === false, 'Resumed retrieval must have invalid timing.');
  }
  check(new Set(before.map(run => run.id)).size === before.length, 'Duplicate halted run IDs.');
  const preserved: string[] = [], resumed: string[] = [];
  for (const run of before) {
    const next = byId.get(run.id); check(next, 'A halted run was lost.');
    if (run.status === 'interrupted') {
      check(next.resumed === true && next.timingValid === false, 'The interrupted run was not explicitly resumed with invalid timing.');
      resumed.push(run.id);
    } else {
      check(['completed', 'failed'].includes(run.status) && hashObject(raw(run)) === hashObject(raw(next)), `A terminal halted retrieval changed: ${run.id}`);
      preserved.push(run.id);
    }
  }
  const generation = manifest.schedule.filter(run => run.generate).map(planned => {
    const run = byId.get(planned.id)!;
    check(!(run.generation && run.generationError !== undefined), 'Contradictory generation outcomes.');
    let outcome: 'completed' | 'oracle-ineligible' | 'generation-failed' | 'retrieval-unavailable';
    if (run.status === 'failed') {
      check(!run.generation && run.generationError === undefined, 'Failed retrieval unexpectedly has a generation outcome.');
      outcome = 'retrieval-unavailable';
    } else if (run.generation) outcome = 'completed';
    else {
      check(typeof run.generationError === 'string' && run.generationError.length > 0, `Pending generation is not a terminal missing result: ${run.id}`);
      outcome = run.method === 'oracle' && run.generationError.includes('control ineligible') ? 'oracle-ineligible' : 'generation-failed';
    }
    return { runId: run.id, corpus: run.corpus, method: run.method, outcome, abstained: run.generation?.abstained ?? null };
  });
  for (const run of after.filter(run => !assigned.get(run.id)!.generate)) check(!run.generation && run.generationError === undefined, 'Unscheduled generation outcome.');
  const timing = [...new Set(after.filter(run => run.timingSample).map(run => `${run.corpus}|${run.method}|${run.round}`))].map(key => {
    const [corpus, method, round] = key.split('|'), rows = after.filter(run => run.timingSample && run.corpus === corpus && run.method === method && run.round === Number(round));
    const valid = rows.filter(run => run.status === 'completed' && run.timingValid !== false), durations = valid.map(run => run.elapsedMs);
    check(durations.every(ms => Number.isFinite(ms) && ms >= 0), 'Invalid elapsed time in included timing sample.');
    return { corpus, method, round: Number(round), assigned: rows.length, completedValid: valid.length,
      failed: rows.filter(run => run.status === 'failed').length, completedTimingInvalid: rows.filter(run => run.status === 'completed' && run.timingValid === false).length,
      resumed: rows.filter(run => run.resumed).length, medianMs: durations.length ? quantile(durations, .5) : null, p95Ms: durations.length ? quantile(durations, .95) : null,
      firstStartedAt: rows.map(run => run.startedAt).sort()[0] ?? null, lastFinishedAt: rows.map(run => run.finishedAt).sort().at(-1) ?? null,
      interpretation: 'Descriptive temporal-block audit; valid completed elapsed times only. Planned primary latency still pools valid runs over all three rounds.' };
  });
  return { terminalRetrievalPreserved: preserved.length, preservedRunIds: preserved, interruptedRunsResumed: resumed,
    finalRetrieval: { assigned: assigned.size, completed: after.filter(run => run.status === 'completed').length, failed: after.filter(run => run.status === 'failed').length },
    generation: { assigned: generation.length, completed: generation.filter(row => row.outcome === 'completed').length,
      oracleIneligible: generation.filter(row => row.outcome === 'oracle-ineligible').length, failed: generation.filter(row => row.outcome === 'generation-failed').length,
      unavailableAfterRetrievalFailure: generation.filter(row => row.outcome === 'retrieval-unavailable').length, pending: 0, perRun: generation }, timing };
}

/** Retains every old global attempt, including unknown usage and its reserve. */
export function continuationAttempts(previous: PaidAttempt[], final: PaidAttempt[], previousRuns: Run[], experimentId: string) {
  const before = new Map(previous.map(attempt => [attempt.id, attempt])), after = new Map(final.map(attempt => [attempt.id, attempt]));
  check(before.size === previous.length && after.size === final.length, 'Duplicate API attempt IDs.');
  for (const attempt of previous) { const next = after.get(attempt.id); check(next && hashObject(next) === hashObject(attempt), `An old paid attempt/reservation was changed or lost: ${attempt.id}`); }
  check(final.every(attempt => attempt.status !== 'pending'), 'An API attempt remains pending.');
  const terminalIds = new Set(previousRuns.filter(run => run.status !== 'interrupted').map(run => run.id));
  for (const attempt of final) {
    check(attempt.costUsd === null ? attempt.status === 'unknown' : ['completed', 'failed'].includes(attempt.status), 'Settled attempt status contradicts known/unknown consumption.');
    const reserve = new Decimal(attempt.reservedUsd);
    check(reserve.isFinite() && !reserve.isNegative(), 'Invalid unresolved reservation.');
    auditAttemptCost(attempt);
    if (before.has(attempt.id) || !attempt.runId.startsWith(experimentId + ':') || attempt.operation === 'generation') continue;
    check(!terminalIds.has(attempt.runId), 'A terminal halted retrieval was charged again.');
    check(!['document_embedding', 'structure'].includes(attempt.operation), 'Completed preparation was charged again.');
  }
  const unknown = final.filter(attempt => attempt.costUsd === null);
  return { oldGlobalAttemptsPreserved: before.size, oldUnknownAttemptsPreserved: previous.filter(attempt => attempt.costUsd === null).length,
    unknownAttempts: unknown.length, knownObservedUsd: final.reduce((total, attempt) => total.add(attempt.costUsd ?? 0), new Decimal(0)).toFixed(),
    unresolvedReservationUsd: unknown.reduce((total, attempt) => total.add(attempt.reservedUsd), new Decimal(0)).toFixed(),
    historical402AttemptsPreserved: previous.filter(attempt => attempt.error === 'HTTP 402').length,
    historical402RunIds: [...new Set(previous.filter(attempt => attempt.error === 'HTTP 402').map(attempt => attempt.runId))],
    interpretation: 'Unknown consumption and reservations are preserved; reserves are not observed charges or demonstrated upper bounds.' };
}

export async function verifyStudyContinuation(haltedDirectory: string, finalDirectory: string, finalBackup: string, outputPath: string) {
  const halted = resolve(haltedDirectory), final = resolve(finalDirectory), backup = resolve(finalBackup), output = resolve(outputPath);
  check(!existsSync(output) && existsSync(dirname(output)), 'Output must be new with an existing parent directory.');
  const stage = JSON.parse(readFileSync(join(halted, 'snapshot-stage.json'), 'utf8'));
  check(stage.kind === 'halted-study-snapshot' && stage.retrievalQualityComplete === true && stage.ragasEligible === false, 'An audited primary-complete halted snapshot is required.');
  const metadata = ['manifest.json', 'datasets.json', 'source-snapshot.json'];
  for (const name of metadata) {
    const bytes = readFileSync(join(final, name));
    check(sha256(bytes) === stage.source.hashes[name] && bytes.equals(readFileSync(join(halted, name))), `Frozen metadata changed: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(join(final, 'manifest.json'), 'utf8')) as ExperimentManifest;
  const bundles = JSON.parse(readFileSync(join(final, 'datasets.json'), 'utf8')) as DatasetBundle[];
  const source = JSON.parse(readFileSync(join(final, 'source-snapshot.json'), 'utf8'));
  check(manifest.kind === 'measured' && manifest.configHash === hashObject(manifest.config), 'Measured immutable configuration required.');
  check(source.hash === manifest.implementationHash && hashObject(source.files) === source.hash && implementationSnapshot().hash === source.hash, 'Frozen implementation changed.');
  check(combineBundles(bundles).datasetHash === manifest.datasetHash, 'Frozen dataset changed.');
  check(stableJson(makeSchedule(bundles, manifest.config, manifest.id, manifest.phase)) === stableJson(manifest.schedule), 'Frozen schedule changed.');
  const oldReportPath = join(halted, 'report.json'), reportPath = join(final, 'report.json'), oldBackup = join(halted, stage.ledgerSnapshot.file);
  const oldReport = JSON.parse(readFileSync(oldReportPath, 'utf8')) as ResearchReport, report = JSON.parse(readFileSync(reportPath, 'utf8')) as ResearchReport;
  check(fileHash(oldReportPath) === stage.reportSha256, 'Halted report was altered.');
  check(hashObject(JSON.parse(readFileSync(join(halted, 'primary-quality.json'), 'utf8'))) === stage.primaryQualitySha256, 'Halted primary quality was altered.');
  for (const key of ['experimentId', 'datasetHash', 'configHash', 'implementationHash'] as const) check(report[key] === oldReport[key], `Final report identity differs: ${key}`);
  for (const path of [oldBackup, backup]) for (const suffix of ['-wal', '-journal']) check(!existsSync(path + suffix) || statSync(path + suffix).size === 0, 'A consistent standalone backup is required.');
  const oldHash = fileHash(oldBackup), finalHash = fileHash(backup), reportHash = fileHash(reportPath);
  check(oldHash === stage.ledgerSnapshot.sha256, 'Halted ledger was altered.');
  const outcomes = continuationOutcomes(manifest, oldReport, report);
  const temporary = mkdtempSync(join(tmpdir(), 'study-continuation-'));
  let priorLedger: ReadonlyReportLedger | undefined, finalLedger: ReadonlyReportLedger | undefined;
  try {
    const oldCopy = join(temporary, 'halted.sqlite'), finalCopy = join(temporary, 'final.sqlite');
    copyFileSync(oldBackup, oldCopy); copyFileSync(backup, finalCopy);
    check(fileHash(oldCopy) === oldHash && fileHash(finalCopy) === finalHash, 'Ledger changed while copying.');
    priorLedger = new ReadonlyReportLedger(oldCopy); finalLedger = new ReadonlyReportLedger(finalCopy);
    for (const ledger of [priorLedger, finalLedger]) {
      check(String(Object.values(ledger.db.prepare('PRAGMA integrity_check').get()!)[0]) === 'ok', 'Ledger integrity check failed.');
      check(hashObject(ledger.get(`experiment:${manifest.id}`)) === hashObject(manifest), 'Ledger manifest changed.');
    }
    const rows = finalLedger.runRows().filter(row => row.id.startsWith(manifest.id + ':'));
    check(rows.length === manifest.schedule.length && rows.every(row => ['completed', 'failed'].includes(row.status)), 'Ledger retrieval schedule is not terminal.');
    const saved = new Map(rows.map(row => [row.id, row]));
    for (const run of report.perQuery as Run[]) {
      const record = saved.get(run.id); check(record && record.status === run.status && hashObject(JSON.parse(record.value)) === hashObject(raw(run)), 'Report differs from final ledger retrieval.');
      const generated = finalLedger.get(`${run.id}:generation-result`);
      const reported = run.generation ? { generation: run.generation } : run.generationError !== undefined ? { generationError: run.generationError } : undefined;
      check(hashObject(generated ?? null) === hashObject(reported ?? null), 'Report differs from immutable generation outcome.');
    }
    const accounting = continuationAttempts(priorLedger.attempts(), finalLedger.attempts(), oldReport.perQuery as Run[], manifest.id);
    const actual402 = accounting.historical402RunIds.filter(id => id.startsWith(manifest.id + ':')).sort();
    check(stableJson(actual402) === stableJson([...stage.haltEvidence.payment402RunIds].sort()), 'Historical HTTP 402 cohort differs.');
    const quality = await qualitySnapshot(report, bundles, manifest), qualityHash = hashObject(quality);
    check(qualityHash === stage.primaryQualitySha256, 'Primary quality/retention fingerprint changed after continuation.');
    check(fileHash(oldBackup) === oldHash && fileHash(backup) === finalHash && fileHash(reportPath) === reportHash, 'An input changed during verification.');
    const result = { schemaVersion: 1, kind: 'verified-study-continuation', experimentId: manifest.id, phase: manifest.phase,
      primaryQualitySha256: qualityHash, primaryQualityUnchanged: true, allRetrievalTerminal: true, allGenerationTerminal: true,
      ragasInputReady: true, judgeLaunchAuthorized: false,
      scope: 'Offline completion evidence only. Judge launch additionally requires its own process, budget, provenance and input checks.',
      hashes: { haltedStage: fileHash(join(halted, 'snapshot-stage.json')), haltedLedger: oldHash, finalLedger: finalHash, report: reportHash,
        manifest: fileHash(join(final, 'manifest.json')), verifier: fileHash(fileURLToPath(import.meta.url)) },
      ...outcomes, accounting };
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { output, primaryQualitySha256: qualityHash, finalRetrieval: result.finalRetrieval, generation: { ...result.generation, perRun: undefined }, accounting };
  } finally { priorLedger?.close(); finalLedger?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [halted, final, backup, output, extra] = process.argv.slice(2);
  if (!halted || !final || !backup || !output || extra) throw new Error('Usage: tsx research/scripts/verify-study-continuation.ts HALTED_DIR FINAL_DIR FINAL_BACKUP NEW_JSON');
  console.log(await verifyStudyContinuation(halted, final, backup, output));
}
