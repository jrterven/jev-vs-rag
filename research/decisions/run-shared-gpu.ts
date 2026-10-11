/** Authorized shared-GPU continuation; original scientific adapters stay frozen. */
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as dotenv } from 'dotenv';
import { combineBundles } from '../runner.js';
import { prepareDocument } from '../datasets.js';
import { probeGpu } from '../hardware.js';
import { Ledger } from '../ledger.js';
import { Methods } from '../methods.js';
import { hashObject, readJson, sha256, writeJson } from '../util.js';
import type { PreparedDocument, RankedChunk } from '../types.js';
import { EXTENSION, searchDecisions, SCOPE } from './adapter-v2.js';
import { generate, type ExtensionRun as FrozenRun } from './generation.js';
import { plan } from './run-v2.js';
import { sharedGpuCheck, SHARED_TIMING } from './shared-gpu-policy.js';

const ROOT = resolve('data/research', EXTENSION, 'v2');
const BASE = resolve('data/research/gb10-main-study-20261004-v1');
const RECORDS = join(ROOT, 'main-continuation-20261007-v1');
type Manifest = ReturnType<typeof plan>['manifest'];
type ExtensionRun = FrozenRun & Partial<typeof SHARED_TIMING>;
function operationalRecord() {
  const path = join(RECORDS, 'preflight.json'), value = readJson<any>(path);
  if (value.policyId !== 'juan-authorized-shared-gpu-20261007-v1'
    || sha256(readFileSync('research/decisions/run-shared-gpu.ts')) !== value.source.sharedRunnerSha256
    || sha256(readFileSync('research/decisions/shared-gpu-policy.ts')) !== value.source.sharedPolicySha256)
    throw new Error('PROVENANCE: shared GPU continuation source/policy differs.');
  return { policyId: value.policyId, preflightSha256: sha256(readFileSync(path)), source: value.source,
    authorization: value.authorization, timing: SHARED_TIMING, remainingIds: value.before.remainingIds };
}
function readRuns(ledger: Ledger, prefix: string): ExtensionRun[] {
  return (ledger.db.prepare("SELECT value FROM runs WHERE substr(id,1,?)=? AND status!='running' ORDER BY rowid").all(prefix.length, prefix) as Array<{ value: string }>).map(r => JSON.parse(r.value));
}
function saveRun(ledger: Ledger, run: ExtensionRun) {
  const old = ledger.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string } | undefined;
  if (old?.status !== 'running') throw new Error('Only an active extension run can be settled; terminal rows are immutable.');
  ledger.db.prepare('UPDATE runs SET status=?,value=? WHERE id=?').run(run.status, JSON.stringify(run), run.id);
}
function writeReport(ledger: Ledger, directory: string, manifest: Manifest) {
  const runs = readRuns(ledger, manifest.id + ':').map(run => ({ ...run, ...ledger.get(`${run.id}:generation-result`) as object | undefined }));
  const fd = openSync(join(directory, 'report.json'), 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify({ schemaVersion: 1, kind: 'measured', datasetHash: manifest.datasetHash, configHash: manifest.configHash, implementationHash: manifest.implementationHash, extension: manifest.extension, operationalContinuation: operationalRecord() }).slice(0, -1) + ',"perQuery":[\n');
    for (const [i, run] of runs.entries()) writeSync(fd, (i ? ',\n' : '') + JSON.stringify(run));
    writeSync(fd, '\n]}\n');
  } finally { closeSync(fd); }
  return runs;
}
export async function run(phase: 'pilot' | 'main', allowPaid: boolean) {
  if (phase !== 'main') throw new Error('Shared continuation is only for the frozen test main.');
  const operational = operationalRecord();
  const { directory, manifest, bundles } = plan(phase), prefix = manifest.id + ':';
  if (!allowPaid) throw new Error('Paid execution requires --allow-paid.');
  if (phase === 'main') {
    const gate = readJson<{ accepted: boolean; implementationHash: string }>(join(ROOT, 'pilot-budget-gate.json'));
    if (!gate.accepted || gate.implementationHash !== manifest.implementationHash) throw new Error('Pilot budget/access gate not passed with this source.');
  }
  const lock = join(ROOT, 'running.lock'); writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const signalController = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => signalController.abort(new Error(name)));
  const signal = signalController.signal, ledger = new Ledger(resolve('data/research/study-budget.sqlite'));
  const methods = new Methods({ config: manifest.config, ledger, experimentId: manifest.id, cacheDir: join(BASE, 'cache'), mock: false, allowPaid: false, signal });
  let exitError: string | undefined;
  try {
    if (ledger.pendingRuns().some(id => id.startsWith(EXTENSION)) || ledger.attempts().some(a => a.status === 'pending')) throw new Error('Unresolved run/API attempt; audit before continuation.');
    ledger.freeze(`experiment:${manifest.id}`, manifest);
    ledger.freeze(`${manifest.id}:shared-gpu-continuation`, operational);
    const runtime = await methods.initialize(); ledger.freeze(`${manifest.id}:local-runtime`, runtime);
    const gpuCheck = () => sharedGpuCheck(probeGpu());
    gpuCheck();
    const combined = combineBundles(bundles), neededDocs = new Set(manifest.schedule.map(r => r.documentId));
    const docs = new Map<string, PreparedDocument>(), questions = new Map(combined.questions.map(q => [q.id, q]));
    for (const frozen of combined.documents.filter(d => neededDocs.has(d.id))) {
      signal.throwIfAborted();
      const doc = await prepareDocument(frozen, manifest.config.chunkTokens, manifest.config.overlapTokens, manifest.config.maxDocumentTokens);
      await methods.prepare(doc); docs.set(doc.id, doc);
      console.log(JSON.stringify({ phase: 'prepare', documentId: doc.id, count: docs.size, total: neededDocs.size }));
    }
    const done = new Set(readRuns(ledger, prefix).map(r => r.id)); let failures = 0;
    for (const row of manifest.schedule) {
      if (done.has(row.id)) continue;
      if (!operational.remainingIds.includes(row.id)) throw new Error('PROVENANCE: unscheduled continuation case.');
      signal.throwIfAborted(); gpuCheck();
      const question = questions.get(row.questionId)!, doc = docs.get(row.documentId)!;
      const startedAt = new Date().toISOString(); ledger.startRun(row.id, { ...row, startedAt });
      let measuredStart = performance.now(), result: ExtensionRun;
      try {
        if (row.timingSample) ledger.freeze(`${row.id}:gpu-before`, gpuCheck());
        measuredStart = performance.now();
        let chunks = doc.chunks, prior = { phases: {}, traces: [] } as { phases: Record<string, number>; traces: ExtensionRun['traces'] };
        if (row.method === 'hybrid-decisions') {
          prior = await methods.search('hybrid', question, doc, row.id, row.round);
          const candidates = prior.traces.find(t => t.stage === 'hybrid50')!.retainedIds;
          const originalId = 'gb10-main-study-20261004-v1';
          const original = ledger.get<RankedChunk[]>(`${originalId}:shared50:${question.id}:${row.round}`);
          if (!original || hashObject(original.map(c => c.chunkId)) !== hashObject(candidates)) throw new Error('PROVENANCE: original hybrid candidate IDs differ or are absent.');
          chunks = doc.chunks.filter(c => candidates.includes(c.id)).sort((a, b) => a.ordinal - b.ordinal);
          if (chunks.length !== candidates.length) throw new Error('PROVENANCE: missing hybrid chunks.');
        }
        const found = await searchDecisions({ config: manifest.config, ledger, runId: row.id, documentId: doc.id, method: row.method, chunks, query: question.question, signal, allowPaid });
        result = { ...row, ...found, phases: { ...prior.phases, ...found.phases }, traces: [...prior.traces, ...found.traces], status: 'completed', startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - measuredStart, ...SHARED_TIMING };
        if (row.timingSample) ledger.freeze(`${row.id}:gpu-after`, gpuCheck());
        failures = 0;
      } catch (error) {
        result = { ...row, ranking: [], phases: {}, traces: ledger.traces(row.id), status: signal.aborted ? 'interrupted' : 'failed', startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - measuredStart, ...SHARED_TIMING, error: error instanceof Error ? error.message : String(error) };
        if (!result.error?.startsWith('DECISIONS_REFUSAL')) failures++; else failures = 0;
      }
      saveRun(ledger, result); done.add(row.id);
      const totals = ledger.totals(SCOPE.runPrefix);
      writeJson(join(ROOT, 'progress.json'), { updatedAt: new Date().toISOString(), phase, stage: 'retrieval', terminal: done.size, planned: manifest.schedule.length, last: { id: row.id, status: result.status, elapsedMs: result.elapsedMs, error: result.error }, extensionBudget: totals });
      console.log(JSON.stringify({ stage: 'retrieval', terminal: done.size, planned: manifest.schedule.length, method: row.method, status: result.status, ms: result.elapsedMs, error: result.error }));
      if (failures >= 3 || signal.aborted || /PROVENANCE|occupied|unavailable|budget|401|402|403/i.test(result.error ?? '')) throw new Error(result.error ?? 'Three consecutive failures.');
    }
    methods.close();
    const runs = new Map(readRuns(ledger, prefix).map(r => [r.id, r]));
    failures = 0; let generationTerminal = 0;
    for (const row of manifest.schedule.filter(r => r.generate)) {
      if (ledger.get(`${row.id}:generation-result`)) { generationTerminal++; continue; }
      signal.throwIfAborted(); const retrieved = runs.get(row.id)!;
      if (retrieved.status !== 'completed') { ledger.freeze(`${row.id}:generation-result`, { generationError: 'Retrieval unavailable: ' + retrieved.status }); generationTerminal++; continue; }
      try {
        const value = await generate(manifest.config, ledger, questions.get(row.questionId)!, docs.get(row.documentId)!, retrieved, signal, allowPaid);
        ledger.freeze(`${row.id}:generation-result`, { generation: value }); failures = 0;
      } catch (error) { ledger.freeze(`${row.id}:generation-result`, { generationError: error instanceof Error ? error.message : String(error) }); failures++; }
      generationTerminal++;
      writeJson(join(ROOT, 'progress.json'), { updatedAt: new Date().toISOString(), phase, stage: 'generation', terminal: generationTerminal, planned: manifest.schedule.filter(r => r.generate).length, extensionBudget: ledger.totals(SCOPE.runPrefix) });
      console.log(JSON.stringify({ stage: 'generation', terminal: generationTerminal, planned: manifest.schedule.filter(r => r.generate).length }));
      if (failures >= 3 || signal.aborted) throw new Error('Generation halted after three failures or abort.');
    }
  } catch (error) { exitError = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    methods.close();
    const rows = writeReport(ledger, directory, manifest);
    writeJson(join(directory, 'completion.json'), { recordedAt: new Date().toISOString(), allRetrievalTerminal: rows.length === manifest.schedule.length, retrievalCompleted: rows.filter(r => r.status === 'completed').length, retrievalFailed: rows.filter(r => r.status !== 'completed').length, planned: manifest.schedule.length, generationComplete: rows.filter(r => r.generation).length, generationTerminal: manifest.schedule.filter(r => r.generate && ledger.get(`${r.id}:generation-result`)).length, generationPlanned: manifest.schedule.filter(r => r.generate).length, global: ledger.totals(), extension: ledger.totals(SCOPE.runPrefix), exitError: exitError ?? null });
    ledger.close(); unlinkSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  dotenv({ path: 'data/research/api.env', quiet: true });
  const action = process.argv[2], phase = process.argv[3];
  if (!['pilot', 'main'].includes(phase)) throw new Error('Usage: run-v2.ts plan|run pilot|main [--allow-paid]');
  if (action === 'plan') { const p = plan(phase as 'pilot' | 'main'); console.log(JSON.stringify({ directory: p.directory, runs: p.manifest.schedule.length, hash: hashObject(p.manifest) })); }
  else if (action === 'run') await run(phase as 'pilot' | 'main', process.argv.includes('--allow-paid'));
  else throw new Error('Unknown action.');
}
