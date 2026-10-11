/** Evaluate completed retrieval from a standalone backup while generation is partial.
 * Never opens the live manifest.budgetPath, instantiates Ledger, or calls a provider.
 * Usage: tsx research/scripts/snapshot-retrieval-report.ts SOURCE_DIR BACKUP_SQLITE NEW_DIR
 * NEW_DIR must not exist; its parent must exist and be outside SOURCE_DIR.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Decimal } from 'decimal.js';
import type { Ledger, PaidAttempt } from '../ledger.js';
import { evaluateExperiment } from '../report.js';
import { combineBundles, makeSchedule, type ExperimentManifest } from '../runner.js';
import { implementationSnapshot } from '../implementation.js';
import type { DatasetBundle, QueryRun, ResearchReport } from '../types.js';
import { hashObject, sha256, stableJson, writeJson } from '../util.js';

const METADATA = ['manifest.json', 'datasets.json', 'source-snapshot.json'] as const;
type RunRow = { id: string; status: string; value: string };
type GenerationResult = { generation?: NonNullable<QueryRun['generation']>; generationError?: string };

/** A read-only connection to the private copy only. No write-capable Ledger exists. */
export class ReadonlyReportLedger {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    try { this.db.exec('PRAGMA query_only=ON; BEGIN'); }
    catch (error) { this.db.close(); throw error; }
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value,hash FROM immutable WHERE key=?').get(key) as { value: string; hash: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.value) as T;
    if (hashObject(value) !== row.hash) throw new Error(`Stored checkpoint hash mismatch: ${key}`);
    return value;
  }
  runRows(): RunRow[] {
    return this.db.prepare('SELECT id,status,value FROM runs ORDER BY rowid').all() as RunRow[];
  }
  runs(): QueryRun[] {
    return this.runRows().filter(row => row.status !== 'running').map(row => JSON.parse(row.value) as QueryRun);
  }
  attempts(): PaidAttempt[] {
    const rows = this.db.prepare('SELECT id,value FROM attempts ORDER BY rowid').all() as Array<{ id: string; value: string }>;
    return rows.map(row => {
      const value = JSON.parse(row.value) as PaidAttempt;
      if (value.id !== row.id) throw new Error('Attempt SQL/JSON identity mismatch.');
      return value;
    });
  }
  totals() {
    let known = new Decimal(0), reserved = new Decimal(0), unknown = 0;
    for (const attempt of this.attempts()) {
      const value = new Decimal(attempt.costUsd ?? attempt.reservedUsd);
      if (!value.isFinite() || value.isNegative()) throw new Error('Invalid global ledger cost/reservation.');
      if (attempt.costUsd === null) { reserved = reserved.add(value); unknown++; }
      else known = known.add(value);
    }
    return { knownUsd: known.toFixed(), reservedUsd: reserved.toFixed(), committedUsd: known.add(reserved).toFixed(), unknownAttempts: unknown };
  }
  /** evaluateExperiment only consumes these four read methods; future writes fail closed. */
  evaluationView(): Ledger {
    return Object.freeze({ get: this.get.bind(this), runs: this.runs.bind(this), attempts: this.attempts.bind(this), totals: this.totals.bind(this) }) as unknown as Ledger;
  }
  close() { this.db.close(); }
}

export function validateSnapshotStage(manifest: ExperimentManifest, ledger: ReadonlyReportLedger) {
  const frozen = ledger.get<ExperimentManifest>(`experiment:${manifest.id}`);
  if (!frozen || hashObject(frozen) !== hashObject(manifest)) throw new Error('Manifest differs from immutable ledger experiment.');
  const prefix = manifest.id + ':', assigned = new Map(manifest.schedule.map(row => [row.id, row]));
  if (assigned.size !== manifest.schedule.length || !assigned.size) throw new Error('Invalid or duplicate scheduled run IDs.');
  const rows = ledger.runRows().filter(row => row.id.startsWith(prefix));
  const runs = new Map<string, QueryRun>();
  for (const row of rows) {
    if (row.status === 'running' || row.status === 'interrupted') throw new Error(`Retrieval is incomplete: ${row.status} run ${row.id}`);
    if (!['completed', 'failed'].includes(row.status)) throw new Error('Unknown retrieval run status.');
    const run = JSON.parse(row.value) as QueryRun & { generate?: boolean }, scheduled = assigned.get(row.id);
    if (row.id !== run.id || row.status !== run.status) throw new Error('Run SQL/JSON identity or status mismatch.');
    if (!scheduled || runs.has(run.id)) throw new Error('Unexpected or duplicate retrieval run.');
    for (const key of ['questionId', 'documentId', 'corpus', 'method', 'round', 'timingSample', 'generate'] as const) {
      if (run[key] !== scheduled[key]) throw new Error(`Run differs from frozen schedule: ${key}`);
    }
    if (run.generation !== undefined || run.generationError !== undefined) throw new Error('Raw retrieval row must not contain mutable generation results.');
    runs.set(run.id, run);
  }
  if (runs.size !== assigned.size || [...assigned.keys()].some(id => !runs.has(id))) throw new Error('Retrieval is incomplete: missing scheduled retrieval/control runs.');
  const attempts = ledger.attempts().filter(attempt => attempt.runId.startsWith(prefix));
  const operations = new Set(['document_embedding', 'structure', 'query_embedding', 'window', 'reduction', 'generation']);
  for (const attempt of attempts) {
    if (!operations.has(attempt.operation) || !['pending', 'completed', 'failed', 'unknown'].includes(attempt.status)) throw new Error('Unknown paid operation/status.');
    if (attempt.status === 'pending' && attempt.operation !== 'generation') throw new Error('Retrieval/preparation has a pending paid attempt.');
    if (attempt.operation === 'generation') {
      const scheduled = assigned.get(attempt.runId);
      if (!scheduled?.generate || scheduled.method !== attempt.method || scheduled.documentId !== attempt.documentId || runs.get(attempt.runId)?.status !== 'completed') throw new Error('Generation attempt has no eligible frozen assignment.');
    }
  }
  let completed = 0, errors = 0, pendingEligible = 0, unavailableRetrieval = 0;
  for (const scheduled of manifest.schedule.filter(row => row.generate)) {
    const result = ledger.get<GenerationResult>(`${scheduled.id}:generation-result`), run = runs.get(scheduled.id)!;
    if (run.status === 'failed') {
      if (result !== undefined) throw new Error('Failed retrieval unexpectedly has a generation result.');
      unavailableRetrieval++;
    } else if (result === undefined) pendingEligible++;
    else {
      const success = result.generation !== undefined, error = typeof result.generationError === 'string';
      if (success === error || Object.keys(result).some(key => key !== 'generation' && key !== 'generationError')) throw new Error('Malformed immutable generation result.');
      if (success) completed++; else errors++;
    }
  }
  const pending = attempts.filter(attempt => attempt.operation === 'generation' && attempt.status === 'pending');
  if (pending.some(attempt => ledger.get(`${attempt.runId}:generation-result`) !== undefined)) throw new Error('Pending generation attempt already has a terminal result.');
  if (!pendingEligible) throw new Error('Generation is already terminal; use the final reporting workflow.');
  return {
    retrieval: { scheduled: assigned.size, recorded: runs.size, completed: [...runs.values()].filter(run => run.status === 'completed').length,
      failed: [...runs.values()].filter(run => run.status === 'failed').length, running: 0, interrupted: 0, missing: 0,
      nonGenerationAttemptsSha256: hashObject(attempts.filter(attempt => attempt.operation !== 'generation')) },
    generation: { status: 'incomplete-at-backup', scheduled: manifest.schedule.filter(row => row.generate).length,
      completed, errors, pendingEligible, unavailableRetrieval, pendingApiAttempts: pending.length,
      pendingReservationUsd: pending.reduce((sum, attempt) => sum.add(attempt.reservedUsd), new Decimal(0)).toFixed(),
      interpretation: 'Pending/in-progress generation at this backup; process liveness is not inferred. Missing results may include calls whose response preceded their immutable result checkpoint.' },
  };
}

/** Compare this fingerprint with the final report: generation/global billing may change. */
export function primaryRetrievalFingerprint(report: ResearchReport): string {
  const perQuery = report.perQuery as Array<QueryRun & { metrics: unknown }>;
  return hashObject({ experimentId: report.experimentId, datasetHash: report.datasetHash, configHash: report.configHash,
    implementationHash: report.implementationHash, aggregation: report.aggregation, missingScheduledRuns: report.missingScheduledRuns,
    methods: report.methods.map(({ unknownCostAttempts: _unknown, projections: _projections, ...primary }) => primary),
    perQuery: perQuery.map(({ generation: _generation, generationError: _error, ...primary }) => primary),
    pairedComparisons: report.pairedComparisons, bookSensitivity: report.bookSensitivity, retention: report.retention,
    timing: report.timing, preparation: report.preparation });
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function snapshotRetrievalReport(sourceDirectory: string, backupPath: string, outputDirectory: string) {
  const source = realpathSync(sourceDirectory), backup = realpathSync(backupPath), output = resolve(outputDirectory);
  if (present(output)) throw new Error('Output directory must be NEW; existing paths are never replaced.');
  const parent = realpathSync(dirname(output));
  if (parent === source || parent.startsWith(source + sep)) throw new Error('Output must be outside the source experiment directory.');
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(backup + suffix)) throw new Error('Use a standalone consistent backup without SQLite sidecars.');
  const bytes = Object.fromEntries(METADATA.map(name => [name, readFileSync(join(source, name))])) as Record<typeof METADATA[number], Buffer>;
  const hashes = Object.fromEntries(METADATA.map(name => [name, sha256(bytes[name])])) as Record<typeof METADATA[number], string>;
  const manifest = JSON.parse(bytes['manifest.json'].toString()) as ExperimentManifest;
  const bundles = JSON.parse(bytes['datasets.json'].toString()) as DatasetBundle[];
  const snapshot = JSON.parse(bytes['source-snapshot.json'].toString()) as ReturnType<typeof implementationSnapshot>;
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'measured') throw new Error('Only a frozen measured experiment is eligible.');
  if (hashObject(manifest.config) !== manifest.configHash) throw new Error('Config hash mismatch.');
  if (snapshot.hash !== manifest.implementationHash || hashObject(snapshot.files) !== snapshot.hash || implementationSnapshot().hash !== snapshot.hash) throw new Error('Frozen source snapshot/current evaluation implementation mismatch.');
  const combined = combineBundles(bundles);
  if (combined.datasetHash !== manifest.datasetHash || stableJson(bundles.map(bundle => bundle.freeze.hash)) !== stableJson(manifest.datasetHashes)) throw new Error('Frozen dataset hash mismatch.');
  if (stableJson(makeSchedule(bundles, manifest.config, manifest.id, manifest.phase)) !== stableJson(manifest.schedule)) throw new Error('Schedule differs from frozen dataset/config.');
  // A standalone copy prevents SQLite from creating even read-related sidecars at
  // the supplied backup path. Only this new private directory is ever writable.
  const backupHash = sha256(readFileSync(backup)), temporary = mkdtempSync(join(parent, '.retrieval-snapshot-'));
  let ledger: ReadonlyReportLedger | undefined;
  try {
    const copiedLedger = join(temporary, 'ledger-snapshot.sqlite');
    copyFileSync(backup, copiedLedger);
    if (sha256(readFileSync(copiedLedger)) !== backupHash) throw new Error('Backup changed while being copied.');
    ledger = new ReadonlyReportLedger(copiedLedger);
    if (String(Object.values(ledger.db.prepare('PRAGMA integrity_check').get()!)[0]) !== 'ok') throw new Error('SQLite integrity check failed.');
    const stage = validateSnapshotStage(manifest, ledger);
    for (const document of combined.documents) if (!ledger.get(`${manifest.id}:preparation:${document.id}`)) throw new Error('Missing immutable document preparation checkpoint.');
    const report = await evaluateExperiment(manifest, bundles, ledger.evaluationView());
    if (report.missingScheduledRuns !== 0 || (report.perQuery as unknown[]).length !== manifest.schedule.length) throw new Error('Evaluated report lost scheduled rows.');
    ledger.close(); ledger = undefined;
    if (sha256(readFileSync(copiedLedger)) !== backupHash) throw new Error('Private read-only backup changed unexpectedly.');
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(copiedLedger + suffix, { force: true });
    if (sha256(readFileSync(backup)) !== backupHash || METADATA.some(name => sha256(readFileSync(join(source, name))) !== hashes[name])) throw new Error('Source inputs changed during evaluation.');
    for (const name of METADATA) writeFileSync(join(temporary, name), bytes[name], { flag: 'wx', mode: 0o600 });
    writeJson(join(temporary, 'report.json'), report, true);
    const evidence = { schemaVersion: 1, kind: 'retrieval-report-snapshot', stage: 'retrieval-complete-generation-incomplete',
      purpose: 'Early primary retrieval analysis only; not for RAGAS, generation conclusions, or final billing.', ragasEligible: false,
      experimentId: manifest.id, datasetHash: manifest.datasetHash, implementationHash: manifest.implementationHash,
      source: { directory: source, backup, hashes }, ledgerSnapshot: { file: 'ledger-snapshot.sqlite', sha256: backupHash },
      reportSha256: sha256(readFileSync(join(temporary, 'report.json'))), primaryRetrievalSha256: primaryRetrievalFingerprint(report),
      snapshotScriptSha256: sha256(readFileSync(new URL(import.meta.url))), ...stage,
      finalization: 'Regenerate from the final backup and require an identical primaryRetrievalFingerprint before replacing primary figures; generation and experiment/global billing are partial here.' };
    writeJson(join(temporary, 'snapshot-stage.json'), evidence, true); // Written last: marks a complete snapshot artifact.
    // Exclusive creation also closes the check/rename race for pre-existing empty
    // directories. The following rename replaces only the empty directory we own.
    mkdirSync(output, { mode: 0o700 });
    renameSync(temporary, output);
    return { directory: output, reportSha256: evidence.reportSha256, primaryRetrievalSha256: evidence.primaryRetrievalSha256, ...stage };
  } finally { ledger?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, backup, output, extra] = process.argv.slice(2);
  if (!directory || !backup || !output || extra) throw new Error('Usage: tsx research/scripts/snapshot-retrieval-report.ts SOURCE_DIR BACKUP_SQLITE NEW_DIR');
  console.log(await snapshotRetrievalReport(directory, backup, output));
}
