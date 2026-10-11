import 'dotenv/config';
import { parseArgs } from 'node:util';
import { resolve, join, extname } from 'node:path';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { downloadQasper, bundleBooks, bundleModelGeneratedBooks, canonicalText } from './datasets.js';
import { createManifest, loadConfig, runExperiment, type ExperimentManifest } from './runner.js';
import { Ledger } from './ledger.js';
import { evaluateExperiment } from './report.js';
import { annotationExports } from './annotations.js';
import { mockDataset } from './fixtures.js';
import { readJson, sha256, writeJson } from './util.js';
import type { DatasetBundle, FrozenDataset, SourceRecord } from './types.js';
import { extractInWorker } from '../server/extraction-client.js';
import { readConfig } from '../server/config.js';
import { implementationSnapshot } from './implementation.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  datasets: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' }, mock: { type: 'boolean' }, 'allow-paid': { type: 'boolean' }, 'budget-file': { type: 'string' },
  split: { type: 'string' }, archive: { type: 'string' }, freeze: { type: 'string' }, sources: { type: 'string' }, reviewers: { type: 'string' }, input: { type: 'string' }, title: { type: 'string' }, 'project-id': { type: 'string' }, 'source-url': { type: 'string' }, license: { type: 'string' }, 'license-url': { type: 'string' }, variant: { type: 'string' }, help: { type: 'boolean' }, 'pilot-dir': { type: 'string' }, 'include-ablations': { type: 'boolean' }, ratings: { type: 'string' }, dataset: { type: 'string' }, python: { type: 'string' },
} });
const command = positionals[0] ?? 'plan';
const required = (key: keyof typeof values) => { const value = values[key]; if (typeof value !== 'string' || !value) throw new Error(`Missing --${key}.`); return value; };
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
if (values.split && !['development', 'test'].includes(values.split)) throw new Error('--split must be test or development.');
const split = values.split === 'development' ? 'development' : 'test';
const controller = new AbortController(); process.once('SIGINT', () => controller.abort(new Error('Interrupted by operator.'))); process.once('SIGTERM', () => controller.abort(new Error('Terminated by operator.')));

async function main() {
  if (values.help) { output({ commands: ['plan', 'prepare-smoke', 'import-qasper', 'import-text', 'import-books', 'import-model-books', 'pilot', 'run', 'schedule', 'evaluate', 'export-annotations', 'ablation-plan', 'ablation-run', 'forecast', 'human-report', 'mock-demo'], docs: 'research/README.md', paidCalls: 'Only run/pilot/ablation-run --allow-paid; never enabled by default.' }); return; }
  if (command === 'prepare-smoke') {
    const { prepareDevelopmentSmoke } = await import('./smoke.js');
    const plan = await prepareDevelopmentSmoke(readJson<DatasetBundle>(required('dataset')), loadConfig(values.config ? resolve(values.config) : undefined), { python: required('python') });
    const directory = resolve(required('out'));
    writeJson(join(directory, 'dataset.bundle.json'), plan.bundle, true); writeJson(join(directory, 'config.json'), plan.config, true); writeJson(join(directory, 'selection.json'), plan.selection, true);
    output({ directory, ...plan.selection, next: 'Copy this plan to GB10, verify an idle GPU and isolated Python environment, then use pilot --datasets dataset.bundle.json --config config.json --allow-paid with the global study ledger.' }); return;
  }
  if (command === 'human-report') {
    const { analyzeHumanRatings } = await import('./human-analysis.js');
    const bundle = readJson<DatasetBundle>(required('dataset')), report = analyzeHumanRatings(readJson(required('ratings')), bundle.freeze, bundle.sources), out = resolve(values.out ?? 'data/research/human-report.json');
    writeJson(out, { ...report, analysisImplementationHash: implementationSnapshot().hash }); output({ out }); return;
  }
  if (command === 'import-qasper') { const bundle = await downloadQasper(split, values.archive); const out = resolve(values.out ?? `data/research/qasper-${split}.bundle.json`); writeJson(out, bundle, true); output({ out, hash: bundle.freeze.hash, documents: bundle.freeze.documents.length, questions: bundle.freeze.questions.length, provenance: bundle.provenance }); return; }
  if (command === 'import-books') { const bundle = bundleBooks(readJson<FrozenDataset>(required('freeze')), readJson<SourceRecord[]>(required('sources')), split); const out = resolve(values.out ?? `data/research/books-${split}.bundle.json`); writeJson(out, bundle, true); output({ out, hash: bundle.freeze.hash, questions: bundle.freeze.questions.length }); return; }
  if (command === 'import-model-books') { const bundle = bundleModelGeneratedBooks(readJson<FrozenDataset>(required('freeze')), readJson<SourceRecord[]>(required('sources')), split); const out = resolve(values.out ?? `data/research/model-books-${split}.bundle.json`); writeJson(out, bundle, true); output({ out, hash: bundle.freeze.hash, questions: bundle.freeze.questions.length, annotationMode: bundle.provenance.annotationMode, humanQuestions: bundle.provenance.humanQuestions, modelGeneratedQuestions: bundle.provenance.modelGeneratedQuestions, allReferencesHumanReviewed: false }); return; }
  if (command === 'import-text') {
    const path = resolve(required('input')), format = extname(path).slice(1).toLowerCase(); if (!['pdf', 'docx', 'txt'].includes(format)) throw new Error('Supported source formats: PDF, DOCX, TXT.');
    const limits = readConfig(); if (statSync(path).size > limits.maxFileMb * 1024 * 1024) throw new Error('Source file exceeds configured MAX_FILE_MB.');
    const result = await extractInWorker(path, format as 'pdf' | 'docx' | 'txt', 'source-import', limits, { signal: controller.signal, onProgress: () => {} });
    const blocks = result.blocks.map(b => ({ text: b.text, ...(b.page ? { page: b.page } : {}) }));
    const out = resolve(required('out')); mkdirSync(out, { recursive: true });
    const body = { projectId: required('project-id'), title: required('title'), sourceUrl: required('source-url'), blocks };
    writeJson(join(out, 'document-import.json'), body, true);
    writeJson(join(out, 'acquisition.json'), { documentId: 'FILL_FROM_ADMIN_DOCUMENT_RESPONSE', corpus: split === 'test' ? 'openstax-books' : 'openstax-development', split, url: body.sourceUrl, license: required('license'), licenseUrl: required('license-url'), acquiredAt: new Date().toISOString(), rawSha256: sha256(readFileSync(path)), textSha256: sha256(blocks.map(b => b.text).join('\n\n')), warnings: result.warnings }, true);
    output({ out, blocks: blocks.length, tokens: result.tokenCount, warnings: result.warnings, next: 'Preserve canonical text and acquisition hashes. Human books use annotation authoring plus personal review and import-books. Model-generated books use an explicit model-generated freeze, AI validation provenance and import-model-books; they are not human gold.' }); return;
  }
  if (command === 'evaluate' || command === 'export-annotations') {
    const directory = resolve(required('out')), manifest = readJson<ExperimentManifest>(join(directory, 'manifest.json')), bundles = readJson<DatasetBundle[]>(join(directory, 'datasets.json')), ledger = new Ledger(manifest.budgetPath, manifest.config.maxBudgetUsd);
    try {
      if (command === 'evaluate') { const report = await evaluateExperiment(manifest, bundles, ledger); writeJson(join(directory, 'report.json'), report); output({ report: join(directory, 'report.json'), kind: report.kind, methods: report.methods.length, missingScheduledRuns: report.missingScheduledRuns }); }
      else { const exports = annotationExports(manifest, bundles, ledger, required('reviewers').split(',')); for (const payload of exports) writeJson(join(directory, 'annotation-exports', `${payload.freezeId}.json`), payload, true); output({ directory: join(directory, 'annotation-exports'), payloads: exports.length, answers: exports.reduce((n, p) => n + p.answers.length, 0), next: 'Coordinator POST each payload to /admin/results. No results are uploaded automatically.' }); }
    } finally { ledger.close(); } return;
  }
  const config = loadConfig(values.config ? resolve(values.config) : undefined);
  if (command === 'plan' && !values.datasets) { output({ config, datasetTargets: { qasperTest: { answerable: 320, unanimousUnanswerable: 76 }, booksTest: { books: 8, questions: 80 }, development: { qasper: 60, books: 2, bookQuestions: 20 } }, bookAnnotation: { supportedModes: ['single_annotator', 'model_generated', 'mixed_human_model'], human: { personalReviewRequired: true, independentReview: false }, modelGenerated: { humanReviewed: false, explicitModelAndPromptProvenance: true, aiValidationRequired: true, canonicalEvidenceRequired: true }, actualMode: 'Determined by the frozen dataset, recorded in the experiment manifest and report; Existing human references retain their provenance when model-generated references complete a book corpus.' }, generation: '100 QASPER positive + 40 negative + 60 book; closed-book and eligible oracle controls', humanEvaluation: { status: 'Not collected by this runner; no human ratings are inferred from model judges.', legacyOptionalDesign: '30 QASPER positive + 10 negative + 20 book; 3 arms x2 reviewers' }, ablations: 'Optional separate plans, never included automatically in the main study.', pending: 'Frozen references with explicit authorship and matching acquisition manifests are required. Model-generated book references remain distinct from human QASPER references.', paidCalls: false }); return; }
  let bundles: DatasetBundle[];
  if (command === 'mock-demo') { bundles = [mockDataset()]; config.generation.questions = 3; config.timing.questions = 3; config.bootstrapSamples = 100; }
  else bundles = required('datasets').split(',').map(path => readJson<DatasetBundle>(resolve(path)));
  if (command === 'forecast') {
    const { forecastStudy } = await import('./forecast.js');
    const pilotDirectory = resolve(required('pilot-dir')), pilot = readJson<ExperimentManifest>(join(pilotDirectory, 'manifest.json')), pilotBundles = readJson<DatasetBundle[]>(join(pilotDirectory, 'datasets.json'));
    const target = createManifest(bundles, config, { id: values.id ?? 'planned-main-study', mock: false, phase: 'test', budgetPath: pilot.budgetPath });
    const targets = [{ manifest: target, bundles }];
    if (values['include-ablations']) { const { planAblations } = await import('./ablations.js'); const plan = planAblations(bundles, config); for (const variant of plan.variants) targets.push({ manifest: createManifest(plan.bundles, variant.config, { id: `planned-ablation-${variant.id}`, mock: false, phase: 'test', budgetPath: pilot.budgetPath }), bundles: plan.bundles }); }
    const ledger = new Ledger(pilot.budgetPath, pilot.config.maxBudgetUsd);
    try { const forecast = await forecastStudy(pilot, pilotBundles, ledger, targets); const out = resolve(values.out ?? 'data/research/forecast.json'); writeJson(out, forecast); output({ out, status: forecast.status, estimate: forecast.estimate, fitsBudget: forecast.fitsBudget }); } finally { ledger.close(); } return;
  }
  if (command === 'ablation-plan' || command === 'ablation-run') {
    const { planAblations } = await import('./ablations.js');
    const plan = planAblations(bundles, config), directory = resolve(values.out ?? 'data/research/ablations');
    if (command === 'ablation-plan') { writeJson(join(directory, 'plan.json'), plan, true); writeJson(join(directory, 'bundles.json'), plan.bundles, true); for (const variant of plan.variants) writeJson(join(directory, 'configs', variant.id + '.json'), variant.config, true); output({ directory, variants: plan.variants.map(v => v.id), questions: plan.subsetQuestionIds.length, paidCalls: false }); return; }
    const variant = plan.variants.find(v => v.id === required('variant')); if (!variant) throw new Error('Unknown ablation variant.');
    await execute(plan.bundles, variant.config, join(directory, variant.id), values.id ?? `ablation-${variant.id}`, 'test', Boolean(values.mock)); return;
  }
  const mock = command === 'mock-demo' || Boolean(values.mock), phase = command === 'pilot' ? 'pilot' : 'test', id = values.id ?? (mock ? 'mock-demo' : phase), directory = resolve(values.out ?? `data/research/${id}`);
  if (command === 'plan' || command === 'schedule') { const manifest = createManifest(bundles, config, { id, mock, phase, budgetPath: values['budget-file'] }); if (values.out) writeJson(join(directory, 'planned-manifest.json'), manifest, true); output({ id, kind: manifest.kind, datasetHash: manifest.datasetHash, questions: bundles.reduce((n, b) => n + b.freeze.questions.length, 0), scheduledRuns: manifest.schedule.length, scheduleHash: sha256(JSON.stringify(manifest.schedule)), paidCalls: false }); return; }
  if (!['run', 'pilot', 'mock-demo'].includes(command)) throw new Error('Unknown command. Use --help.');
  await execute(bundles, config, directory, id, phase, mock);
}
async function execute(bundles: DatasetBundle[], config: ReturnType<typeof loadConfig>, directory: string, id: string, phase: 'test' | 'pilot', mock: boolean) {
  const manifest = await runExperiment({ bundles, config, directory, id, phase, mock, allowPaid: Boolean(values['allow-paid']), budgetPath: values['budget-file'], signal: controller.signal, onProgress: message => process.stderr.write(message + '\n') });
  const ledger = new Ledger(manifest.budgetPath, config.maxBudgetUsd);
  try { const report = await evaluateExperiment(manifest, bundles, ledger); writeJson(join(directory, 'report.json'), report); output({ directory, kind: manifest.kind, report: join(directory, 'report.json'), observedApiUsd: report.experimentObservedUsd, missingScheduledRuns: report.missingScheduledRuns }); } finally { ledger.close(); }
}
main().catch(error => { let message = error instanceof Error ? error.message : 'Research command failed.'; for (const secret of [process.env.OPENAI_API_KEY, process.env.TYPESAFE_API_KEY]) if (secret) message = message.replaceAll(secret, '[REDACTED]'); process.stderr.write(message + '\n'); process.exitCode = 1; });
