/** Offline primary-quality snapshot of a measured study halted after HTTP 402.
 * Separate from the strict completed-retrieval snapshot; does not relax any gate.
 * Usage: tsx research/scripts/snapshot-halted-report.ts SOURCE_DIR BACKUP_SQLITE NEW_DIR
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Decimal } from 'decimal.js';
import { ReadonlyReportLedger } from './snapshot-retrieval-report.js';
import { auditAttemptCost, semanticRetention } from './study-readout.js';
import { evaluateExperiment } from '../report.js';
import { combineBundles, makeSchedule, type ExperimentManifest, type ScheduledRun } from '../runner.js';
import { implementationSnapshot } from '../implementation.js';
import { prepareDocument } from '../datasets.js';
import { clusterBootstrap } from '../metrics.js';
import { METHOD_IDS, type DatasetBundle, type MethodId, type PreparedDocument, type QueryRun, type ResearchReport, type RetrievalMetrics } from '../types.js';
import { hashObject, sha256, stableJson, writeJson } from '../util.js';

const METADATA = ['manifest.json', 'datasets.json', 'source-snapshot.json'] as const;
const isRetrieval = (method: string) => METHOD_IDS.includes(method as MethodId);
type ScoredRun = QueryRun & { metrics: RetrievalMetrics | null };

export function validateHaltedStage(manifest: ExperimentManifest, ledger: ReadonlyReportLedger) {
  const frozen = ledger.get<ExperimentManifest>(`experiment:${manifest.id}`);
  if (!frozen || hashObject(frozen) !== hashObject(manifest)) throw new Error('Manifest differs from immutable ledger experiment.');
  if (stableJson([...manifest.config.methods].sort()) !== stableJson([...METHOD_IDS].sort())) throw new Error('Primary halted snapshot requires all seven retrieval methods.');
  const assigned = new Map(manifest.schedule.map(row => [row.id, row])), runs = new Map<string, QueryRun>(), prefix = manifest.id + ':';
  if (assigned.size !== manifest.schedule.length || !assigned.size) throw new Error('Invalid or duplicate schedule.');
  for (const row of ledger.runRows().filter(row => row.id.startsWith(prefix))) {
    if (row.status === 'running') throw new Error('Running retrieval is not a halted snapshot.');
    if (!['completed', 'failed', 'interrupted'].includes(row.status)) throw new Error('Unknown run status.');
    const run = JSON.parse(row.value) as QueryRun & { generate?: boolean }, scheduled = assigned.get(row.id);
    if (row.id !== run.id || row.status !== run.status) throw new Error('Run SQL/JSON identity or status mismatch.');
    if (!scheduled || runs.has(run.id)) throw new Error('Unexpected or duplicate recorded run.');
    for (const key of ['questionId', 'documentId', 'corpus', 'method', 'round', 'timingSample', 'generate'] as const) if (run[key] !== scheduled[key]) throw new Error(`Run differs from frozen schedule: ${key}`);
    if (run.generation !== undefined || run.generationError !== undefined) throw new Error('Generation must not have started.');
    if (row.status === 'interrupted' && (!isRetrieval(run.method) || run.round === 0)) throw new Error('Only later retrieval repetitions may be interrupted.');
    runs.set(run.id, run);
  }
  const base = manifest.schedule.filter(row => row.round === 0 && isRetrieval(row.method));
  if (!base.length || base.some(row => !['completed', 'failed'].includes(runs.get(row.id)?.status ?? 'missing'))) throw new Error('Primary quality is incomplete: every seven-method base assignment must be terminal.');
  const allAttempts = ledger.attempts(), attempts = allAttempts.filter(attempt => attempt.runId.startsWith(prefix));
  if (allAttempts.some(attempt => attempt.status === 'pending')) throw new Error('Pending API attempts remain in the backup.');
  const documents = new Set(base.map(row => row.documentId));
  for (const attempt of attempts) {
    if (attempt.operation === 'generation') throw new Error('Generation must not have started.');
    if (!['document_embedding', 'structure', 'query_embedding', 'window', 'reduction'].includes(attempt.operation) || !['completed', 'failed', 'unknown'].includes(attempt.status)) throw new Error('Unsupported attempt operation/status.');
    if (!documents.has(attempt.documentId)) throw new Error('Attempt document is outside the frozen primary cohort.');
    if (!['document_embedding', 'structure'].includes(attempt.operation)) {
      const scheduled = assigned.get(attempt.runId);
      if (!scheduled || !isRetrieval(scheduled.method) || scheduled.method !== attempt.method || scheduled.documentId !== attempt.documentId || !runs.has(attempt.runId)) throw new Error('Attempt lacks a recorded frozen retrieval assignment.');
    }
    auditAttemptCost(attempt);
    const reservation = new Decimal(attempt.reservedUsd);
    if (!reservation.isFinite() || reservation.isNegative()) throw new Error('Invalid reservation.');
  }
  const generationKeys = ledger.db.prepare("SELECT key FROM immutable WHERE substr(key,1,?)=? AND (key LIKE '%:generation-result' OR key LIKE '%:generation-context')").all(prefix.length, prefix);
  if (generationKeys.length) throw new Error('Generation checkpoints must be absent.');
  const payment = attempts.filter(attempt => attempt.error === 'HTTP 402' && attempt.model === manifest.config.models.jev && ['window', 'reduction'].includes(attempt.operation));
  if (!payment.length) throw new Error('No recorded HTTP 402 payment-halt evidence.');
  const counts = (schedule: ScheduledRun[]) => ({ scheduled: schedule.length, recorded: schedule.filter(row => runs.has(row.id)).length,
    completed: schedule.filter(row => runs.get(row.id)?.status === 'completed').length,
    failed: schedule.filter(row => runs.get(row.id)?.status === 'failed').length,
    interrupted: schedule.filter(row => runs.get(row.id)?.status === 'interrupted').length,
    remaining: schedule.filter(row => !runs.has(row.id)).length });
  const later = manifest.schedule.filter(row => isRetrieval(row.method) && row.round > 0), timing = manifest.schedule.filter(row => isRetrieval(row.method) && row.timingSample);
  const laterCounts = counts(later), timingCounts = counts(timing);
  if (!laterCounts.remaining && !laterCounts.interrupted) throw new Error('Later timing is already terminal; this helper is only for halted incomplete timing.');
  const unknown = attempts.filter(attempt => attempt.costUsd === null);
  return { retrievalQualityComplete: true, timingComplete: false, ragasEligible: false,
    allScheduled: counts(manifest.schedule), primaryBase: counts(base), laterRetrieval: laterCounts, timing: timingCounts,
    controls: counts(manifest.schedule.filter(row => !isRetrieval(row.method))),
    remainingRunIds: manifest.schedule.filter(row => !runs.has(row.id)).map(row => row.id),
    interruptedRunIds: [...runs.values()].filter(run => run.status === 'interrupted').map(run => run.id),
    generation: { scheduled: manifest.schedule.filter(row => row.generate).length, completed: 0, attempted: 0, status: 'not-started' },
    haltEvidence: { payment402Attempts: payment.length, payment402RunIds: [...new Set(payment.map(attempt => attempt.runId))], payment402AttemptIds: payment.map(attempt => attempt.id) },
    accounting: { knownObservedUsd: attempts.reduce((sum, attempt) => sum.add(attempt.costUsd ?? 0), new Decimal(0)).toFixed(),
      unknownCostAttempts: unknown.length, unresolvedReservationUsd: unknown.reduce((sum, attempt) => sum.add(attempt.reservedUsd), new Decimal(0)).toFixed(),
      global: ledger.totals(), interpretation: 'Known observed charges and unresolved reservations are separate. Reservations are neither observed costs nor demonstrated upper bounds. No unrun assignment receives a fabricated failure or cost.' } };
}

/** Stable quality evidence only: no timing, billing, repetitions, or generation. */
export async function qualitySnapshot(report: ResearchReport, bundles: DatasetBundle[], manifest: ExperimentManifest) {
  const combined = combineBundles(bundles), questions = new Map(combined.questions.map(question => [question.id, question])), documents = new Map(combined.documents.map(document => [document.id, document]));
  const base = (report.perQuery as ScoredRun[]).filter(run => run.round === 0 && isRetrieval(run.method)).sort((a, b) => a.id.localeCompare(b.id));
  const prepared = new Map<string, PreparedDocument>(), retention: Array<NonNullable<ReturnType<typeof semanticRetention>>> = [];
  for (const run of base.filter(run => run.method === 'jev-scan' && run.status === 'completed' && run.metrics !== null)) {
    let document = prepared.get(run.documentId);
    if (!document) { document = await prepareDocument(documents.get(run.documentId)!, manifest.config.chunkTokens, manifest.config.overlapTokens, manifest.config.maxDocumentTokens); prepared.set(document.id, document); }
    const semantic = semanticRetention(run, document, questions.get(run.questionId)!)!;
    if (Math.abs(semantic.phases.at(-1)!.coverage - run.metrics!.coverage) > 1e-12) throw new Error('Semantic final coverage differs from frozen report quality.');
    retention.push({ ...semantic, phases: semantic.phases });
  }
  const retentionSummary = [...new Set(retention.map(row => row.corpus))].flatMap(corpus => ['initial-scan', 'first-selection', 'final-input', 'final-five'].map(phase => {
    const own = retention.filter(row => row.corpus === corpus), values = own.map(row => ({ documentId: row.documentId, value: row.phases.find(point => point.phase === phase)!.coverage }));
    return { corpus, phase, ...clusterBootstrap(values, manifest.config.bootstrapSamples, manifest.config.seed), nQuestions: own.length, nDocuments: new Set(own.map(row => row.documentId)).size };
  }));
  return { schemaVersion: 1, kind: 'halted-study-primary-quality', experimentId: report.experimentId, datasetHash: report.datasetHash, configHash: report.configHash, implementationHash: report.implementationHash, aggregation: report.aggregation,
    scope: 'All assigned base retrieval questions for all seven methods; failed answerable runs keep zero evidence. Completed-positive Jev base cohort only for semantic retention. No timing, cost, generation or unrun controls in this quality artifact.',
    methods: report.methods.map(({ id, corpus, coverage, coverageLow, coverageHigh, completeGold, oracleCoverage, normalizedCoverage, tokenPrecision, nQueries, nAnswerable, failures }) => ({ id, corpus, coverage, coverageLow, coverageHigh, completeGold, oracleCoverage, normalizedCoverage, tokenPrecision, nQueries, nAnswerable, failures })),
    perQueryBase: base.map(({ id, questionId, documentId, corpus, method, round, status, ranking, metrics }) => ({ id, questionId, documentId, corpus, method, round, status, ranking, metrics })),
    pairedComparisons: report.pairedComparisons, bookSensitivity: report.bookSensitivity, semanticRetentionPerQuery: retention, semanticRetentionSummary: retentionSummary };
}

function present(path: string) { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

export async function snapshotHaltedReport(sourceDirectory: string, backupPath: string, outputDirectory: string) {
  const source = realpathSync(sourceDirectory), backup = realpathSync(backupPath), output = resolve(outputDirectory), parent = realpathSync(dirname(output));
  if (present(output)) throw new Error('Output directory must be NEW.');
  if (parent === source || parent.startsWith(source + sep)) throw new Error('Output must be outside the source experiment.');
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(backup + suffix)) throw new Error('Use a standalone consistent SQLite backup without sidecars.');
  const bytes = Object.fromEntries(METADATA.map(name => [name, readFileSync(join(source, name))])) as Record<typeof METADATA[number], Buffer>;
  const hashes = Object.fromEntries(METADATA.map(name => [name, sha256(bytes[name])])) as Record<typeof METADATA[number], string>;
  const manifest = JSON.parse(bytes['manifest.json'].toString()) as ExperimentManifest, bundles = JSON.parse(bytes['datasets.json'].toString()) as DatasetBundle[];
  const snapshot = JSON.parse(bytes['source-snapshot.json'].toString()) as ReturnType<typeof implementationSnapshot>;
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'measured') throw new Error('Only frozen measured experiments are eligible.');
  if (hashObject(manifest.config) !== manifest.configHash) throw new Error('Config hash mismatch.');
  if (snapshot.hash !== manifest.implementationHash || hashObject(snapshot.files) !== snapshot.hash || implementationSnapshot().hash !== snapshot.hash) throw new Error('Frozen/current implementation hash mismatch.');
  const combined = combineBundles(bundles);
  if (combined.datasetHash !== manifest.datasetHash || stableJson(bundles.map(bundle => bundle.freeze.hash)) !== stableJson(manifest.datasetHashes)) throw new Error('Dataset hash mismatch.');
  if (stableJson(makeSchedule(bundles, manifest.config, manifest.id, manifest.phase)) !== stableJson(manifest.schedule)) throw new Error('Frozen schedule mismatch.');
  const backupHash = sha256(readFileSync(backup)), temporary = mkdtempSync(join(parent, '.halted-snapshot-'));
  let ledger: ReadonlyReportLedger | undefined;
  try {
    const copied = join(temporary, 'ledger-snapshot.sqlite'); copyFileSync(backup, copied);
    if (sha256(readFileSync(copied)) !== backupHash) throw new Error('Backup changed while copied.');
    ledger = new ReadonlyReportLedger(copied);
    if (String(Object.values(ledger.db.prepare('PRAGMA integrity_check').get()!)[0]) !== 'ok') throw new Error('SQLite integrity check failed.');
    const stage = validateHaltedStage(manifest, ledger);
    for (const document of combined.documents) if (!ledger.get(`${manifest.id}:preparation:${document.id}`)) throw new Error('Missing preparation checkpoint.');
    const report = await evaluateExperiment(manifest, bundles, ledger.evaluationView());
    if (report.missingScheduledRuns !== stage.allScheduled.remaining || (report.perQuery as unknown[]).length !== stage.allScheduled.recorded) throw new Error('Frozen evaluator changed the actual incomplete run count.');
    const quality = await qualitySnapshot(report, bundles, manifest);
    ledger.close(); ledger = undefined;
    if (sha256(readFileSync(copied)) !== backupHash || sha256(readFileSync(backup)) !== backupHash || METADATA.some(name => sha256(readFileSync(join(source, name))) !== hashes[name])) throw new Error('Source/private backup changed during evaluation.');
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(copied + suffix, { force: true });
    for (const name of METADATA) writeFileSync(join(temporary, name), bytes[name], { flag: 'wx', mode: 0o600 });
    writeJson(join(temporary, 'report.json'), report, true); writeJson(join(temporary, 'primary-quality.json'), quality, true);
    const evidence = { schemaVersion: 1, kind: 'halted-study-snapshot', stage: 'halted-http402-primary-quality-complete', ...stage,
      experimentId: manifest.id, datasetHash: manifest.datasetHash, implementationHash: manifest.implementationHash,
      purpose: 'Primary quality only after an HTTP 402 halt. Timing incomplete; generation not started; not eligible for RAGAS or complete-study analysis.',
      source: { directory: source, backup, hashes }, ledgerSnapshot: { file: 'ledger-snapshot.sqlite', sha256: backupHash },
      reportSha256: sha256(readFileSync(join(temporary, 'report.json'))), primaryQualitySha256: hashObject(quality),
      primaryQualityFileSha256: sha256(readFileSync(join(temporary, 'primary-quality.json'))), snapshotScriptSha256: sha256(readFileSync(new URL(import.meta.url))),
      qualityHelperSha256: sha256(readFileSync(new URL('./study-readout.ts', import.meta.url))),
      finalization: 'Compare hashObject(await qualitySnapshot(finalReport,bundles,manifest)) with primaryQualitySha256 before replacing primary evidence. All original metadata and incomplete scheduled counts are preserved.' };
    writeJson(join(temporary, 'snapshot-stage.json'), evidence, true);
    mkdirSync(output, { mode: 0o700 }); renameSync(temporary, output);
    return { directory: output, primaryQualitySha256: evidence.primaryQualitySha256, ...stage };
  } finally { ledger?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, backup, output, extra] = process.argv.slice(2);
  if (!source || !backup || !output || extra) throw new Error('Usage: tsx research/scripts/snapshot-halted-report.ts SOURCE_DIR BACKUP_SQLITE NEW_DIR');
  console.log(await snapshotHaltedReport(source, backup, output));
}
