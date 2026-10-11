import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { countTokens } from '../server/extraction.js';
import { canonicalText, importQasperRaw, jsonFromTarGz, makeFreeze, prepareDocument, QASPER_TRAIN_SHA, QASPER_TRAIN_URL, textBlocks, validateFreeze, type RawQasperDocument } from './datasets.js';
import type { DatasetBundle, FrozenQuestion } from './types.js';
import { readJson, sha256, shuffled, stableJson, writeJson } from './util.js';

export const STABLE_TIMESTAMP = '2026-10-04T00:00:00.000Z';
const timestampMeaning = 'Fixed technical artifact generation timestamp for reproducibility; not the original paper or dataset acquisition time.';

function assertDevelopment(source: DatasetBundle): void {
  validateFreeze(source.freeze);
  if (source.schemaVersion !== 1 || source.provenance.dataset !== 'QASPER' || source.provenance.version !== '0.3' || source.provenance.sourceUrl !== QASPER_TRAIN_URL || source.provenance.mock || source.provenance.synthetic) throw new Error('Only original QASPER train/development bundles are accepted.');
  const sources = new Map(source.sources.map(s => [s.documentId, s]));
  if (sources.size !== source.sources.length || sources.size !== source.freeze.documents.length) throw new Error('Development source records must match documents exactly.');
  for (const doc of source.freeze.documents) {
    const record = sources.get(doc.id);
    if (!record || record.split !== 'development' || record.corpus !== 'qasper-development' || record.rawSha256 !== QASPER_TRAIN_SHA || record.textSha256 !== doc.hash) throw new Error('Development source split, corpus or train hash mismatch.');
  }
}

export interface DevelopmentValidationSummary {
  schemaVersion: 1;
  kind: 'technical-development-validation';
  technicalOnly: true;
  seed: number;
  rawSha256: string;
  parentDatasetHash: string;
  datasetHash: string;
  negativeQuestionIds: string[];
  positiveQuestionIds: string[];
  negativeAnnotators: Array<{ questionId: string; annotationCount: number; distinctWorkerCount: number }>;
  counts: { positive: 4; negative: 8; questions: 12; documents: number };
  paidCallsMade: false;
}

/** Offline selection only; the pinned member hash is checked before parsing. */
export function buildDevelopmentValidation(archive: Uint8Array, development: DatasetBundle, seed = 42): { bundle: DatasetBundle; summary: DevelopmentValidationSummary } {
  if (!Number.isSafeInteger(seed)) throw new Error('Seed must be a safe integer.');
  assertDevelopment(development);
  const json = jsonFromTarGz(archive, 'qasper-train-v0.3.json');
  const rawSha256 = sha256(json);
  if (rawSha256 !== QASPER_TRAIN_SHA) throw new Error('QASPER train JSON SHA-256 mismatch.');
  const raw = JSON.parse(json.toString('utf8')) as Record<string, RawQasperDocument>;
  const negatives = importQasperRaw(raw, { split: 'development', positiveCount: 0, negativeCount: 8, seed, rawSha256 });
  const priorIds = new Set(development.freeze.questions.map(q => q.id));
  if (negatives.freeze.questions.some(q => priorIds.has(q.id))) throw new Error('Selected negative overlaps the existing pilot question IDs.');
  const positives = shuffled(development.freeze.questions.filter(q => !q.unanswerable).sort((a, b) => a.id.localeCompare(b.id, 'en')), seed).slice(0, 4);
  if (positives.length !== 4) throw new Error('Four development positive controls are required.');
  const selectedDocumentIds = new Set(positives.map(q => q.documentId));
  const documentMap = new Map(negatives.freeze.documents.map(d => [d.id, structuredClone(d)]));
  for (const doc of development.freeze.documents.filter(d => selectedDocumentIds.has(d.id))) {
    const existing = documentMap.get(doc.id);
    if (existing && stableJson(existing) !== stableJson(doc)) throw new Error('Conflicting document copies while merging development data.');
    documentMap.set(doc.id, structuredClone(doc));
  }
  const documents = [...documentMap.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const questions = structuredClone([...negatives.freeze.questions, ...positives]).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const freeze = makeFreeze(development.freeze.projectId, documents, questions, development.freeze.version);
  freeze.createdAt = STABLE_TIMESTAMP;
  const sourceMap = new Map([...negatives.sources, ...development.sources.filter(s => selectedDocumentIds.has(s.documentId))].map(s => [s.documentId, { ...s, acquiredAt: STABLE_TIMESTAMP }]));
  const rawQuestions = new Map(Object.values(raw).flatMap(d => d.qas).map(q => [q.question_id, q]));
  const negativeAnnotators = negatives.freeze.questions.map(q => {
    const original = rawQuestions.get(q.id)!;
    return { questionId: q.id, annotationCount: original.answers.length, distinctWorkerCount: new Set(original.answers.map(a => a.worker_id)).size };
  });
  const bundle: DatasetBundle = { schemaVersion: 1, freeze, sources: documents.map(d => sourceMap.get(d.id)!), provenance: {
    ...negatives.provenance,
    purpose: 'technical-development-validation', technicalOnly: true,
    parentDatasetHash: development.freeze.hash, parentFreezeId: development.freeze.id,
    timestampMeaning, generatedAt: STABLE_TIMESTAMP,
    positiveControlSourceRecords: development.sources.filter(s => selectedDocumentIds.has(s.documentId)),
    parentDevelopmentProvenance: structuredClone(development.provenance),
    selection: { seed, positive: 4, negative: 8, negativeRule: 'Existing QASPER importer; sorted negative IDs shuffled with seed + 1; eight selected before model outputs.', positiveRule: 'Sorted positive IDs from the existing development pilot, shuffled with seed; four controls.' },
    negativeAnnotators, limitation: 'Development negatives may have one annotator. This is a technical validation subset, not a held-out scientific evaluation.',
  } };
  validateFreeze(bundle.freeze);
  const summary: DevelopmentValidationSummary = { schemaVersion: 1, kind: 'technical-development-validation', technicalOnly: true, seed, rawSha256, parentDatasetHash: development.freeze.hash, datasetHash: freeze.hash, negativeQuestionIds: negatives.freeze.questions.map(q => q.id), positiveQuestionIds: positives.map(q => q.id), negativeAnnotators, counts: { positive: 4, negative: 8, questions: 12, documents: documents.length }, paidCallsMade: false };
  return { bundle, summary };
}

/** Repeated source text is deliberately artificial; derived evidence is not newly human annotated. */
export async function makeDevelopmentStress(development: DatasetBundle, targetTokens = 65_000): Promise<DatasetBundle> {
  assertDevelopment(development);
  if (!Number.isSafeInteger(targetTokens) || targetTokens <= 0 || targetTokens > 1_000_000) throw new Error('Stress targetTokens must be a positive integer at most 1,000,000.');
  const parent = development.freeze.documents[0];
  if (!parent) throw new Error('Development source has no documents.');
  const original = development.freeze.questions.find(q => q.documentId === parent.id && !q.unanswerable);
  if (!original) throw new Error('First development document requires a positive question.');
  const parentTokens = countTokens(canonicalText(parent));
  if (!parentTokens) throw new Error('Cannot repeat an empty document.');
  const id = `SYNTHETIC-development-stress:${parent.id}`;
  const projectId = 'SYNTHETIC-development-stress';
  let repeats = Math.max(2, Math.ceil(Math.max(targetTokens, 26_000) / parentTokens));
  let doc: DatasetBundle['freeze']['documents'][number];
  let prepared: Awaited<ReturnType<typeof prepareDocument>>;
  for (;;) {
    const blocks = textBlocks(id, Array.from({ length: repeats }, () => parent.blocks.map(b => ({ text: b.text, ...(b.heading ? { heading: b.heading } : {}), ...(b.page ? { page: b.page } : {}) }))).flat());
    doc = { ...structuredClone(parent), id, projectId, title: `SYNTHETIC technical stress — ${parent.title} repeated ${repeats} times`, hash: sha256(canonicalText({ blocks })), blockCount: blocks.length, sections: blocks.filter(b => b.heading).map(b => ({ blockIndex: b.index, title: b.heading! })), blocks };
    prepared = await prepareDocument(doc, 500, 75, 1_100_000 + parentTokens);
    if (prepared.tokenCount >= targetTokens && prepared.chunks.length > 50) break;
    repeats++;
  }
  const parentBlocks = new Map(parent.blocks.map(b => [b.id, b]));
  const evidenceSets = Array.from({ length: repeats }, (_, repeat) => original.evidenceSets.map(set => set.map(span => {
    const oldBlock = parentBlocks.get(span.blockId)!;
    const block = doc.blocks[repeat * parent.blocks.length + oldBlock.index]!;
    return { blockId: block.id, start: block.start + span.start - oldBlock.start, end: block.start + span.end - oldBlock.start, quote: span.quote };
  }))).flat();
  const questions: FrozenQuestion[] = [
    { id: `SYNTHETIC-development-stress:${original.id}`, documentId: id, question: original.question, answer: original.answer, evidenceSets, unanswerable: false, ...(original.questionType ? { questionType: original.questionType } : {}) },
    { id: 'SYNTHETIC-development-stress:unanswerable-control', documentId: id, question: 'SYNTHETIC technical unanswerable control: What is the private random access code assigned to this stress fixture after the source paper was published?', answer: '', evidenceSets: [], unanswerable: true },
  ];
  const freeze = makeFreeze(projectId, [doc], questions);
  freeze.createdAt = STABLE_TIMESTAMP;
  const parentSource = development.sources.find(s => s.documentId === parent.id)!;
  const bundle: DatasetBundle = { schemaVersion: 1, freeze, sources: [{ ...parentSource, documentId: id, corpus: 'synthetic-development-stress', split: 'development', acquiredAt: STABLE_TIMESTAMP, textSha256: doc.hash }], provenance: {
    dataset: 'SYNTHETIC repeated QASPER development document', synthetic: true, technicalOnly: true,
    purpose: 'Exercise long-document windowing, reduction and more-than-50 candidate handling without scientific claims.',
    parentDatasetHash: development.freeze.hash, parentFreezeId: development.freeze.id, parentDocumentId: parent.id, parentDocumentHash: parent.hash, parentQuestionId: original.id, parentSource: structuredClone(parentSource),
    sourceUrl: QASPER_TRAIN_URL, rawSha256: QASPER_TRAIN_SHA, timestampMeaning, generatedAt: STABLE_TIMESTAMP,
    construction: 'Complete first development document repeated without truncation; every original complete evidence alternative mapped into every repeat.',
    repeats, targetTokens, tokenCount: prepared.tokenCount, chunkCount: prepared.chunks.length, chunkTokens: 500, overlapTokens: 75,
    evidenceProvenance: 'Mechanically copied offsets from existing positive gold into synthetic repeated text; not new human annotations. The negative is an explicitly synthetic technical control.',
    limitation: 'Synthetic technical stress fixture only; never pool with scientific retrieval, generation or human evaluation results.',
  } };
  validateFreeze(bundle.freeze);
  return bundle;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { archive: { type: 'string' }, 'development-bundle': { type: 'string' }, out: { type: 'string' }, config: { type: 'string' } } });
  if (!values.archive || !values['development-bundle']) throw new Error('Required: --archive and --development-bundle.');
  const development = readJson<DatasetBundle>(resolve(values['development-bundle']));
  const { bundle, summary } = buildDevelopmentValidation(readFileSync(resolve(values.archive)), development);
  const stress = await makeDevelopmentStress(development);
  const { loadConfig } = await import('./runner.js');
  const base = loadConfig(values.config ? resolve(values.config) : undefined);
  const additionalConfig = { ...structuredClone(base), timing: { questions: 12, rounds: 3 }, generation: { ...base.generation, questions: 12 } };
  const stressConfig = { ...structuredClone(base), timing: { questions: 2, rounds: 1 }, generation: { ...base.generation, questions: 0 } };
  const out = resolve(values.out ?? 'output/development-validation-20261004');
  writeJson(join(out, 'additional.bundle.json'), bundle, true);
  writeJson(join(out, 'stress.bundle.json'), stress, true);
  writeJson(join(out, 'config.additional.json'), additionalConfig, true);
  writeJson(join(out, 'config.stress.json'), stressConfig, true);
  const result = { ...summary, timestampMeaning, generatedAt: STABLE_TIMESTAMP, stress: { datasetHash: stress.freeze.hash, ...stress.provenance }, configurations: { additional: { timing: additionalConfig.timing, generation: additionalConfig.generation }, stress: { timing: stressConfig.timing, generation: stressConfig.generation } } };
  writeJson(join(out, 'summary.json'), result, true);
  process.stdout.write(JSON.stringify({ out, ...summary, stress: { datasetHash: stress.freeze.hash, tokenCount: stress.provenance.tokenCount, chunkCount: stress.provenance.chunkCount } }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
