/** Explicit development/test export for official Faithfulness + AnswerAccuracy.
 * No provider calls and no edits to the measured experiment or budget backup. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { combineBundles, type ExperimentManifest } from '../runner.js';
import { prepareDocument } from '../datasets.js';
import { contextContentTokens, oracleContext, planRetrievalContext, type GenerationContext } from '../context.js';
import { hashObject, readJson, sha256, writeJson } from '../util.js';
import type { DatasetBundle, FrozenQuestion, GenerationContextManifest, PreparedDocument, QueryRun, SourceRecord } from '../types.js';
import type { PaidAttempt } from '../ledger.js';
import { generationBody } from './export.js';
import { auditFileSha256 } from './audit.js';

// Operational clone: only bounded-memory SHA256 of the exact ledger bytes changes.
const originalExporterSha256 = '21307b8b50172c74271a61811dd4f491ef73a76583d3a6bbcc22c8d3f8f47c03';
if (sha256(readFileSync(new URL('./study-export.ts', import.meta.url))) !== originalExporterSha256) throw new Error('Original scientific exporter changed.');

export const STUDY_EXPORT_POLICY = 'ragas-faithfulness-answer-accuracy-explicit-authorship-v1';
export interface StudyJudgeSample {
  id: string; question: string; response: string; contexts: string[]; reference?: string;
  metrics: Array<'faithfulness' | 'answer_accuracy'>; metadata: Record<string, unknown>;
}
export function studyMetricApplicability(question: FrozenQuestion, generation: NonNullable<QueryRun['generation']>, contexts: GenerationContext[], method: string) {
  const metrics: StudyJudgeSample['metrics'] = [], notApplicable: Record<string, string> = {};
  if (!generation.text.trim()) notApplicable.faithfulness = 'empty_response';
  else if (generation.abstained) notApplicable.faithfulness = 'explicit_abstention';
  else if (method === 'closed-book') notApplicable.faithfulness = 'closed_book_no_supplied_evidence';
  else if (!contexts.length) notApplicable.faithfulness = 'no_supplied_evidence';
  else metrics.push('faithfulness');
  if (question.unanswerable) notApplicable.answer_accuracy = 'unanswerable_reference';
  else if (!question.answer?.trim()) notApplicable.answer_accuracy = 'missing_frozen_reference';
  else if (!generation.text.trim()) notApplicable.answer_accuracy = 'empty_response';
  else metrics.push('answer_accuracy'); // Positive-reference abstentions remain judgeable.
  return { metrics, notApplicable };
}

export function referenceProvenance(question: FrozenQuestion, source: SourceRecord) {
  if (/^qasper-(development|test)$/.test(source.corpus)) {
    if (question.annotation?.mode === 'model_generated') throw new Error('A model-generated reference cannot be labeled as human QASPER.');
    return { referenceKind: 'human_qasper', referencePolicy: 'frozen-first-human-answer', referenceAnnotation: question.annotation ?? null };
  }
  if (!['openstax-development', 'openstax-books'].includes(source.corpus)) throw new Error('Only real QASPER and OpenStax sources are eligible; synthetic stress is excluded.');
  if (question.annotation?.mode === 'model_generated') return { referenceKind: 'model_generated_book', referencePolicy: 'frozen-model-generated-book-answer', referenceAnnotation: question.annotation };
  if (question.annotation?.mode === 'single_annotator') return { referenceKind: 'human_book', referencePolicy: 'frozen-single-annotator-book-answer', referenceAnnotation: question.annotation };
  throw new Error('Book reference lacks the declared single-human or model-generated provenance.');
}

function lines(path: string, rows: unknown[]) {
  const value = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  if (existsSync(path)) { if (readFileSync(path, 'utf8') !== value) throw new Error('Immutable export changed; use a new output directory.'); }
  else writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
}

export async function exportStudyGenerations(options: {
  ledger: string; output: string; scope?: 'development' | 'test';
  cohorts: Array<{ name: string; directory: string }>; amendment?: string;
}) {
  const scope = options.scope ?? 'development';
  if (!['development', 'test'].includes(scope) || !options.cohorts.length) throw new Error('Explicit valid export scope and measured experiment inputs are required.');
  // Check every cohort before opening the ledger or preparing any judge input.
  // A retrieval snapshot deliberately keeps the measured experiment identity,
  // so its separate stage marker must prevent accidental secondary evaluation.
  for (const cohort of options.cohorts) {
    const markerPath = join(resolve(cohort.directory), 'snapshot-stage.json');
    if (!existsSync(markerPath)) continue;
    const marker = readJson<{ ragasEligible?: boolean; stage?: string }>(markerPath);
    if (marker.ragasEligible === false || marker.stage === 'retrieval-complete-generation-incomplete') throw new Error('Snapshot is not eligible for RAGAS; use the final experiment directory, not a retrieval-only snapshot with incomplete generation.');
  }
  const amendmentPath = resolve(options.amendment ?? 'research/config/study-amendment-20261004.json');
  const amendment = readJson<Record<string, any>>(amendmentPath);
  if (amendment.stage !== 'before-heldout-execution' || amendment.secondaryEvaluation?.ragasVersion !== '0.4.3' || amendment.secondaryEvaluation?.judge !== 'gpt-6.1-sol' || amendment.secondaryEvaluation?.reasoningEffort !== 'medium' || amendment.secondaryEvaluation?.humanRatingsInMainStudy !== false) throw new Error('Study amendment does not match the declared automatic evaluation.');
  const db = new DatabaseSync(resolve(options.ledger), { readOnly: true });
  const immutable = <T>(key: string, required = true): T | undefined => {
    const row = db.prepare('SELECT hash,value FROM immutable WHERE key=?').get(key) as { hash: string; value: string } | undefined;
    if (!row) { if (required) throw new Error(`Missing immutable record: ${key}`); return undefined; }
    const value = JSON.parse(row.value); if (hashObject(value) !== row.hash) throw new Error(`Immutable record hash mismatch: ${key}`); return value as T;
  };
  const samples: StudyJudgeSample[] = [], missing: Array<Record<string, unknown>> = [], provenance: Array<Record<string, unknown>> = [];
  try {
    db.exec('PRAGMA query_only=ON');
    const attempts = (db.prepare('SELECT id,logical_key,value FROM attempts').all() as Array<{ id: string; logical_key: string; value: string }>).map(row => {
      const attempt = JSON.parse(row.value) as PaidAttempt;
      if (attempt.id !== row.id || attempt.logicalKey !== row.logical_key) throw new Error('Ledger attempt identity mismatch.'); return attempt;
    });
    const seenRuns = new Set<string>();
    for (const cohort of options.cohorts) {
      const directory = resolve(cohort.directory), manifest = readJson<ExperimentManifest>(join(directory, 'manifest.json'));
      if (manifest.kind !== 'measured' || manifest.phase !== (scope === 'test' ? 'test' : 'pilot')) throw new Error(`Only measured ${scope} experiments are authorized by this export scope.`);
      if (hashObject(immutable(`experiment:${manifest.id}`)) !== hashObject(manifest) || manifest.configHash !== hashObject(manifest.config)) throw new Error('Experiment manifest differs from its immutable measured record.');
      const snapshot = readJson<{ hash: string; files: Record<string, string> }>(join(directory, 'source-snapshot.json'));
      if (snapshot.hash !== manifest.implementationHash || hashObject(snapshot.files) !== snapshot.hash) throw new Error('Experiment source snapshot hash mismatch.');
      const bundles = readJson<DatasetBundle[]>(join(directory, 'datasets.json')), combined = combineBundles(bundles);
      if (combined.datasetHash !== manifest.datasetHash || hashObject(bundles.map(b => b.freeze.hash)) !== hashObject(manifest.datasetHashes)) throw new Error('Dataset does not match the frozen measured experiment.');
      if (combined.sources.some(source => source.split !== scope || !['qasper-development', 'qasper-test', 'openstax-development', 'openstax-books'].includes(source.corpus) || (scope === 'test' ? ['qasper-development', 'openstax-development'] : ['qasper-test', 'openstax-books']).includes(source.corpus))) throw new Error('Corpus/split mismatch or synthetic input; development and test cannot be mixed.');
      const report = readJson<{ datasetHash: string; configHash: string; implementationHash: string; perQuery: QueryRun[] }>(join(directory, 'report.json'));
      if (report.datasetHash !== manifest.datasetHash || report.configHash !== manifest.configHash || report.implementationHash !== manifest.implementationHash) throw new Error('Report provenance differs from the measured experiment.');
      const questions = new Map(combined.questions.map(q => [q.id, q])), docs = new Map(combined.documents.map(doc => [doc.id, doc])), sources = new Map(combined.sources.map(source => [source.documentId, source]));
      const byRun = new Map(report.perQuery.map(run => [run.id, run]));
      if (byRun.size !== report.perQuery.length) throw new Error('Duplicate report run IDs.');
      const prepared = new Map<string, PreparedDocument>();
      const scheduled = manifest.schedule.filter(row => row.generate);
      for (const planned of scheduled) {
        if (seenRuns.has(planned.id)) throw new Error('Duplicate scheduled generation across export inputs.'); seenRuns.add(planned.id);
        const plannedQuestion = questions.get(planned.questionId), plannedSource = sources.get(planned.documentId);
        if (!plannedQuestion || !plannedSource || plannedQuestion.documentId !== planned.documentId || plannedSource.corpus !== planned.corpus) throw new Error('Scheduled generation references an absent question/source.');
        const run = byRun.get(planned.id);
        if (!run?.generation) {
          if (immutable<{ generation?: unknown }>(`${planned.id}:generation-result`, false)?.generation) throw new Error('Report omits an immutable successful generation.');
          missing.push({ cohort: cohort.name, sourceRunId: planned.id, questionId: planned.questionId, documentId: planned.documentId, corpus: planned.corpus, split: scope, method: planned.method, unanswerable: Boolean(plannedQuestion.unanswerable), ...referenceProvenance(plannedQuestion, plannedSource), reason: run?.generationError ?? run?.error ?? 'missing_generation', oracleIneligible: run?.generationError?.includes('control ineligible') ?? false }); continue;
        }
        if (run.status !== 'completed' || run.questionId !== planned.questionId || run.documentId !== planned.documentId || run.method !== planned.method || run.round !== planned.round || run.corpus !== planned.corpus) throw new Error('Generation report/schedule identity mismatch.');
        const persisted = db.prepare('SELECT value,status FROM runs WHERE id=?').get(run.id) as { value: string; status: string } | undefined;
        if (!persisted || persisted.status !== 'completed') throw new Error('Generation has no completed retrieval/control ledger run.');
        const historical = JSON.parse(persisted.value) as QueryRun;
        for (const key of ['questionId', 'documentId', 'method', 'round', 'corpus', 'status', 'ranking', 'traces', 'phases', 'elapsedMs'] as const) if (hashObject(historical[key]) !== hashObject(run[key])) throw new Error(`Historical retrieval differs from report: ${run.id}`);
        const q = questions.get(run.questionId), source = sources.get(run.documentId);
        if (!q || !source || q.documentId !== run.documentId || source.corpus !== run.corpus) throw new Error('Question/document/source identity mismatch.');
        const reference = referenceProvenance(q, source);
        let doc = prepared.get(run.documentId);
        if (!doc) { doc = await prepareDocument(docs.get(run.documentId)!, manifest.config.chunkTokens, manifest.config.overlapTokens, manifest.config.maxDocumentTokens); prepared.set(doc.id, doc); }
        const plan = run.method === 'closed-book' || run.method === 'oracle' ? undefined : planRetrievalContext(doc, run.ranking);
        const contexts = run.method === 'closed-book' ? [] : run.method === 'oracle' ? oracleContext(doc, q) : plan!.contexts;
        const contextManifest: GenerationContextManifest = plan?.manifest ?? { policy: run.method === 'closed-book' ? 'closed-book-v1' : 'complete-gold-or-ineligible-v1', selectedChunkIds: [], omittedChunkIds: [], contentTokens: contextContentTokens(contexts), budget: 2500 };
        if (run.generation.contextManifest && (hashObject(run.generation.contextManifest) !== hashObject(contextManifest) || hashObject(immutable(`${run.id}:generation-context`)) !== hashObject(contextManifest))) throw new Error('Historical generation context manifest differs.');
        const payloadHash = hashObject(generationBody(q, contexts, run.method, manifest.config));
        const matching = attempts.filter(a => a.runId === run.id && a.operation === 'generation' && a.payloadHash === payloadHash && a.status === 'completed');
        if (matching.length !== 1) throw new Error(`Cannot prove one exact historical generation attempt: ${run.id}`);
        const attempt = matching[0]!;
        if (attempt.documentId !== doc.id || attempt.method !== run.method || attempt.model !== manifest.config.models.generation || attempt.reportedModel !== manifest.config.models.generation) throw new Error('Generator attempt identity/model mismatch.');
        const frozen = immutable<{ generation?: QueryRun['generation'] }>(`${run.id}:generation-result`);
        if (!frozen?.generation || hashObject(frozen.generation) !== hashObject(run.generation)) throw new Error('Report differs from immutable generation output.');
        const { metrics, notApplicable } = studyMetricApplicability(q, run.generation, contexts, run.method);
        samples.push({ id: `study-${hashObject([STUDY_EXPORT_POLICY, scope, run.id]).slice(0, 24)}`, question: q.question, response: run.generation.text, contexts: contexts.map(context => `[${context.label}] ${context.text}`), ...(q.unanswerable ? {} : { reference: q.answer }), metrics,
          metadata: { cohort: `${cohort.name}:${source.corpus}`, experimentCohort: cohort.name, corpus: source.corpus, split: source.split, scope, sourceRunId: run.id, questionId: q.id, documentId: doc.id, method: run.method, unanswerable: Boolean(q.unanswerable), abstained: run.generation.abstained, notApplicable, ...reference, datasetHash: manifest.datasetHash, generationAttemptId: attempt.id, generationPayloadHash: payloadHash, generationModel: attempt.reportedModel, retrievalImplementationHash: manifest.implementationHash, generationContextPolicy: run.generation.contextManifest?.policy ?? 'legacy-complete-deduplicated-verified', generationContextManifest: run.generation.contextManifest ?? null, evidenceSets: q.evidenceSets, citations: run.generation.citations, retrievalMs: run.elapsedMs, generationMs: run.generation.elapsedMs } });
      }
      provenance.push({ cohort: cohort.name, experimentId: manifest.id, phase: manifest.phase, scope, datasetHash: manifest.datasetHash, implementationHash: manifest.implementationHash, bookAnnotation: manifest.bookAnnotation ?? null, scheduledGenerations: scheduled.length, manifestSha256: sha256(readFileSync(join(directory, 'manifest.json'))), reportSha256: sha256(readFileSync(join(directory, 'report.json'))), datasetsSha256: sha256(readFileSync(join(directory, 'datasets.json'))), sourceSnapshotSha256: sha256(readFileSync(join(directory, 'source-snapshot.json'))) });
    }
  } finally { db.close(); }
  samples.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(samples.map(sample => sample.id)).size !== samples.length) throw new Error('Duplicate judge sample IDs.');
  const byReferenceKind = Object.fromEntries(['human_qasper', 'human_book', 'model_generated_book'].map(kind => [kind, samples.filter(s => s.metadata.referenceKind === kind).length]));
  const requestedMetrics = samples.reduce((total, sample) => total + sample.metrics.length, 0);
  const manifest = { schemaVersion: 1, policy: STUDY_EXPORT_POLICY, scope, metrics: ['faithfulness', 'answer_accuracy'], ragasVersion: '0.4.3', judge: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }, generatorReferences: 'Unchanged frozen references, with human/model provenance on every record; no human judgments inferred.', factualCorrectness: 'Excluded; development diagnostic retained in its separate legacy export.', ledgerSha256: auditFileSha256(options.ledger), samplesHash: hashObject(samples), samplesSha256: sha256(samples.map(row => JSON.stringify(row)).join('\n') + '\n'), sampleCount: samples.length, requestedMetrics, metricCounts: { faithfulness: samples.filter(s => s.metrics.includes('faithfulness')).length, answer_accuracy: samples.filter(s => s.metrics.includes('answer_accuracy')).length }, byReferenceKind, missing, provenance, amendmentSha256: sha256(readFileSync(amendmentPath)), exporterSha256: sha256(readFileSync(new URL('./study-export-large.ts', import.meta.url))), originalExporterSha256, ledgerHashPolicy: 'SHA256 of exact bytes in bounded chunks; no sample or metric policy change', legacyBodyHelperSha256: sha256(readFileSync(new URL('./export.ts', import.meta.url))), applicability: 'Faithfulness: nonempty, nonabstaining answers with supplied excerpts; closed-book excluded. AnswerAccuracy: nonempty answer against positive frozen reference, including abstentions; unanswerable references excluded. All NA reasons are recorded, never scored zero.' };
  mkdirSync(options.output, { recursive: true, mode: 0o700 });
  lines(join(options.output, 'samples.jsonl'), samples);
  lines(join(options.output, 'all-inputs.jsonl'), samples);
  writeJson(join(options.output, 'export-manifest.json'), manifest, true);
  writeJson(join(options.output, 'study-amendment.json'), amendment, true);
  return { output: resolve(options.output), scope, samples: samples.length, metricRequests: requestedMetrics, metricCounts: manifest.metricCounts, byReferenceKind, missing: missing.length };
}

async function main() {
  const { values } = parseArgs({ options: { ledger: { type: 'string' }, out: { type: 'string' }, scope: { type: 'string', default: 'dev' }, experiment: { type: 'string', multiple: true }, amendment: { type: 'string' } } });
  if (!values.ledger || !values.out || !values.experiment?.length || !['dev', 'development', 'test'].includes(values.scope!)) throw new Error('Usage: study-export.ts --ledger BACKUP --out DIR --scope dev|test --experiment LABEL=EXPERIMENT_DIR [--experiment ...]');
  const cohorts = values.experiment.map(value => { const index = value.indexOf('='); if (index < 1 || index === value.length - 1) throw new Error('Expected LABEL=EXPERIMENT_DIR'); return { name: value.slice(0, index), directory: value.slice(index + 1) }; });
  process.stdout.write(JSON.stringify(await exportStudyGenerations({ ledger: values.ledger, output: values.out, scope: values.scope === 'test' ? 'test' : 'development', cohorts, amendment: values.amendment })) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Study export failed.') + '\n'); process.exitCode = 1; });
