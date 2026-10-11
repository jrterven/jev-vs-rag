import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem, platform, arch } from 'node:os';
import { config as dotenv } from 'dotenv';
import { Decimal } from 'decimal.js';
import { combineBundles, type ExperimentManifest, type ScheduledRun } from '../runner.js';
import { implementationSnapshot } from '../implementation.js';
import { prepareDocument } from '../datasets.js';
import { probeGpu } from '../hardware.js';
import { Ledger } from '../ledger.js';
import { Methods } from '../methods.js';
import { hashObject, readJson, sha256, shuffled, writeJson } from '../util.js';
import type { DatasetBundle, PreparedDocument, QueryRun, RankedChunk } from '../types.js';
import { DECISIONS_MODEL, DECISIONS_PRICE, EXTENSION, searchDecisions, SCOPE, type ExtensionMethod } from './adapter.js';
import { generate, type ExtensionRun } from './generation.js';

const ROOT = resolve('data/research', EXTENSION);
const BASE = resolve('data/research/gb10-main-study-20261004-v1');
const DEV = resolve('data/research/gb10-book-combined-pilot-20261004-v1');
type PlanRow = Omit<ScheduledRun, 'method'> & { method: ExtensionMethod };
type Manifest = Omit<ExperimentManifest, 'schedule'> & { schedule: PlanRow[]; extension: Record<string, unknown> };
function snapshot() {
  const base = implementationSnapshot();
  const files = { ...base.files, ...Object.fromEntries(['adapter.ts', 'generation.ts', 'run.ts', 'launch.py'].map(p => [`research/decisions/${p}`, readFileSync(`research/decisions/${p}`, 'utf8')])) };
  return { schemaVersion: 1, hash: hashObject(files), files };
}
export function extensionSchedule(base: ExperimentManifest, bundles: DatasetBundle[], phase: 'pilot' | 'main'): PlanRow[] {
  const id = `${EXTENSION}:${phase}`;
  const map = { 'hybrid-jev': 'hybrid-decisions', 'jev-scan': 'decisions-scan' } as const;
  if (phase === 'main') return base.schedule.filter(r => r.method in map).map(r => {
    const method = map[r.method as keyof typeof map];
    return { ...r, method, id: `${id}:${hashObject([r.questionId, method, r.round]).slice(0, 24)}` };
  });
  const { questions, sources } = combineBundles(bundles), byDoc = new Map(sources.map(s => [s.documentId, s]));
  const qasper = shuffled(questions.filter(q => byDoc.get(q.documentId)!.corpus === 'qasper-development'), 42).slice(0, 6);
  const bookDocs = [...new Set(sources.filter(s => s.corpus === 'openstax-development').map(s => s.documentId))].sort();
  const selected = [...qasper, ...bookDocs.flatMap(doc => shuffled(questions.filter(q => q.documentId === doc), 42).slice(0, 2))];
  return shuffled(selected, 42).flatMap((q, i) => shuffled(Object.values(map), 42 + i).map(method => ({ id: `${id}:${hashObject([q.id, method, 0]).slice(0, 24)}`, questionId: q.id, documentId: q.documentId, corpus: byDoc.get(q.documentId)!.corpus, method, round: 0, timingSample: false, generate: true })));
}
function readRuns(ledger: Ledger, prefix: string): ExtensionRun[] {
  return (ledger.db.prepare("SELECT value FROM runs WHERE substr(id,1,?)=? AND status!='running' ORDER BY rowid").all(prefix.length, prefix) as Array<{ value: string }>).map(r => JSON.parse(r.value));
}
function saveRun(ledger: Ledger, run: ExtensionRun) {
  const old = ledger.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string } | undefined;
  if (old?.status !== 'running') throw new Error('Only an active extension run can be settled; terminal rows are immutable.');
  ledger.db.prepare('UPDATE runs SET status=?,value=? WHERE id=?').run(run.status, JSON.stringify(run), run.id);
}
export function plan(phase: 'pilot' | 'main') {
  mkdirSync(ROOT, { recursive: true });
  const base = readJson<ExperimentManifest>(join(BASE, 'manifest.json'));
  if (sha256(readFileSync(join(BASE, 'manifest.json'))) !== 'c23046281d0464ec072e5cec7ea477c8fa7c0b5d4e860a135f4bb3a26352f9f7') throw new Error('Original manifest changed.');
  const bundles = readJson<DatasetBundle[]>(join(phase === 'pilot' ? DEV : BASE, 'datasets.json'));
  const combined = combineBundles(bundles);
  if (combined.sources.some(s => s.split !== (phase === 'pilot' ? 'development' : 'test'))) throw new Error('Development/test leakage.');
  if (phase === 'main' && combined.datasetHash !== base.datasetHash) throw new Error('Test dataset changed.');
  const source = snapshot(), directory = join(ROOT, phase);
  const cohortManifest = readJson<ExperimentManifest>(join(phase === 'pilot' ? DEV : BASE, 'manifest.json'));
  const config = { ...base.config, methods: ['hybrid'] as const };
  const manifest: Manifest = { ...base, id: `${EXTENSION}:${phase}`, phase: phase === 'main' ? 'test' : 'pilot', config: { ...config, methods: ['hybrid'] }, configHash: hashObject(config), datasetHash: combined.datasetHash, datasetHashes: bundles.map(b => b.freeze.hash), implementationHash: source.hash, schedule: extensionSchedule(base, bundles, phase), bookAnnotation: cohortManifest.bookAnnotation,
    hardware: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryBytes: totalmem() },
    extension: { authorizedOn: '2026-10-07', authorization: 'Juan requested repeating the experiments with the new Decisions API and reporting results.', source: DECISIONS_PRICE.source, model: DECISIONS_MODEL, price: DECISIONS_PRICE, baselineManifestHash: sha256(readFileSync(join(BASE, 'manifest.json'))), design: 'post-original-study extension; original outcomes already known; no new prompt tuning on held-out data', traversal: 'unchanged frozen JevEngine, translated Choice and Predicate evaluator, actual translated-body preventive 12000-token guard, full initial coverage', hybridCandidates: 'Recompute BM25/BGE-M3 RRF; require exact ordered candidate IDs from original shared50 checkpoint.', timing: 'Original 100 question IDs and three rounds; endpoint requests have no transient retries or query-result cache. New measurement day, descriptive cross-day latency comparison.', failurePolicy: 'All terminal failures and unknown reservations retained. No retries; stop after 3 consecutive failed runs, access/budget/provenance errors, or unresolved pending calls.', globalCapUsd: '200', extensionCapUsd: SCOPE.maxBudgetUsd, judgeCapUsd: '80', scientificJudging: 'Same fixed generator and frozen RAGAS 0.4.3, Faithfulness and AnswerAccuracy, gpt-6.1-sol medium. No human validation added.', baselineAuthorship: base.bookAnnotation } };
  const previous = existsSync(join(directory, 'manifest.json')) ? readJson<Manifest>(join(directory, 'manifest.json')) : undefined;
  if (previous && hashObject(previous) !== hashObject(manifest)) throw new Error('Frozen extension manifest/source changed.');
  writeJson(join(directory, 'manifest.json'), manifest, true);
  writeJson(join(directory, 'datasets.json'), bundles, true);
  writeJson(join(directory, 'source-snapshot.json'), source, true);
  return { directory, manifest, bundles };
}
function writeReport(ledger: Ledger, directory: string, manifest: Manifest) {
  const runs = readRuns(ledger, manifest.id + ':').map(run => ({ ...run, ...ledger.get(`${run.id}:generation-result`) as object | undefined }));
  const fd = openSync(join(directory, 'report.json'), 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify({ schemaVersion: 1, kind: 'measured', datasetHash: manifest.datasetHash, configHash: manifest.configHash, implementationHash: manifest.implementationHash, extension: manifest.extension }).slice(0, -1) + ',"perQuery":[\n');
    for (const [i, run] of runs.entries()) writeSync(fd, (i ? ',\n' : '') + JSON.stringify(run));
    writeSync(fd, '\n]}\n');
  } finally { closeSync(fd); }
  return runs;
}
export async function run(phase: 'pilot' | 'main', allowPaid: boolean) {
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
  const methods = new Methods({ config: manifest.config, ledger, experimentId: manifest.id, cacheDir: join(phase === 'pilot' ? DEV : BASE, 'cache'), mock: false, allowPaid: false, signal });
  let exitError: string | undefined;
  try {
    if (ledger.pendingRuns().some(id => id.startsWith(EXTENSION)) || ledger.attempts().some(a => a.status === 'pending')) throw new Error('Unresolved run/API attempt; audit before continuation.');
    ledger.freeze(`experiment:${manifest.id}`, manifest);
    const runtime = await methods.initialize(); ledger.freeze(`${manifest.id}:local-runtime`, runtime);
    const gpuCheck = () => { const gpu = probeGpu(); if (!gpu.available || gpu.computeProcesses.some(p => p.pid !== methods.workerPid)) throw new Error('GPU occupied or unavailable; no comparable timing.'); return gpu; };
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
          const originalId = phase === 'pilot' ? 'gb10-book-combined-pilot-20261004-v1' : 'gb10-main-study-20261004-v1';
          const original = ledger.get<RankedChunk[]>(`${originalId}:shared50:${question.id}:${row.round}`);
          if (!original || hashObject(original.map(c => c.chunkId)) !== hashObject(candidates)) throw new Error('PROVENANCE: original hybrid candidate IDs differ or are absent.');
          chunks = doc.chunks.filter(c => candidates.includes(c.id)).sort((a, b) => a.ordinal - b.ordinal);
          if (chunks.length !== candidates.length) throw new Error('PROVENANCE: missing hybrid chunks.');
        }
        const found = await searchDecisions({ config: manifest.config, ledger, runId: row.id, documentId: doc.id, method: row.method, chunks, query: question.question, signal, allowPaid });
        result = { ...row, ...found, phases: { ...prior.phases, ...found.phases }, traces: [...prior.traces, ...found.traces], status: 'completed', startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - measuredStart, timingValid: true };
        if (row.timingSample) ledger.freeze(`${row.id}:gpu-after`, gpuCheck());
        failures = 0;
      } catch (error) {
        result = { ...row, ranking: [], phases: {}, traces: ledger.traces(row.id), status: signal.aborted ? 'interrupted' : 'failed', startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - measuredStart, timingValid: false, error: error instanceof Error ? error.message : String(error) };
        failures++;
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
  if (!['pilot', 'main'].includes(phase)) throw new Error('Usage: run.ts plan|run pilot|main [--allow-paid]');
  if (action === 'plan') { const p = plan(phase as 'pilot' | 'main'); console.log(JSON.stringify({ directory: p.directory, runs: p.manifest.schedule.length, hash: hashObject(p.manifest) })); }
  else if (action === 'run') await run(phase as 'pilot' | 'main', process.argv.includes('--allow-paid'));
  else throw new Error('Unknown action.');
}
