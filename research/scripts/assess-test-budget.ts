/** Read-only, conservative budget supplement. Never changes the strict forecast or ledger. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import { forecastStudy, type StudyForecast, type ForecastTarget } from '../forecast.js';
import { createManifest, loadConfig, type ExperimentManifest } from '../runner.js';
import type { Ledger, PaidAttempt } from '../ledger.js';
import type { DatasetBundle, QueryRun } from '../types.js';
import { hashObject, readJson, sha256, stableJson, writeJson } from '../util.js';

// The sole disclosed exception: identity verified in the global ledger on 2026-10-05.
// It is not a pattern permitting arbitrary failed requests or unknown reservations.
export const KNOWN_EXCEPTION = Object.freeze({
  pilotExperimentId: 'gb10-book-combined-pilot-20261004-v1',
  attemptId: '7795fb69-0502-4624-b9a8-5c5fb26a8f23',
  runId: 'gb10-book-combined-pilot-20261004-v1:e2f3150608fb2e223c502e9b',
  questionId: '41bff17f7d7e899c03b051e20ef01f0ebc5c8bb1',
  documentId: 'qasper:2004.03762', method: 'hybrid-jev', operation: 'window', model: 'jev-1.13.0',
  payloadHash: '47e86f1f53c32a256ed4613974706a2ddc973b812640733771a5ad6e3fef9953',
  reservedUsd: '0.042', attemptError: 'fetch failed',
  runError: 'No se recibió una respuesta válida del proveedor.',
});

type GenerationResult = { generation?: unknown; generationError?: string };
type EvidenceRun = QueryRun & { generate?: boolean };
export interface ReadonlyBudgetEvidence {
  maxBudgetUsd: string;
  get<T>(key: string): T | undefined;
  attempts(): PaidAttempt[];
  runs(): EvidenceRun[];
  pendingRuns(): string[];
  totals(): { knownUsd: string; reservedUsd: string; committedUsd: string; unknownAttempts: number };
}
export interface Amendment {
  id: string;
  optionalAblations: { status: string };
  budget: { sharedApiCapUsd: string; judgeReserveUsd: string };
  primaryEvaluation: { qasper: { answerable: number; unanswerable: number }; books: { questions: number } };
  operationalEvaluation: { methods: string[]; timingQuestions: number; timingRounds: number };
  secondaryEvaluation: { generationQuestions: number; arms: number; generator: string; maxOutputTokens: number };
}

function amount(value: string, label: string): Decimal {
  const number = new Decimal(value);
  if (!number.isFinite() || number.isNegative()) throw new Error(`Invalid nonnegative ${label}.`);
  return number;
}

/** Read one consistent SQLite snapshot. No Ledger constructor, PRAGMA mutation, or API call. */
export class ReadonlyStudyLedger implements ReadonlyBudgetEvidence {
  readonly db: DatabaseSync;
  readonly maxBudgetUsd: string;
  readonly snapshotStartedAt: string;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec('PRAGMA query_only=ON; BEGIN');
    this.snapshotStartedAt = new Date().toISOString();
    const budget = this.get<{ maxBudgetUsd: string }>('budget-limit');
    if (!budget) { this.close(); throw new Error('Global ledger has no immutable budget limit.'); }
    this.maxBudgetUsd = budget.maxBudgetUsd;
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value,hash FROM immutable WHERE key=?').get(key) as { value: string; hash: string } | undefined;
    if (!row) return undefined;
    const value: T = JSON.parse(row.value);
    if (hashObject(value) !== row.hash) throw new Error(`Immutable checkpoint hash mismatch: ${key}`);
    return value;
  }
  attempts(): PaidAttempt[] {
    return (this.db.prepare('SELECT value FROM attempts ORDER BY rowid').all() as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  runs(): EvidenceRun[] {
    return (this.db.prepare("SELECT value FROM runs WHERE status!='running' ORDER BY rowid").all() as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  pendingRuns(): string[] {
    return (this.db.prepare("SELECT id FROM runs WHERE status='running'").all() as Array<{ id: string }>).map(row => row.id);
  }
  totals() {
    let known = new Decimal(0), reserved = new Decimal(0), unknown = 0;
    for (const row of this.attempts()) {
      if (row.costUsd === null) { reserved = reserved.add(amount(row.reservedUsd, 'reservation')); unknown++; }
      else known = known.add(amount(row.costUsd, 'known cost'));
    }
    return { knownUsd: known.toFixed(), reservedUsd: reserved.toFixed(), committedUsd: known.add(reserved).toFixed(), unknownAttempts: unknown };
  }
  close() { this.db.close(); }
}

const corpusFamily = (corpus: string) => /qasper/i.test(corpus) ? 'qasper' : /book|openstax/i.test(corpus) ? 'books' : corpus;
const key = (experimentId: string, phase: string, method: string, family: string) => stableJson([experimentId, phase, method, family]);

/** Assess only billing, operational completion, calibration, and frozen configuration.
 * Retrieval rankings, EC@5, answer text, and judge scores never select the budget.
 */
export function assessForecast(strict: StudyForecast, pilot: ExperimentManifest, targets: ForecastTarget[], ledger: ReadonlyBudgetEvidence,
  amendment: Amendment, failureAllowanceUsd = '5') {
  const strictBefore = hashObject(strict), blockers: string[] = [];
  const reject = (condition: boolean, reason: string) => { if (condition) blockers.push(reason); };
  const global = ledger.totals(), attempts = ledger.attempts(), runs = ledger.runs(), byRun = new Map(runs.map(run => [run.id, run]));
  const cap = amount(amendment.budget.sharedApiCapUsd, 'study cap'), judge = amount(amendment.budget.judgeReserveUsd, 'judge reserve');
  const failureAllowance = amount(failureAllowanceUsd, 'failure allowance');
  reject(!cap.eq('200') || !amount(ledger.maxBudgetUsd, 'ledger limit').eq(cap) || !amount(strict.budgetLimitUsd, 'forecast limit').eq(cap), 'The amendment, global ledger, and strict forecast must retain the USD 200 cap.');
  reject(!judge.eq('80'), 'The predeclared RAGAS reserve must remain USD 80.');
  reject(failureAllowance.lt('5'), 'The separate future-failure allowance must be at least USD 5.');
  reject(strict.margin !== 0.25, 'The strict forecast must use exactly the predeclared 25% margin.');
  reject(amendment.optionalAblations.status !== 'not-in-main-study', 'This supplement covers the fixed main study only; optional ablations need their own budget.');
  reject(targets.length !== 1, 'Exactly one unstarted main-study target is permitted.');
  reject(pilot.id !== KNOWN_EXCEPTION.pilotExperimentId || strict.pilotExperimentId !== pilot.id, 'The forecast must use the identified combined development pilot.');
  reject(stableJson(strict.targetExperimentIds) !== stableJson(targets.map(target => target.manifest.id)), 'Strict forecast target identities differ.');
  reject(hashObject(global) !== hashObject(strict.commitments), 'Strict forecast commitments differ from the current global snapshot.');
  reject(ledger.get('budget-halt') !== undefined, 'The global ledger contains a budget-halt checkpoint.');
  reject(ledger.pendingRuns().length > 0, 'A retrieval/control run is still running in the global ledger.');
  const unknown = attempts.filter(attempt => attempt.costUsd === null);
  const exception = unknown.find(attempt => attempt.id === KNOWN_EXCEPTION.attemptId);
  reject(unknown.length !== 1 || !exception, 'Exactly the one identified unknown-cost attempt is permitted; all other reservations must be settled.');
  if (exception) {
    const e = KNOWN_EXCEPTION;
    reject(exception.status !== 'unknown' || exception.error !== e.attemptError || exception.runId !== e.runId || exception.documentId !== e.documentId || exception.method !== e.method || exception.operation !== e.operation || exception.model !== e.model || exception.payloadHash !== e.payloadHash || !amount(exception.reservedUsd, 'exception reservation').eq(e.reservedUsd), 'The unknown attempt no longer matches the disclosed fetch failure and exact USD 0.042 reservation.');
    reject(exception.inputTokens !== undefined || exception.outputTokens !== undefined || exception.responseId !== undefined || exception.providerRequestId !== undefined, 'The exceptional attempt contains new billing/response evidence; it must be reconciled explicitly.');
  }
  const failed = byRun.get(KNOWN_EXCEPTION.runId), scheduledException = pilot.schedule.find(row => row.id === KNOWN_EXCEPTION.runId);
  reject(!failed || failed.status !== 'failed' || failed.method !== KNOWN_EXCEPTION.method || failed.documentId !== KNOWN_EXCEPTION.documentId || failed.questionId !== KNOWN_EXCEPTION.questionId || failed.error !== KNOWN_EXCEPTION.runError || failed.round !== 0 || !failed.generate || corpusFamily(failed.corpus) !== 'qasper', 'The failed base run does not match the disclosed QASPER hybrid-jev case.');
  reject(!scheduledException || scheduledException.generate !== true, 'The disclosed failed base run must retain its scheduled generation.');
  reject(ledger.get(`${KNOWN_EXCEPTION.runId}:generation-result`) !== undefined || attempts.some(attempt => attempt.runId === KNOWN_EXCEPTION.runId && attempt.operation === 'generation'), 'The failed retrieval now has generation evidence; inspect the changed state instead of applying this exception.');

  const allowedReasons = [
    'The pilot contains API attempts with unknown or pending cost.',
    'The global ledger has unresolved API reservations; the total bill is incomplete.',
    `Pilot retrieval/control is missing or incomplete: ${KNOWN_EXCEPTION.runId}`,
    `Pilot generation is missing or incomplete: ${KNOWN_EXCEPTION.runId}`,
  ];
  reject(strict.status !== 'incomplete' || strict.fitsBudget !== null || strict.estimate.totalUsd !== null || strict.estimate.withMarginUsd !== null, 'The original strict forecast must remain incomplete with unknown total/budget fit.');
  reject(strict.missing.length !== allowedReasons.length || strict.missing.some(reason => !allowedReasons.includes(reason)) || allowedReasons.some(reason => !strict.missing.includes(reason)), 'The strict forecast contains missing-work or calibration reasons beyond the single disclosed failure and its skipped generation.');
  for (const row of pilot.schedule) {
    if (row.id === KNOWN_EXCEPTION.runId) continue;
    const run = byRun.get(row.id);
    reject(!run || run.status !== 'completed', `All other pilot retrieval/control runs must be completed: ${row.id}`);
    if (row.generate) {
      const result = ledger.get<GenerationResult>(`${row.id}:generation-result`);
      const oracleIneligible = row.method === 'oracle' && result?.generationError?.includes('control ineligible');
      reject(!result?.generation && !oracleIneligible, `All other eligible pilot generations must be completed: ${row.id}`);
    }
  }
  const scheduledIds = new Set(pilot.schedule.map(row => row.id));
  reject(runs.some(run => run.id.startsWith(pilot.id + ':') && !scheduledIds.has(run.id)), 'The pilot contains retrieval/control runs outside its frozen schedule.');

  const expected = new Map<string, { units: number; oracle: boolean }>();
  for (const target of targets) {
    const manifest = target.manifest;
    reject(ledger.get(`experiment:${manifest.id}`) !== undefined, 'The target has already started; the forecast would double-count its spending.');
    reject(manifest.budgetPath !== pilot.budgetPath || !amount(manifest.config.maxBudgetUsd, 'target cap').eq(cap), 'Target does not use the same global budget ledger and cap.');
    reject(stableJson(manifest.config.models) !== stableJson(pilot.config.models) || stableJson(manifest.config.rates) !== stableJson(pilot.config.rates), 'Every target model and tariff must match the measured pilot.');
    reject(stableJson([...manifest.config.methods].sort()) !== stableJson([...amendment.operationalEvaluation.methods].sort()) || manifest.config.timing.questions !== amendment.operationalEvaluation.timingQuestions || manifest.config.timing.rounds !== amendment.operationalEvaluation.timingRounds || manifest.config.generation.questions !== amendment.secondaryEvaluation.generationQuestions || manifest.config.generation.maxOutputTokens !== amendment.secondaryEvaluation.maxOutputTokens || manifest.config.models.generation !== amendment.secondaryEvaluation.generator, 'The target methods, timing, generator, and generation workload must match the recorded amendment.');
    const questions = target.bundles.flatMap(bundle => bundle.freeze.questions), sources = new Map(target.bundles.flatMap(bundle => bundle.sources).map(source => [source.documentId, corpusFamily(source.corpus)]));
    reject(questions.filter(question => sources.get(question.documentId) === 'qasper' && !question.unanswerable).length !== amendment.primaryEvaluation.qasper.answerable || questions.filter(question => sources.get(question.documentId) === 'qasper' && question.unanswerable).length !== amendment.primaryEvaluation.qasper.unanswerable || questions.filter(question => sources.get(question.documentId) === 'books').length !== amendment.primaryEvaluation.books.questions, 'The complete frozen question workload must match the recorded amendment.');
    const generationQuestions = new Set(manifest.schedule.filter(row => row.generate).map(row => row.questionId));
    reject(generationQuestions.size !== amendment.secondaryEvaluation.generationQuestions || new Set(manifest.schedule.filter(row => row.generate).map(row => row.method)).size !== amendment.secondaryEvaluation.arms, 'The scheduled generation question count and all nine arms must match the recorded amendment.');
    const costSettings = (m: ExperimentManifest) => ({ chunkTokens: m.config.chunkTokens, overlapTokens: m.config.overlapTokens, topK: m.config.topK, hybridDepth: m.config.hybridDepth, rrfK: m.config.rrfK, jevWindowTokens: m.config.jevWindowTokens, jevRetain: m.config.jevRetain, chunkOrderSeed: m.config.chunkOrderSeed ?? null, structure: m.config.structure ?? false, maxOutputTokens: m.config.generation.maxOutputTokens });
    reject(stableJson(costSettings(manifest)) !== stableJson(costSettings(pilot)), 'Cost-relevant retrieval/context settings differ from the measured pilot.');
    const families = [...new Set(manifest.schedule.map(row => corpusFamily(row.corpus)))].sort();
    reject(stableJson(families) !== stableJson(['books', 'qasper']), 'Both BOOKS and QASPER must be present and separately calibrated.');
    for (const family of families) {
      const own = manifest.schedule.filter(row => corpusFamily(row.corpus) === family);
      if (manifest.config.methods.includes('openai-dense')) expected.set(key(manifest.id, 'preparation', 'openai-dense', family), { units: new Set(own.map(row => row.documentId)).size, oracle: false });
      if (manifest.config.structure) expected.set(key(manifest.id, 'preparation', 'shared-structure', family), { units: new Set(own.map(row => row.documentId)).size, oracle: false });
      for (const method of manifest.config.methods) expected.set(key(manifest.id, 'retrieval', method, family), { units: own.filter(row => row.method === method).length, oracle: false });
      for (const method of [...new Set(own.filter(row => row.generate).map(row => row.method))]) expected.set(key(manifest.id, 'generation', method, family), { units: own.filter(row => row.generate && row.method === method).length, oracle: method === 'oracle' });
    }
  }
  const seen = new Set<string>(), calibration: Array<Record<string, unknown>> = [];
  let subtotal = new Decimal(0);
  for (const component of strict.components) {
    const componentKey = key(component.experimentId, component.phase, component.method, component.corpusFamily), scheduled = expected.get(componentKey);
    reject(seen.has(componentKey) || !scheduled, `Duplicate or unexpected forecast component: ${componentKey}`); seen.add(componentKey);
    reject(component.estimatedUsd === null, `Uncalibrated component: ${componentKey}`);
    if (scheduled) reject(component.targetUnits < 0 || component.targetUnits > scheduled.units || (!scheduled.oracle && component.targetUnits !== scheduled.units), `Component omits scheduled work: ${componentKey}`);
    reject(component.targetUnits > 0 && (component.pilotSamples < 1 || component.pilotDocumentCount < 1), `No completed pilot observations for component: ${componentKey}`);
    if (component.estimatedUsd !== null) subtotal = subtotal.add(amount(component.estimatedUsd, 'component estimate'));
    const paid = component.phase !== 'retrieval' || ['openai-dense', 'hybrid-jev', 'jev-scan'].includes(component.method);
    const localModel = component.method === 'bm25' ? 'BM25 (local)' : component.method === 'hybrid-bge' ? `${pilot.config.models.bge} + ${pilot.config.models.reranker} (local)` : `${pilot.config.models.bge} (local)`;
    const model = component.phase === 'generation' ? pilot.config.models.generation : component.method === 'openai-dense' ? pilot.config.models.openaiEmbedding : paid ? pilot.config.models.jev : localModel;
    reject(!paid && component.estimatedUsd !== null && !amount(component.estimatedUsd, 'local API estimate').isZero(), `Local retrieval cannot be assigned an invented API price: ${componentKey}`);
    // forecastStudy supplies non-null estimates only from complete, known-cost samples
    // in the exact corpus family. Check the paid models in those samples explicitly.
    const sampleRuns = runs.filter(run => run.id.startsWith(pilot.id + ':') && run.status === 'completed' && run.method === component.method && corpusFamily(run.corpus) === component.corpusFamily && (component.phase !== 'generation' || !!ledger.get<GenerationResult>(`${run.id}:generation-result`)?.generation));
    const sampleIds = new Set(sampleRuns.map(run => run.id));
    const pilotDocs = new Set(pilot.schedule.filter(row => corpusFamily(row.corpus) === component.corpusFamily).map(row => row.documentId));
    const observations = attempts.filter(attempt => attempt.runId.startsWith(pilot.id + ':') && (component.phase === 'preparation' ? pilotDocs.has(attempt.documentId) && attempt.operation === (component.method === 'shared-structure' ? 'structure' : 'document_embedding') : sampleIds.has(attempt.runId) && (component.phase === 'generation' ? attempt.operation === 'generation' : !['generation', 'document_embedding', 'structure'].includes(attempt.operation))));
    if (paid && component.targetUnits > 0) reject(!observations.length || observations.some(attempt => attempt.costUsd === null || attempt.model !== model || (attempt.reportedModel !== undefined && attempt.reportedModel !== model)), `Incomplete or mismatched model calibration: ${componentKey}`);
    calibration.push({ ...component, model, calibration: paid ? 'completed pilot samples with known billing in the same corpus family' : 'measured local retrieval; API charge is structurally zero, local resources unpriced' });
  }
  for (const componentKey of expected.keys()) reject(!seen.has(componentKey), `Missing forecast component: ${componentKey}`);
  reject(!subtotal.eq(amount(strict.estimate.knownComponentSubtotalUsd, 'known-component subtotal')), 'Forecast component subtotal does not reconcile.');
  for (const phase of ['preparation', 'retrieval', 'generation'] as const) {
    const field = `${phase}Usd` as const, estimate = strict.estimate[field];
    const total = strict.components.filter(component => component.phase === phase).reduce((sum, component) => sum.add(component.estimatedUsd ?? 0), new Decimal(0));
    reject(estimate === null || !total.eq(amount(estimate ?? '0', `${phase} subtotal`)), `Phase subtotal lacks complete calibrated costs: ${phase}`);
  }
  const additionalWithMargin = subtotal.mul('1.25'), projectedCommitment = amount(global.committedUsd, 'global commitments').add(additionalWithMargin).add(judge).add(failureAllowance);
  const headroom = cap.minus(projectedCommitment), fit = blockers.length === 0 && headroom.gte(0);
  if (headroom.lt(0)) blockers.push('Global commitments + calibrated projection with 25% margin + USD 80 RAGAS reserve + future-failure allowance exceed USD 200.');
  if (hashObject(strict) !== strictBefore) throw new Error('Internal error: strict forecast was mutated.');
  return {
    schemaVersion: 1, kind: 'supplementary-test-budget-assessment', status: fit ? 'fits-with-disclosed-exception' : 'blocked', fitsConservativeBudget: fit,
    authorizationToSpend: false, guarantee: false, strictForecast: strict,
    amendmentId: amendment.id, exception: { ...KNOWN_EXCEPTION, generationConsequence: 'The one scheduled generation is unavailable because its base retrieval failed; no generation cost or answer is imputed.', reservationRemainsCommitted: true },
    policy: { margin: 0.25, judgeReserveUsd: judge.toFixed(), futureFailureAllowanceUsd: failureAllowance.toFixed(), capUsd: cap.toFixed(), noQualityScoresReadForBudgetSelection: true, noCoreGuardChanged: true },
    arithmetic: { globalKnownUsd: global.knownUsd, globalReservedUsd: global.reservedUsd, globalCommittedUsd: global.committedUsd, calibratedComponentsSubtotalUsd: subtotal.toFixed(), additionalWithMarginUsd: additionalWithMargin.toFixed(), judgeReserveUsd: judge.toFixed(), futureFailureAllowanceUsd: failureAllowance.toFixed(), conservativeProjectedCommitmentUsd: projectedCommitment.toFixed(), headroomUsd: headroom.toFixed() },
    calibration, blockers: [...new Set(blockers)],
    limitations: ['The USD 0.042 reservation remains an unknown cost, not an observed bill or a settled zero.', 'The USD 5 minimum failure allowance is a disclosed planning reserve, not a statistically estimated failure rate.', 'The USD 80 RAGAS reserve is the predeclared allocation, not a calibrated judge-price forecast.', 'Jev source-length scaling may miss nonlinear reduction costs; 25% margin is not a guarantee.', 'Local compute and Codex authoring usage are unpriced.', 'The existing shared-ledger USD 200 guard remains authoritative during any later execution.'],
  };
}

async function main() {
  const { values } = parseArgs({ options: { 'pilot-dir': { type: 'string' }, datasets: { type: 'string' }, config: { type: 'string' }, id: { type: 'string' }, ledger: { type: 'string' }, amendment: { type: 'string' }, out: { type: 'string' }, 'failure-allowance-usd': { type: 'string', default: '5' } } });
  const required = (name: keyof typeof values) => { const value = values[name]; if (!value) throw new Error(`Missing --${name}.`); return value; };
  const pilotDirectory = resolve(required('pilot-dir')), pilotPath = join(pilotDirectory, 'manifest.json'), pilotDatasetsPath = join(pilotDirectory, 'datasets.json');
  const pilot = readJson<ExperimentManifest>(pilotPath), pilotBundles = readJson<DatasetBundle[]>(pilotDatasetsPath);
  const datasetPaths = required('datasets').split(',').map(path => resolve(path)), bundles = datasetPaths.map(path => readJson<DatasetBundle>(path));
  const configPath = resolve(required('config')), config = loadConfig(configPath), target = createManifest(bundles, config, { id: required('id'), mock: false, phase: 'test', budgetPath: pilot.budgetPath });
  const amendmentPath = resolve(required('amendment')), amendment = readJson<Amendment>(amendmentPath), ledgerPath = resolve(required('ledger'));
  const ledger = new ReadonlyStudyLedger(ledgerPath);
  try {
    const targets = [{ manifest: target, bundles }];
    // The official forecaster only consumes these read methods. No writer is exposed.
    const strict = await forecastStudy(pilot, pilotBundles, ledger as unknown as Ledger, targets, 0.25);
    const assessment = assessForecast(strict, pilot, targets, ledger, amendment, values['failure-allowance-usd']);
    const files = [pilotPath, pilotDatasetsPath, ...datasetPaths, configPath, amendmentPath];
    const output = { ...assessment, provenance: { inputs: files.map(path => ({ path, sha256: sha256(readFileSync(path)) })), scriptSha256: sha256(readFileSync(new URL(import.meta.url))), ledgerPath, ledgerSnapshotTakenAt: ledger.snapshotStartedAt, assessedAt: new Date().toISOString(), attemptsHash: hashObject(ledger.attempts()), runOperationalMetadataHash: hashObject(ledger.runs().map(run => ({ id: run.id, status: run.status, method: run.method, corpus: run.corpus, generate: run.generate, error: run.error }))), targetManifest: target } };
    writeJson(resolve(required('out')), output);
    console.log(JSON.stringify({ out: resolve(required('out')), status: assessment.status, strictStatus: strict.status, strictMissing: strict.missing, arithmetic: assessment.arithmetic, blockers: assessment.blockers, paidCalls: false }, null, 2));
    if (!assessment.fitsConservativeBudget) process.exitCode = 2;
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
