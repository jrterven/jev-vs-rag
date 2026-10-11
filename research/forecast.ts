import { Decimal } from 'decimal.js';
import { countTokens } from '../server/extraction.js';
import { canonicalText } from './datasets.js';
import { oracleContext } from './context.js';
import { combineBundles, type ExperimentManifest } from './runner.js';
import { hashObject, stableJson } from './util.js';
import { implementationSnapshot } from './implementation.js';
import type { Ledger, PaidAttempt } from './ledger.js';
import type { DatasetBundle, PreparedDocument, QueryRun, RunMethod } from './types.js';

export interface ForecastTarget { manifest: ExperimentManifest; bundles: DatasetBundle[] }
export interface ForecastComponent {
  experimentId: string; phase: 'preparation' | 'retrieval' | 'generation'; method: string; corpusFamily: string;
  targetUnits: number; targetDocumentTokens?: number; pilotSamples: number; pilotDocumentCount: number;
  estimatedUsd: string | null; rule: string;
}
export interface StudyForecast {
  schemaVersion: 1; kind: 'pilot-cost-forecast'; status: 'complete' | 'incomplete'; pilotExperimentId: string;
  targetExperimentIds: string[]; margin: number; guarantee: false; components: ForecastComponent[];
  estimate: { preparationUsd: string | null; retrievalUsd: string | null; generationUsd: string | null; totalUsd: string | null; withMarginUsd: string | null; knownComponentSubtotalUsd: string };
  commitments: ReturnType<Ledger['totals']>; availableBudgetUsd: string; budgetLimitUsd: string; fitsBudget: boolean | null;
  missing: string[]; assumptions: string[];
}
const family = (corpus: string): string => /qasper/i.test(corpus) ? 'qasper' : /book|openstax/i.test(corpus) ? 'books' : corpus;
const isPreparation = (attempt: PaidAttempt): boolean => ['document_embedding', 'structure'].includes(attempt.operation);
const sumCost = (attempts: PaidAttempt[]): Decimal => attempts.reduce((sum, attempt) => sum.add(attempt.costUsd ?? 0), new Decimal(0));

/** A conditional forecast, never authorization to spend or a guarantee about future bills.
 * All paid observations come from the immutable shared ledger; no model is invoked.
 */
export async function forecastStudy(pilot: ExperimentManifest, pilotBundles: DatasetBundle[], ledger: Ledger, targets: ForecastTarget[], margin = 0.25): Promise<StudyForecast> {
  if (pilot.phase !== 'pilot' || pilot.kind !== 'measured') throw new Error('Forecast requires a measured development pilot, never mock results.');
  const implementationHash = implementationSnapshot().hash;
  if (pilot.implementationHash !== implementationHash || targets.some(target => target.manifest.implementationHash !== implementationHash)) throw new Error('Forecast implementation differs from the frozen pilot or targets; restore its source snapshot.');
  if (!Number.isFinite(margin) || margin < 0 || margin > 5) throw new Error('Forecast margin must be between 0 and 5.');
  if (!targets.length || new Set(targets.map(target => target.manifest.id)).size !== targets.length) throw new Error('Provide distinct target experiments.');
  const recorded = ledger.get<ExperimentManifest>(`experiment:${pilot.id}`);
  if (!recorded || hashObject(recorded) !== hashObject(pilot)) throw new Error('Pilot manifest does not match the measured ledger.');
  const data = combineBundles(pilotBundles);
  if (data.datasetHash !== pilot.datasetHash || data.sources.some(source => source.split !== 'development')) throw new Error('Pilot sources must match the frozen development manifest.');
  const pilotSources = new Map(data.sources.map(source => [source.documentId, family(source.corpus)]));
  const pilotDocumentIds = new Set(data.documents.map(document => document.id));
  const pilotTextHashes = new Set(data.documents.map(document => document.hash));
  const pilotUrls = new Set(data.sources.map(source => source.url));
  const allAttempts = ledger.attempts(), attempts = allAttempts.filter(attempt => attempt.runId.startsWith(pilot.id + ':'));
  const runs = ledger.runs().filter(run => run.id.startsWith(pilot.id + ':'));
  const byRun = new Map(runs.map(run => [run.id, run]));
  const missing = new Set<string>(), assumptions = new Set<string>([
    'This is an estimate from a measured development pilot, not a guarantee or permission to spend. No provider calls are made by forecasting.',
    'Preparation and full-scan Jev scale linearly with canonical document-token length within corpus family. Reduction depth and structural density can make this approximation inaccurate for longer books.',
    'Query embeddings and hybrid Jev reranking use observed mean cost per complete query within corpus family. Generation uses the observed mean for the same method/control and corpus family under the fixed context/output budgets.',
    'Each target includes preparation once per document and every scheduled retrieval repetition and generation/control. Separate ablations are independent runs; no undocumented cache reuse or discounts are assumed.',
    'Reported API costs include all confirmed attempts, including retries and context splits. Local compute, storage, electricity, taxes and account-specific credits are not valued.',
    'The margin is applied to additional projected API cost. Existing known spending and pending/unknown reservations remain committed against the single study budget.',
  ]);
  const commitments = ledger.totals();
  if (attempts.some(attempt => attempt.costUsd === null)) missing.add('The pilot contains API attempts with unknown or pending cost.');
  if (commitments.unknownAttempts) missing.add('The global ledger has unresolved API reservations; the total bill is incomplete.');
  const pilotTokens = new Map<string, number>();
  for (const document of data.documents) {
    const checkpoint = ledger.get<{ tokens?: number }>(`${pilot.id}:preparation:${document.id}`);
    if (!checkpoint || !Number.isSafeInteger(checkpoint.tokens) || checkpoint.tokens! <= 0) missing.add(`Missing completed preparation/token checkpoint: ${document.id}`);
    else pilotTokens.set(document.id, checkpoint.tokens!);
  }
  for (const scheduled of pilot.schedule) {
    const run = byRun.get(scheduled.id);
    if (!run || run.status !== 'completed') missing.add(`Pilot retrieval/control is missing or incomplete: ${scheduled.id}`);
    if (scheduled.generate) {
      const result = ledger.get<{ generation?: unknown; generationError?: string }>(`${scheduled.id}:generation-result`);
      const ineligibleOracle = scheduled.method === 'oracle' && result?.generationError?.includes('control ineligible');
      if (!result?.generation && !ineligibleOracle) missing.add(`Pilot generation is missing or incomplete: ${scheduled.id}`);
    }
  }
  const components: ForecastComponent[] = [];
  const observedForRun = (run: QueryRun, generation: boolean): PaidAttempt[] => attempts.filter(attempt => attempt.runId === run.id && (generation ? attempt.operation === 'generation' : !isPreparation(attempt) && attempt.operation !== 'generation'));
  const completeRunSamples = (method: RunMethod, corpusFamily: string, generation: boolean): QueryRun[] => runs.filter(run => run.method === method && run.status === 'completed' && pilotSources.get(run.documentId) === corpusFamily && (!generation || !!ledger.get<{generation?: unknown}>(`${run.id}:generation-result`)?.generation));
  const tokenCache = new Map<string, PreparedDocument>();
  for (const target of targets) {
    const manifest = target.manifest, combined = combineBundles(target.bundles);
    if (manifest.kind !== 'measured' || manifest.phase !== 'test' || combined.datasetHash !== manifest.datasetHash || combined.sources.some(source => source.split !== 'test')) throw new Error('Targets must be measured test plans with matching frozen sources.');
    if (manifest.id === pilot.id || ledger.get(`experiment:${manifest.id}`)) throw new Error('Forecast targets must be unstarted experiments; already-spent target work cannot be counted twice.');
    if (manifest.budgetPath !== pilot.budgetPath || !new Decimal(manifest.config.maxBudgetUsd).eq(ledger.maxBudgetUsd)) throw new Error('Every target must use the same shared study budget ledger and limit.');
    if (combined.documents.some(document => pilotDocumentIds.has(document.id) || pilotTextHashes.has(document.hash)) || combined.sources.some(source => pilotUrls.has(source.url))) throw new Error('Development and test sources overlap; use distinct source documents.');
    if (stableJson(manifest.config.models) !== stableJson(pilot.config.models) || stableJson(manifest.config.rates) !== stableJson(pilot.config.rates)) missing.add(`${manifest.id}: target models or prices differ from the measured pilot; recalibration is required.`);
    if (manifest.config.chunkTokens !== pilot.config.chunkTokens || manifest.config.overlapTokens !== pilot.config.overlapTokens) missing.add(`${manifest.id}: passage length/overlap differ from the pilot; preparation/query calibration is unavailable.`);
    if ((manifest.config.structure ?? false) !== (pilot.config.structure ?? false)) missing.add(`${manifest.id}: structural representation differs from the measured pilot; calibrate that representation before relying on the estimate.`);
    if (manifest.config.jevWindowTokens !== pilot.config.jevWindowTokens || manifest.config.jevRetain !== pilot.config.jevRetain || manifest.config.chunkOrderSeed !== pilot.config.chunkOrderSeed) assumptions.add(`${manifest.id}: Jev window/retention/order differs; the forecast reuses the pilot cost-per-source-token coefficient and cannot predict changed reduction depth. The margin may not cover this extrapolation.`);
    const targetSources = new Map(combined.sources.map(source => [source.documentId, family(source.corpus)]));
    const documents = new Map<string, PreparedDocument>();
    for (const document of combined.documents) {
      let prepared = tokenCache.get(document.hash);
      if (!prepared) { const text = canonicalText(document); prepared = { id: document.id, text, tokenCount: countTokens(text), blocks: document.blocks, chunks: [] }; tokenCache.set(document.hash, prepared); }
      documents.set(document.id, { ...prepared, id: document.id, blocks: document.blocks });
    }
    const questions = new Map(combined.questions.map(question => [question.id, question]));
    for (const corpusFamily of [...new Set(targetSources.values())]) {
      const targetDocs = [...documents.values()].filter(document => targetSources.get(document.id) === corpusFamily);
      const tokenTotal = targetDocs.reduce((sum, document) => sum + document.tokenCount, 0);
      for (const operation of [...(manifest.config.methods.includes('openai-dense') ? ['document_embedding'] : []), ...(manifest.config.structure ? ['structure'] : [])]) {
        const sampleDocs = [...pilotTokens.keys()].filter(id => pilotSources.get(id) === corpusFamily);
        const observations = attempts.filter(attempt => attempt.operation === operation && sampleDocs.includes(attempt.documentId));
        const coveredDocs = sampleDocs.filter(id => observations.some(attempt => attempt.documentId === id && attempt.costUsd !== null));
        const valid = coveredDocs.length > 0 && coveredDocs.length === sampleDocs.length && observations.every(attempt => attempt.costUsd !== null);
        if (!valid) missing.add(`${manifest.id}: no complete ${operation} preparation calibration for ${corpusFamily}.`);
        const denominator = coveredDocs.reduce((sum, id) => sum + pilotTokens.get(id)!, 0);
        components.push({ experimentId: manifest.id, phase: 'preparation', method: operation === 'structure' ? 'shared-structure' : 'openai-dense', corpusFamily, targetUnits: targetDocs.length, targetDocumentTokens: tokenTotal, pilotSamples: observations.length, pilotDocumentCount: coveredDocs.length, estimatedUsd: valid ? sumCost(observations).mul(tokenTotal).div(denominator).toFixed() : null, rule: `Observed ${operation} cost / canonical pilot document tokens × target document tokens; each document once.` });
      }
      for (const method of manifest.config.methods) {
        const scheduled = manifest.schedule.filter(row => row.method === method && targetSources.get(row.documentId) === corpusFamily);
        if (!scheduled.length) continue;
        const paid = ['openai-dense', 'hybrid-jev', 'jev-scan'].includes(method);
        const samples = completeRunSamples(method, corpusFamily, false), observations = samples.flatMap(run => observedForRun(run, false));
        const complete = samples.length > 0 && samples.every(run => observedForRun(run, false).some(attempt => attempt.costUsd !== null)) && observations.every(attempt => attempt.costUsd !== null) && samples.every(run => pilotTokens.has(run.documentId));
        let estimated = new Decimal(0); const lengthTotal = scheduled.reduce((sum, row) => sum + documents.get(row.documentId)!.tokenCount, 0);
        if (paid && !complete) missing.add(`${manifest.id}: no complete ${method} retrieval calibration for ${corpusFamily}.`);
        if (paid && complete) estimated = method === 'jev-scan' ? sumCost(observations).mul(lengthTotal).div(samples.reduce((sum, run) => sum + pilotTokens.get(run.documentId)!, 0)) : sumCost(observations).mul(scheduled.length).div(samples.length);
        components.push({ experimentId: manifest.id, phase: 'retrieval', method, corpusFamily, targetUnits: scheduled.length, ...(method === 'jev-scan' ? { targetDocumentTokens: lengthTotal } : {}), pilotSamples: samples.length, pilotDocumentCount: new Set(samples.map(run => run.documentId)).size, estimatedUsd: paid && !complete ? null : estimated.toFixed(), rule: !paid ? 'Local retrieval makes no API calls; local resources remain unpriced.' : method === 'jev-scan' ? 'Observed full-scan cost per canonical source token × document tokens for every scheduled repetition.' : 'Observed mean API cost per complete query × all scheduled repetitions.' });
      }
      for (const method of [...new Set(manifest.schedule.filter(row => row.generate && targetSources.get(row.documentId) === corpusFamily).map(row => row.method))]) {
        let scheduled = manifest.schedule.filter(row => row.generate && row.method === method && targetSources.get(row.documentId) === corpusFamily);
        if (method === 'oracle') scheduled = scheduled.filter(row => { try { oracleContext(documents.get(row.documentId)!, questions.get(row.questionId)!); return true; } catch (error) { if (error instanceof Error && error.message.includes('control ineligible')) { assumptions.add(`${manifest.id}: oracle controls whose complete gold exceeds 2500 content tokens are excluded from projected provider calls, with no truncation.`); return false; } throw error; } });
        const samples = completeRunSamples(method, corpusFamily, true), observations = samples.flatMap(run => observedForRun(run, true));
        const complete = samples.length > 0 && samples.every(run => observedForRun(run, true).some(attempt => attempt.costUsd !== null)) && observations.every(attempt => attempt.costUsd !== null);
        if (scheduled.length && !complete) missing.add(`${manifest.id}: no complete generation calibration for ${method}/${corpusFamily}.`);
        components.push({ experimentId: manifest.id, phase: 'generation', method, corpusFamily, targetUnits: scheduled.length, pilotSamples: samples.length, pilotDocumentCount: new Set(samples.map(run => run.documentId)).size, estimatedUsd: !scheduled.length ? '0' : complete ? sumCost(observations).mul(scheduled.length).div(samples.length).toFixed() : null, rule: 'Observed generation cost for the same method/control and corpus family × every scheduled eligible generation.' });
      }
    }
  }
  const subtotal = components.reduce((sum, component) => sum.add(component.estimatedUsd ?? 0), new Decimal(0));
  const phaseTotal = (phase: ForecastComponent['phase']): string | null => { const own = components.filter(component => component.phase === phase); return own.some(component => component.estimatedUsd === null) ? null : own.reduce((sum, component) => sum.add(component.estimatedUsd!), new Decimal(0)).toFixed(); };
  const complete = missing.size === 0 && components.every(component => component.estimatedUsd !== null);
  const withMargin = subtotal.mul(new Decimal(1).add(margin));
  const available = Decimal.max(0, new Decimal(ledger.maxBudgetUsd).minus(commitments.committedUsd));
  return { schemaVersion: 1, kind: 'pilot-cost-forecast', status: complete ? 'complete' : 'incomplete', pilotExperimentId: pilot.id, targetExperimentIds: targets.map(target => target.manifest.id), margin, guarantee: false, components,
    estimate: { preparationUsd: phaseTotal('preparation'), retrievalUsd: phaseTotal('retrieval'), generationUsd: phaseTotal('generation'), totalUsd: complete ? subtotal.toFixed() : null, withMarginUsd: complete ? withMargin.toFixed() : null, knownComponentSubtotalUsd: subtotal.toFixed() },
    commitments, availableBudgetUsd: available.toFixed(), budgetLimitUsd: ledger.maxBudgetUsd, fitsBudget: complete ? withMargin.lte(available) : null, missing: [...missing], assumptions: [...assumptions] };
}
