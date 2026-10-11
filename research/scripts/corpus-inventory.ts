/** Canonical corpus metadata only: no retrieval, model calls, or measured outcomes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareDocument, QASPER_TEST_SHA, QASPER_TRAIN_SHA, validateFreeze } from '../datasets.js';
import { implementationSnapshot } from '../implementation.js';
import { hashObject, quantile, sha256, writeJson } from '../util.js';
import type { DatasetBundle } from '../types.js';
import type { ExperimentManifest } from '../runner.js';

interface DocumentInventory {
  documentId: string; title: string; split: string; corpus: string; textHash: string; sourceUrl: string;
  blocks: number; canonicalUtf16Length: number; tokens: number; chunks: number;
  questions: number; positiveQuestions: number; negativeQuestions: number;
  timingQuestions: number; timingPositiveQuestions: number; timingNegativeQuestions: number; timingQuestionIds: string[];
  generationQuestions: number; generationPositiveQuestions: number; generationNegativeQuestions: number; generationQuestionIds: string[];
  plannedTimingRuns: number; plannedGenerationRuns: number;
}

export function numericInventory(values: number[]) {
  if (!values.length) return { count: 0, total: 0, min: null, median: null, max: null };
  return { count: values.length, total: values.reduce((a, b) => a + b, 0), min: Math.min(...values), median: quantile(values, .5), max: Math.max(...values) };
}

export async function inventoryQasper(options: { bundlePaths: string[]; manifestPath: string }) {
  const manifestBytes = readFileSync(options.manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8')) as ExperimentManifest;
  if (manifest.phase !== 'test' || manifest.configHash !== hashObject(manifest.config) || manifest.config.chunkTokens !== 500 || manifest.config.overlapTokens !== 75) throw new Error('Expected a valid planned test manifest with 500/75 chunk configuration.');
  const implementation = implementationSnapshot();
  if (implementation.hash !== manifest.implementationHash) throw new Error('Current implementation differs from planned inventory tokenization/chunking.');
  const rows: DocumentInventory[] = [], inputs = [], seenDocs = new Set<string>(), seenQuestions = new Set<string>();
  for (const path of options.bundlePaths) {
    const bytes = readFileSync(path), bundle = JSON.parse(bytes.toString('utf8')) as DatasetBundle;
    validateFreeze(bundle.freeze);
    if (bundle.schemaVersion !== 1 || !bundle.sources.length) throw new Error('Invalid QASPER bundle.');
    const sourceMap = new Map(bundle.sources.map(s => [s.documentId, s]));
    if (sourceMap.size !== bundle.sources.length || sourceMap.size !== bundle.freeze.documents.length) throw new Error('QASPER document/source mapping must be one-to-one.');
    const split = bundle.sources[0]!.split, corpus = bundle.sources[0]!.corpus;
    if (!['development', 'test'].includes(split) || corpus !== `qasper-${split}` || bundle.sources.some(s => s.split !== split || s.corpus !== corpus || s.rawSha256 !== (split === 'test' ? QASPER_TEST_SHA : QASPER_TRAIN_SHA))) throw new Error('QASPER split or official source hash mismatch.');
    if (split === 'test' && !manifest.datasetHashes.includes(bundle.freeze.hash)) throw new Error('QASPER test freeze is absent from the planned main dataset.');
    for (const q of bundle.freeze.questions) { if (seenQuestions.has(q.id)) throw new Error('Question appears in more than one input split.'); seenQuestions.add(q.id); }
    inputs.push({ path, sha256: sha256(bytes), freezeId: bundle.freeze.id, freezeHash: bundle.freeze.hash, split, corpus, rawSourceSha256: bundle.sources[0]!.rawSha256, freezeValidated: true, sourceHashesValidated: true });
    const questions = new Map(bundle.freeze.questions.map(q => [q.id, q]));
    const scheduled = manifest.schedule.filter(r => r.corpus === corpus);
    for (const run of scheduled) {
      const q = questions.get(run.questionId);
      if (!q || q.documentId !== run.documentId || run.corpus !== corpus) throw new Error('Planned QASPER run references a different question/document.');
    }
    if (split === 'development' && scheduled.length) throw new Error('Development data must not enter planned held-out main schedule.');
    for (const doc of bundle.freeze.documents) {
      if (seenDocs.has(doc.id)) throw new Error('Document appears in more than one input split.'); seenDocs.add(doc.id);
      const source = sourceMap.get(doc.id);
      if (!source || source.textSha256 !== doc.hash) throw new Error('Source text hash differs from canonical document.');
      const prepared = await prepareDocument(doc, 500, 75, manifest.config.maxDocumentTokens);
      const own = bundle.freeze.questions.filter(q => q.documentId === doc.id), planned = scheduled.filter(r => r.documentId === doc.id);
      const timingIds = [...new Set(planned.filter(r => r.timingSample).map(r => r.questionId))].sort();
      const generationIds = [...new Set(planned.filter(r => r.generate).map(r => r.questionId))].sort();
      const positive = (ids: string[]) => ids.filter(id => !questions.get(id)!.unanswerable).length;
      rows.push({ documentId: doc.id, title: doc.title, split, corpus, textHash: doc.hash, sourceUrl: source.url,
        blocks: doc.blocks.length, canonicalUtf16Length: prepared.text.length, tokens: prepared.tokenCount, chunks: prepared.chunks.length,
        questions: own.length, positiveQuestions: own.filter(q => !q.unanswerable).length, negativeQuestions: own.filter(q => q.unanswerable).length,
        timingQuestions: timingIds.length, timingPositiveQuestions: positive(timingIds), timingNegativeQuestions: timingIds.length - positive(timingIds), timingQuestionIds: timingIds,
        generationQuestions: generationIds.length, generationPositiveQuestions: positive(generationIds), generationNegativeQuestions: generationIds.length - positive(generationIds), generationQuestionIds: generationIds,
        plannedTimingRuns: planned.filter(r => r.timingSample).length, plannedGenerationRuns: planned.filter(r => r.generate).length });
    }
  }
  rows.sort((a, b) => a.corpus.localeCompare(b.corpus, 'en') || a.documentId.localeCompare(b.documentId, 'en'));
  const summaries = [...new Set(rows.map(r => r.corpus))].sort().map(corpus => {
    const own = rows.filter(r => r.corpus === corpus), sum = (field: 'questions' | 'positiveQuestions' | 'negativeQuestions' | 'timingQuestions' | 'timingPositiveQuestions' | 'timingNegativeQuestions' | 'generationQuestions' | 'generationPositiveQuestions' | 'generationNegativeQuestions' | 'plannedTimingRuns' | 'plannedGenerationRuns') => own.reduce((total, r) => total + r[field], 0);
    return { corpus, split: own[0]!.split, documents: own.length, questions: sum('questions'), positiveQuestions: sum('positiveQuestions'), negativeQuestions: sum('negativeQuestions'),
      tokens: numericInventory(own.map(r => r.tokens)), chunks: numericInventory(own.map(r => r.chunks)), questionsPerDocument: numericInventory(own.map(r => r.questions)),
      documentsWithPositiveQuestions: own.filter(r => r.positiveQuestions > 0).length, documentsWithNegativeQuestions: own.filter(r => r.negativeQuestions > 0).length, documentsWithBoth: own.filter(r => r.positiveQuestions > 0 && r.negativeQuestions > 0).length,
      timingQuestions: sum('timingQuestions'), timingPositiveQuestions: sum('timingPositiveQuestions'), timingNegativeQuestions: sum('timingNegativeQuestions'), timingDocuments: own.filter(r => r.timingQuestions > 0).length,
      generationQuestions: sum('generationQuestions'), generationPositiveQuestions: sum('generationPositiveQuestions'), generationNegativeQuestions: sum('generationNegativeQuestions'), generationDocuments: own.filter(r => r.generationQuestions > 0).length,
      timingQuestionsPerDocument: numericInventory(own.map(r => r.timingQuestions)), generationQuestionsPerDocument: numericInventory(own.map(r => r.generationQuestions)),
      plannedTimingRuns: sum('plannedTimingRuns'), plannedGenerationRuns: sum('plannedGenerationRuns') };
  });
  return { schemaVersion: 1, kind: 'frozen-corpus-inventory', inputBundles: inputs,
    plannedMain: { path: options.manifestPath, sha256: sha256(manifestBytes), experimentId: manifest.id, phase: manifest.phase, datasetHash: manifest.datasetHash, datasetHashes: manifest.datasetHashes, configHash: manifest.configHash, implementationHash: manifest.implementationHash, executionStatus: 'planned_inventory_only_not_evidence_of_execution' },
    inventorySourceSha256: sha256(readFileSync(new URL('./corpus-inventory.ts', import.meta.url))),
    definition: { tokenization: 'cl100k_base via prepareDocument; estimate for Jev', chunkTokens: 500, overlapTokens: 75, maxDocumentTokens: manifest.config.maxDocumentTokens,
      tokens: 'Canonical complete document text counted once; not overlapping chunk token sum and not API-billed usage.', chunks: 'All canonical text is chunked; complete source documents are not cropped around selected questions.',
      documentText: 'QASPER v0.3 title, abstract, section headings and full_text paragraphs represented by the frozen extraction. This does not imply image/OCR or omitted source material reconstruction.',
      medians: 'Unweighted median across documents; even counts interpolate the two central values.',
      timingQuestions: 'Distinct question IDs selected in the planned main test schedule, counted once across methods and rounds. Development zeros mean excluded from main test, not excluded from the pilot.',
      generationQuestions: 'Distinct question IDs with generate=true in the planned main schedule, counted once across retrieval and control arms.',
      quotas: 'Source question counts and planned timing/generation allocations can differ by document; counts are not equal per-document quotas.',
      results: 'No retrieval rankings, judged quality, latency measurements or paid calls are read or produced.' }, summaries, rows };
}

async function main() {
  const { values } = parseArgs({ options: { bundle: { type: 'string', multiple: true }, manifest: { type: 'string', default: 'output/astra-book-authoring-20261004/main-planned-manifest.json' }, out: { type: 'string', default: 'output/paper-protocol-20261004/qasper-inventory.json' } } });
  const bundlePaths = values.bundle ?? ['research/data/qasper-development.bundle.json', 'research/data/qasper-test.bundle.json'];
  if ([...bundlePaths, values.manifest!].some(path => resolve(path) === resolve(values.out!))) throw new Error('Inventory cannot overwrite its inputs.');
  const inventory = await inventoryQasper({ bundlePaths, manifestPath: values.manifest! });
  writeJson(values.out!, inventory, true);
  process.stdout.write(JSON.stringify({ output: values.out, summaries: inventory.summaries }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Inventory failed.') + '\n'); process.exitCode = 1; });
