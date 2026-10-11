import { resolve, join } from 'node:path';
import { cpus, totalmem, platform, arch } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { METHOD_IDS, type DatasetBundle, type FrozenQuestion, type RunMethod, type PreparedDocument, type QueryRun, type ResearchConfig } from './types.js';
import { prepareDocument, validateFreeze, describeBookAnnotations, type BookAnnotationProtocol } from './datasets.js';
import { hashObject, readJson, shuffled, writeJson } from './util.js';
import { Ledger } from './ledger.js';
import { Methods } from './methods.js';
import { probeGpu } from './hardware.js';
import { implementationSnapshot } from './implementation.js';

export const DEFAULT_BUDGET_PATH = resolve('data/research/study-budget.sqlite');
export interface ScheduledRun { id: string; questionId: string; documentId: string; corpus: string; method: RunMethod; round: number; timingSample: boolean; generate: boolean; }
export interface ExperimentManifest { schemaVersion: 1; id: string; kind: 'mock' | 'measured'; phase: 'pilot' | 'test'; datasetHash: string; datasetHashes: string[]; config: ResearchConfig; configHash: string; implementationHash: string; budgetPath: string; schedule: ScheduledRun[]; hardware: Record<string, unknown>; bookAnnotation?: BookAnnotationProtocol }
export function loadConfig(path: string | URL = new URL('./config/protocol.json', import.meta.url)): ResearchConfig {
  const config: ResearchConfig = JSON.parse(readFileSync(path, 'utf8'));
  const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (config.schemaVersion !== 1 || !config.methods.length || new Set(config.methods).size !== config.methods.length || config.methods.some(m => !METHOD_IDS.includes(m))) throw new Error('Invalid research methods/config version.');
  if (!integer(config.chunkTokens, 100, 2000) || !integer(config.overlapTokens, 0, config.chunkTokens - 1) || config.topK !== 5 || !integer(config.hybridDepth, 5, 255) || !integer(config.rrfK, 1, 1000) || !integer(config.jevWindowTokens, 4000, 20000) || !integer(config.jevRetain, 1, 50) || !integer(config.concurrency, 1, 8)) throw new Error('Invalid retrieval parameters.');
  if (!integer(config.seed, 0, 0x7fffffff) || !integer(config.bootstrapSamples, 100, 100000) || !integer(config.timing.questions, 0, 100000) || !integer(config.timing.rounds, 1, 20) || !integer(config.generation.questions, 0, 100000) || config.generation.maxOutputTokens !== 512) throw new Error('Invalid experiment sampling parameters.');
  for (const [key, value] of Object.entries(config.rates)) if (key !== 'date' && (!new Decimal(value).isFinite() || new Decimal(value).lt(0))) throw new Error('Invalid immutable price.');
  if (new Decimal(config.maxBudgetUsd).lte(0) || new Decimal(config.maxBudgetUsd).gt(200)) throw new Error('Budget exceeds study cap.');
  if (![config.models.bgeRevision, config.models.rerankerRevision].every(x => /^[a-f0-9]{40}$/.test(x))) throw new Error('Local model commits must be pinned.');
  if (config.structure !== undefined && typeof config.structure !== 'boolean') throw new Error('Invalid structure ablation.');
  if (config.chunkOrderSeed !== undefined && !integer(config.chunkOrderSeed, 0, 0x7fffffff)) throw new Error('Invalid chunk order seed.');
  if (config.local.modelCacheDir !== undefined && (typeof config.local.modelCacheDir !== 'string' || !config.local.modelCacheDir.trim())) throw new Error('Invalid explicit model cache directory.');
  if (!integer(config.requestTimeoutMs, 1000, 600000)) throw new Error('Invalid frozen request timeout.');
  return config;
}
export function combineBundles(bundles: DatasetBundle[]) {
  if (!bundles.length) throw new Error('No datasets.');
  const documents = bundles.flatMap(b => b.freeze.documents), questions = bundles.flatMap(b => b.freeze.questions), sources = bundles.flatMap(b => b.sources);
  for (const b of bundles) validateFreeze(b.freeze);
  if (new Set(documents.map(d => d.id)).size !== documents.length || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Duplicate document/question across frozen datasets.');
  for (const doc of documents) { const source = sources.filter(s => s.documentId === doc.id); if (source.length !== 1 || source[0].textSha256 !== doc.hash || !source[0].license) throw new Error('Incomplete source/license manifest.'); }
  return { documents, questions, sources, datasetHash: hashObject(bundles.map(b => b.freeze.hash).sort()) };
}
function sampleAcrossCorpora(questions: FrozenQuestion[], corpus: Map<string, string>, n: number, seed: number): Set<string> {
  const pools = new Map<string, FrozenQuestion[]>(); for (const q of questions) { const key = corpus.get(q.documentId)!; pools.set(key, [...(pools.get(key) ?? []), q]); }
  const remaining = [...pools].sort(([a], [b]) => a.localeCompare(b)).map(([, pool], i) => shuffled(pool.sort((a, b) => a.id.localeCompare(b.id)), seed + i));
  const result = new Set<string>();
  // Equal allocation until a corpus runs out: 80 book + 120 QASPER for n=200.
  while (result.size < n && remaining.some(p => p.length)) for (const pool of remaining) { if (result.size >= n) break; const q = pool.pop(); if (q) result.add(q.id); }
  return result;
}
export function makeSchedule(bundles: DatasetBundle[], config: ResearchConfig, experimentId: string, phase: 'pilot' | 'test' = 'test'): ScheduledRun[] {
  const { questions, sources } = combineBundles(bundles), corpus = new Map(sources.map(s => [s.documentId, s.corpus]));
  if (sources.some(s => s.split !== (phase === 'pilot' ? 'development' : 'test'))) throw new Error('Development and test documents must be separate; use the matching command.');
  const timing = sampleAcrossCorpora(questions, corpus, config.timing.questions, config.seed + 11);
  const generation = config.generation.questions === 200 && phase === 'test' ? new Set([
    ...shuffled(questions.filter(q => corpus.get(q.documentId) === 'openstax-books'), config.seed + 12).slice(0, 60),
    ...shuffled(questions.filter(q => corpus.get(q.documentId) === 'qasper-test' && !q.unanswerable), config.seed + 13).slice(0, 100),
    ...shuffled(questions.filter(q => corpus.get(q.documentId) === 'qasper-test' && q.unanswerable), config.seed + 14).slice(0, 40),
  ].map(q => q.id)) : sampleAcrossCorpora(questions, corpus, config.generation.questions, config.seed + 12);
  if (config.generation.questions === 200 && phase === 'test' && generation.size !== 200) throw new Error('Generation study requires 60 book, 100 answerable QASPER and 40 unanswerable QASPER questions. Use an explicit pilot/custom config for smaller tests.');
  const rows: ScheduledRun[] = [];
  for (const q of questions) for (let round = 0; round < (timing.has(q.id) ? config.timing.rounds : 1); round++) for (const method of config.methods) rows.push({ id: `${experimentId}:${hashObject([q.id, method, round]).slice(0, 24)}`, questionId: q.id, documentId: q.documentId, corpus: corpus.get(q.documentId)!, method, round, timingSample: timing.has(q.id), generate: round === 0 && generation.has(q.id) });
  const orderedBlock = (rows: ScheduledRun[], seed: number) => shuffled([...new Set(rows.map(r => r.questionId))].sort(), seed).flatMap((id, i) => shuffled(rows.filter(r => r.questionId === id), seed + i + 100));
  const timedBlocks = [...orderedBlock(rows.filter(r => !r.timingSample), config.seed + 99), ...Array.from({ length: config.timing.rounds }, (_, round) => orderedBlock(rows.filter(r => r.timingSample && r.round === round), config.seed + round)).flat()];
  for (const q of questions.filter(q => generation.has(q.id))) for (const method of ['closed-book', 'oracle'] as const) timedBlocks.push({ id: `${experimentId}:${hashObject([q.id, method, 0]).slice(0, 24)}`, questionId: q.id, documentId: q.documentId, corpus: corpus.get(q.documentId)!, method, round: 0, timingSample: false, generate: true });
  return timedBlocks;
}
export function createManifest(bundles: DatasetBundle[], config: ResearchConfig, options: { id: string; mock: boolean; phase: 'pilot' | 'test'; budgetPath?: string }): ExperimentManifest {
  const combined = combineBundles(bundles);
  let bookAnnotation: ExperimentManifest['bookAnnotation'];
  if (!options.mock) {
    const bookIds = new Set(combined.sources.filter(source => ['openstax-books', 'openstax-development'].includes(source.corpus)).map(source => source.documentId));
    if (bookIds.size) {
      const bookQuestions = combined.questions.filter(question => bookIds.has(question.documentId));
      bookAnnotation = describeBookAnnotations(bookQuestions);
      if (bookAnnotation.mode !== 'single_annotator') for (const question of bookQuestions.filter(q => q.annotation?.mode === 'model_generated')) {
        const source = combined.sources.find(s => s.documentId === question.documentId)!;
        if (question.annotation?.mode !== 'model_generated' || source.sourceLockHash !== question.annotation.sourceLockHash) throw new Error('Model-generated book annotation/source lock mismatch.');
      }
    }
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.id)) throw new Error('Experiment ID must be 1–80 letters/digits/_/-.');
  return { schemaVersion: 1, id: options.id, kind: options.mock ? 'mock' : 'measured', phase: options.phase, datasetHash: combined.datasetHash, datasetHashes: bundles.map(b => b.freeze.hash), config, configHash: hashObject(config), implementationHash: implementationSnapshot().hash, budgetPath: resolve(options.budgetPath ?? DEFAULT_BUDGET_PATH), schedule: makeSchedule(bundles, config, options.id, options.phase), hardware: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryBytes: totalmem() }, ...(bookAnnotation ? { bookAnnotation } : {}) };
}
export async function runExperiment(options: { bundles: DatasetBundle[]; config: ResearchConfig; directory: string; id: string; mock: boolean; allowPaid: boolean; phase: 'pilot' | 'test'; budgetPath?: string; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<ExperimentManifest> {
  const directory = resolve(options.directory), manifestPath = join(directory, 'manifest.json'), signal = options.signal ?? new AbortController().signal;
  mkdirSync(directory, { recursive: true });
  if (!options.mock && !options.allowPaid && (options.config.methods.some(m => ['openai-dense', 'jev-scan', 'hybrid-jev'].includes(m)) || options.config.generation.questions > 0)) throw new Error('Paid calls disabled. Plan is safe; run requires --allow-paid.');
  const proposed = createManifest(options.bundles, options.config, options), old = existsSync(manifestPath) ? readJson<ExperimentManifest>(manifestPath) : undefined;
  if (old && hashObject({ ...old, hardware: undefined }) !== hashObject({ ...proposed, hardware: undefined })) throw new Error('Run manifest is immutable; use a new experiment directory for changed configuration.');
  if (old && hashObject(old.hardware) !== hashObject(proposed.hardware)) throw new Error('Resume hardware changed; start a new experiment for comparable timing.');
  const manifest = old ?? proposed;
  const implementation = implementationSnapshot(); if (implementation.hash !== manifest.implementationHash) throw new Error('Implementation changed while creating the experiment.');
  writeJson(manifestPath, manifest, true); writeJson(join(directory, 'datasets.json'), options.bundles, true);
  writeJson(join(directory, 'source-snapshot.json'), implementation, true);
  const lock = join(directory, 'running.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch { throw new Error('Experiment is locked. After confirming the previous process stopped, remove running.lock to resume.'); }
  let ledger: Ledger;
  try { ledger = new Ledger(manifest.budgetPath, options.config.maxBudgetUsd); } catch (error) { unlinkSync(lock); throw error; }
  const methods = new Methods({ config: options.config, ledger, experimentId: options.id, cacheDir: join(directory, 'cache'), mock: options.mock, allowPaid: options.allowPaid, signal });
  const abort = () => methods.close(); signal.addEventListener('abort', abort, { once: true });
  try {
    if (manifest.bookAnnotation?.mode === 'single_annotator') ledger.freeze('study:book-annotator', manifest.bookAnnotation);
    else if (manifest.bookAnnotation?.mode === 'model_generated') ledger.freeze('study:model-book-authoring', manifest.bookAnnotation);
    else if (manifest.bookAnnotation?.mode === 'mixed_human_model') {
      ledger.freeze('study:model-book-authoring', manifest.bookAnnotation.model);
      ledger.freeze('study:book-annotator', { mode: 'single_annotator', annotatorId: manifest.bookAnnotation.humanAnnotatorIds[0]! });
    }
    ledger.freeze(`experiment:${options.id}`, manifest);
    const combined = combineBundles(options.bundles);
    for (const source of combined.sources) { ledger.freeze(`split:id:${source.documentId}`, source.split); ledger.freeze(`split:text:${source.textSha256}`, source.split); }
    const runtime = await methods.initialize(); ledger.freeze(`${options.id}:local-runtime`, runtime);
    if (!options.mock && options.config.local.device.startsWith('cuda')) { const gpu = probeGpu(); if (!gpu.available) throw new Error(gpu.error); ledger.freeze(`${options.id}:gpu-environment`, gpu.gpu.map(({ name, uuid, driver, memoryTotalMiB }) => ({ name, uuid, driver, memoryTotalMiB }))); if (gpu.computeProcesses.some(p => p.pid !== methods.workerPid)) throw new Error('GPU occupied by another compute process; experiment not started.'); }
    const documents = new Map<string, PreparedDocument>();
    for (const doc of combined.documents) { signal.throwIfAborted(); options.onProgress?.(`Preparing ${doc.title}`); const prepared = await prepareDocument(doc, options.config.chunkTokens, options.config.overlapTokens, options.config.maxDocumentTokens); documents.set(doc.id, prepared); await methods.prepare(prepared); }
    const prior = ledger.runs().filter(r => r.id.startsWith(options.id + ':'));
    const questions = new Map(combined.questions.map(q => [q.id, q])), completed = new Set(prior.filter(r => r.status !== 'interrupted').map(r => r.id)), pending = new Set([...ledger.pendingRuns(), ...prior.filter(r => r.status === 'interrupted').map(r => r.id)]);
    let n = 0;
    for (const scheduled of manifest.schedule) {
      signal.throwIfAborted(); if (completed.has(scheduled.id)) continue;
      options.onProgress?.(`${++n}: ${scheduled.method} ${scheduled.questionId} round ${scheduled.round + 1}`);
      const question = questions.get(scheduled.questionId)!, doc = documents.get(scheduled.documentId)!;
      let start = performance.now(), startedAt = new Date().toISOString(); const resumed = pending.has(scheduled.id);
      ledger.startRun(scheduled.id, { ...scheduled, startedAt });
      let run: QueryRun;
      try {
        const control = scheduled.method === 'closed-book' || scheduled.method === 'oracle';
        if (!options.mock && scheduled.timingSample && options.config.local.device.startsWith('cuda')) { const gpu = probeGpu(); if (!gpu.available || gpu.computeProcesses.some(p => p.pid !== methods.workerPid)) throw new Error('GPU idleness not verified before measured query.'); ledger.freeze(`${scheduled.id}:gpu-before:${startedAt}`, gpu); }
        start = performance.now(); startedAt = new Date().toISOString();
        const result = control ? { ranking: [], traces: [], phases: {} } : await methods.search(scheduled.method as Exclude<RunMethod, 'closed-book' | 'oracle'>, question, doc, scheduled.id, scheduled.round);
        run = { ...scheduled, ...result, status: 'completed', startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - start, resumed, timingValid: !resumed && !control };
        if (!options.mock && scheduled.timingSample && options.config.local.device.startsWith('cuda')) { const gpu = probeGpu(); ledger.freeze(`${scheduled.id}:gpu-after:${startedAt}`, gpu); if (!gpu.available || gpu.computeProcesses.some(p => p.pid !== methods.workerPid)) run.timingValid = false; }
      } catch (error) { run = { ...scheduled, status: signal.aborted ? 'interrupted' : 'failed', startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - start, resumed, timingValid: false, ranking: [], phases: {}, traces: ledger.traces(scheduled.id), error: safeError(error) }; }
      ledger.saveRun(run);
      const runPath = join(directory, 'runs', scheduled.id.split(':').at(-1)! + '.json');
      if (existsSync(runPath) && resumed) { const previous = readJson<QueryRun>(runPath); writeJson(runPath.replace('.json', `.interrupted-${hashObject(previous).slice(0, 12)}.json`), previous, true); writeJson(runPath, run); }
      else writeJson(runPath, run, true);
      if (signal.aborted) signal.throwIfAborted();
    }
    // Generation is a separate pass so its API waits cannot change the timed method order.
    for (const scheduled of manifest.schedule.filter(r => r.generate)) {
      signal.throwIfAborted();
      const key = `${scheduled.id}:generation-result`; if (ledger.get(key)) continue;
      const run = ledger.runs().find(r => r.id === scheduled.id); if (!run || run.status !== 'completed') continue;
      try { const generation = await methods.generate(questions.get(scheduled.questionId)!, documents.get(scheduled.documentId)!, run); ledger.freeze(key, { generation }); }
      catch (error) { if (signal.aborted) signal.throwIfAborted(); ledger.freeze(key, { generationError: safeError(error) }); }
    }
    writeJson(join(directory, 'budget.json'), ledger.totals());
    return manifest;
  } finally { signal.removeEventListener('abort', abort); methods.close(); ledger.close(); unlinkSync(lock); }
}
function safeError(error: unknown) { let message = error instanceof Error ? error.message : 'Run failed'; for (const key of [process.env.OPENAI_API_KEY, process.env.TYPESAFE_API_KEY]) if (key) message = message.replaceAll(key, '[REDACTED]'); return message.slice(0, 1000); }
