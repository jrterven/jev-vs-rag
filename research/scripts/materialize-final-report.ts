/** Recover final reporting offline after the frozen CLI's pretty JSON string failed.
 * No measurement is rerun. The frozen evaluator is unchanged; only serialization differs.
 * tsx research/scripts/materialize-final-report.ts EXPERIMENT_DIR CLOSED_BACKUP NEW_REPORT NEW_RECEIPT
 */
import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { implementationSnapshot } from '../implementation.js';
import { evaluateExperiment } from '../report.js';
import { combineBundles, makeSchedule, type ExperimentManifest } from '../runner.js';
import type { DatasetBundle, QueryRun } from '../types.js';
import { hashObject, stableJson } from '../util.js';
import { continuationOutcomes } from './verify-study-continuation.js';
import { ReadonlyReportLedger } from './snapshot-retrieval-report.js';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function fileHash(path: string) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); return hash.digest('hex'); }
  finally { closeSync(fd); }
}

/** JSON.stringify semantics for JSON data, without constructing an aggregate string.
 * Report values are plain records, arrays and primitives. Unsupported object types
 * and cycles fail instead of silently changing data. Atomic exclusive publication.
 */
export function writeCompactJsonExclusive(path: string, value: unknown, maxBytes = bufferConstants.MAX_STRING_LENGTH - 1) {
  const output = resolve(path);
  check(!existsSync(output), 'Report output already exists; never replacing measured evidence.');
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'Invalid consumer byte limit.');
  const temporary = mkdtempSync(join(dirname(output), '.compact-report-')), staged = join(temporary, 'report.json');
  const fd = openSync(staged, 'wx', 0o600), hash = createHash('sha256'), ancestors = new Set<object>();
  let pieces: string[] = [], bufferedCharacters = 0, bytes = 0, closed = false;
  const flush = () => {
    if (!pieces.length) return;
    const block = Buffer.from(pieces.join('')); pieces = []; bufferedCharacters = 0;
    let offset = 0; while (offset < block.length) offset += writeSync(fd, block, offset, block.length - offset);
    hash.update(block); bytes += block.length;
  };
  const emit = (piece: string) => { pieces.push(piece); bufferedCharacters += piece.length; if (bufferedCharacters >= 64 * 1024) flush(); };
  const visit = (node: unknown, inArray = false) => {
    if (node === undefined || typeof node === 'function' || typeof node === 'symbol') { if (inArray) emit('null'); else throw new Error('Unsupported root JSON value.'); return; }
    if (node === null || typeof node !== 'object') { const scalar = JSON.stringify(node); check(scalar !== undefined, 'Unsupported JSON scalar.'); emit(scalar); return; }
    check(!ancestors.has(node), 'Cyclic report data cannot be serialized.');
    check(Array.isArray(node) || Object.getPrototypeOf(node) === Object.prototype || Object.getPrototypeOf(node) === null, 'Only plain JSON report objects are supported.');
    check(!('toJSON' in node), 'Custom JSON serialization is not permitted in report data.');
    ancestors.add(node);
    if (Array.isArray(node)) {
      emit('['); for (let i = 0; i < node.length; i++) { if (i) emit(','); visit(node[i], true); } emit(']');
    } else {
      emit('{'); let count = 0;
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (count++) emit(','); emit(JSON.stringify(key)); emit(':'); visit(child);
      }
      emit('}');
    }
    ancestors.delete(node);
  };
  try {
    visit(value); emit('\n'); flush(); fsyncSync(fd); closeSync(fd); closed = true;
    const sha256 = hash.digest('hex');
    check(statSync(staged).size === bytes && fileHash(staged) === sha256, 'Streamed report checksum/size mismatch.');
    check(bytes <= maxBytes, `Compact report is ${bytes} bytes, above the ${maxBytes}-byte consumer limit; no final report was published. Data were not truncated.`);
    // Hard link fails if output appeared concurrently; unlike rename, it never replaces it.
    linkSync(staged, output);
    return { path: output, bytes, sha256, maxConsumerBytes: maxBytes, format: 'compact-json-stream-v1', jsonSemantics: 'All report fields and arrays retained, including complete candidate traces; whitespace differs only.' };
  } finally { if (!closed) closeSync(fd); rmSync(temporary, { recursive: true, force: true }); }
}

export async function materializeFinalReport(directory: string, backupPath: string, reportPath: string, receiptPath: string) {
  const source = resolve(directory), backup = resolve(backupPath), output = resolve(reportPath), receipt = resolve(receiptPath);
  check(!existsSync(output) && !existsSync(receipt) && output !== receipt, 'Report and receipt paths must both be new.');
  check(existsSync(dirname(output)) && existsSync(dirname(receipt)), 'Report and receipt parent directories must already exist.');
  for (const suffix of ['-wal', '-journal']) check(!existsSync(backup + suffix) || statSync(backup + suffix).size === 0, 'Use a closed standalone consistent ledger backup.');
  const names = ['manifest.json', 'datasets.json', 'source-snapshot.json'], metadataHashes = Object.fromEntries(names.map(name => [name, fileHash(join(source, name))]));
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as ExperimentManifest;
  const bundles = JSON.parse(readFileSync(join(source, 'datasets.json'), 'utf8')) as DatasetBundle[];
  const snapshot = JSON.parse(readFileSync(join(source, 'source-snapshot.json'), 'utf8'));
  check(manifest.kind === 'measured' && hashObject(manifest.config) === manifest.configHash, 'Measured frozen configuration required.');
  check(snapshot.hash === manifest.implementationHash && hashObject(snapshot.files) === snapshot.hash && implementationSnapshot().hash === snapshot.hash, 'Frozen evaluator implementation mismatch.');
  const combined = combineBundles(bundles);
  check(combined.datasetHash === manifest.datasetHash && stableJson(bundles.map(bundle => bundle.freeze.hash)) === stableJson(manifest.datasetHashes), 'Frozen dataset mismatch.');
  check(stableJson(makeSchedule(bundles, manifest.config, manifest.id, manifest.phase)) === stableJson(manifest.schedule), 'Frozen schedule mismatch.');
  const backupHash = fileHash(backup), temporary = mkdtempSync(join(tmpdir(), 'final-report-ledger-'));
  let ledger: ReadonlyReportLedger | undefined;
  try {
    const copied = join(temporary, 'ledger.sqlite'); copyFileSync(backup, copied);
    check(fileHash(copied) === backupHash, 'Backup changed while being copied.');
    ledger = new ReadonlyReportLedger(copied);
    check(String(Object.values(ledger.db.prepare('PRAGMA integrity_check').get()!)[0]) === 'ok', 'Ledger integrity check failed.');
    check(hashObject(ledger.get(`experiment:${manifest.id}`)) === hashObject(manifest), 'Immutable ledger manifest mismatch.');
    check(ledger.attempts().every(attempt => attempt.status !== 'pending'), 'Pending API attempt remains; reporting is not final.');
    const rows = ledger.runRows().filter(row => row.id.startsWith(manifest.id + ':'));
    check(rows.length === manifest.schedule.length && rows.every(row => ['completed', 'failed'].includes(row.status)), 'Retrieval schedule is not fully terminal.');
    const assigned = new Map(manifest.schedule.map(run => [run.id, run]));
    for (const row of rows) {
      const run = JSON.parse(row.value) as QueryRun & { generate?: boolean }, planned = assigned.get(row.id);
      check(planned && run.id === row.id && run.status === row.status, 'Ledger retrieval identity/status mismatch.');
      for (const key of ['questionId', 'documentId', 'corpus', 'method', 'round', 'timingSample', 'generate'] as const) check(run[key] === planned[key], 'Ledger retrieval differs from frozen schedule.');
    }
    const report = await evaluateExperiment(manifest, bundles, ledger.evaluationView());
    // This validates terminal generation; the later continuation audit compares real old runs.
    const outcomes = continuationOutcomes(manifest, { ...report, perQuery: [] }, report);
    ledger.close(); ledger = undefined;
    check(fileHash(copied) === backupHash && fileHash(backup) === backupHash, 'Read-only input ledger changed during evaluation.');
    for (const name of names) check(fileHash(join(source, name)) === metadataHashes[name], 'Metadata changed during evaluation.');
    const serialized = writeCompactJsonExclusive(output, report);
    const record = { schemaVersion: 1, kind: 'offline-final-report-materialization', experimentId: manifest.id,
      measuredDataUnchanged: true, providerCalls: 0, evaluatorImplementationHash: manifest.implementationHash,
      source: { directory: source, metadataHashes, ledger: backup, ledgerSha256: backupHash }, report: serialized,
      recovery: 'Original CLI exit/log must be retained. Frozen pretty JSON serialization uses one V8 string; this auxiliary exporter changes whitespace only and streams the complete unchanged evaluator output.',
      evaluator: 'research/report.ts:evaluateExperiment', materializerSha256: fileHash(fileURLToPath(import.meta.url)),
      retrieval: outcomes.finalRetrieval, generation: { ...outcomes.generation, perRun: undefined },
      limits: { nodeMaxStringLength: bufferConstants.MAX_STRING_LENGTH, downstreamReadFileUtf8SafeConservativeByteCheck: true } };
    writeFileSync(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return record;
  } finally { ledger?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, backup, report, receipt, extra] = process.argv.slice(2);
  if (!directory || !backup || !report || !receipt || extra) throw new Error('Usage: tsx research/scripts/materialize-final-report.ts EXPERIMENT_DIR CLOSED_BACKUP NEW_REPORT NEW_RECEIPT');
  console.log(await materializeFinalReport(directory, backup, report, receipt));
}
