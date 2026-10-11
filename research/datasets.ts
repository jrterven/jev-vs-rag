import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import type { FrozenDataset, FrozenQuestion, ModelGeneratedAnnotationProvenance, TextBlock } from '../annotation/shared/types.js';
import { chunkBlocks, countTokens } from '../server/extraction.js';
import type { DatasetBundle, PreparedDocument, SourceRecord } from './types.js';
import { hashObject, sha256, shuffled } from './util.js';

export const QASPER_TEST_URL = 'https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-test-and-evaluator-v0.3.tgz';
export const QASPER_TRAIN_URL = 'https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz';
export const QASPER_TRAIN_SHA = '9458bfe76074a8fa8d1685af02bcc73537aa6d338ad20591dfaff1946bc88bf4';
export const QASPER_TEST_SHA = '6e29ad410e6e39aa1936017fb965b30a20eb2e7751997f55b97c9d281aa884e5';
export const canonicalText = (doc: { blocks: TextBlock[] }) => doc.blocks.map(b => b.text).join('\n\n');
export function freezeHash(value: Pick<FrozenDataset, 'projectId' | 'version' | 'documents' | 'questions'>) { return sha256(JSON.stringify({ projectId: value.projectId, version: value.version, documents: value.documents, questions: value.questions })); }
export function makeFreeze(projectId: string, documents: FrozenDataset['documents'], questions: FrozenQuestion[], version = 1): FrozenDataset {
  const hash = freezeHash({ projectId, version, documents, questions });
  return { schemaVersion: 1, id: `freeze-${hash.slice(0, 20)}`, projectId, version, createdAt: new Date().toISOString(), hash, documents, questions };
}
export function textBlocks(documentId: string, paragraphs: Array<{ text: string; heading?: string; page?: number }>): TextBlock[] {
  let offset = 0;
  return paragraphs.filter(p => p.text.trim()).map((p, index) => { if (index) offset += 2; const b = { id: `${documentId}:b:${index}`, index, text: p.text, start: offset, end: offset + p.text.length, ...(p.heading ? { heading: p.heading } : {}), ...(p.page ? { page: p.page } : {}) }; offset = b.end; return b; });
}
export function validateFreeze(freeze: FrozenDataset) {
  if (freeze.schemaVersion !== 1 || freezeHash(freeze) !== freeze.hash) throw new Error('Frozen dataset hash mismatch.');
  const docs = new Map(freeze.documents.map(d => [d.id, d]));
  if (docs.size !== freeze.documents.length) throw new Error('Duplicate document IDs.');
  const ids = new Set<string>();
  for (const doc of freeze.documents) {
    const text = canonicalText(doc);
    if (sha256(text) !== doc.hash) throw new Error(`Document text hash mismatch: ${doc.id}`);
    let offset = 0; const blockIds = new Set<string>();
    for (const [index, b] of doc.blocks.entries()) {
      if (index) offset += 2;
      if (!b.id || blockIds.has(b.id) || b.index !== index || b.start !== offset || b.end !== offset + b.text.length || text.slice(b.start, b.end) !== b.text) throw new Error(`Invalid canonical offsets: ${doc.id}`);
      blockIds.add(b.id);
      offset = b.end;
    }
  }
  for (const q of freeze.questions) {
    if (ids.has(q.id)) throw new Error('Duplicate question IDs.'); ids.add(q.id);
    const doc = docs.get(q.documentId); if (!doc) throw new Error('Question references absent document.');
    if (!q.question.trim()) throw new Error('Empty question.');
    if (q.annotation !== undefined) {
      const a = q.annotation;
      if (a?.mode === 'model_generated') validateModelAnnotation(a, doc.hash);
      else if (!a || !['single_annotator', 'independent_review'].includes(a.mode) || !Array.isArray(a.annotatorIds) || a.annotatorIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id)) || new Set(a.annotatorIds).size !== a.annotatorIds.length || (a.mode === 'single_annotator' ? a.annotatorIds.length !== 1 : a.annotatorIds.length < 2) || !Number.isFinite(Date.parse(a.reviewedAt))) throw new Error('Invalid annotation provenance.');
    }
    if (!q.unanswerable && (!q.evidenceSets.length || q.evidenceSets.some(s => !s.length))) throw new Error('Answerable question without complete evidence.');
    if (q.unanswerable && q.evidenceSets.length) throw new Error('Unanswerable question has gold evidence.');
    const text = canonicalText(doc);
    for (const span of q.evidenceSets.flat()) {
      const b = doc.blocks.find(x => x.id === span.blockId);
      if (!b || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < b.start || span.end > b.end || span.end <= span.start || text.slice(span.start, span.end) !== span.quote || splitsSurrogate(text, span.start) || splitsSurrogate(text, span.end)) throw new Error(`Invalid evidence span: ${q.id}`);
    }
  }
}
const splitsSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validateModelAnnotation(a: ModelGeneratedAnnotationProvenance, documentHash: string) {
  const allowed = ['mode', 'model', 'reasoningEffort', 'authoringRunId', 'promptHash', 'documentHash', 'sourceLockHash', 'generatedAt', 'humanReviewed', 'validation'];
  const validation = a.validation;
  if (Object.keys(a).some(key => !allowed.includes(key)) || !nonempty(a.model) || !nonempty(a.reasoningEffort) || !nonempty(a.authoringRunId) || ![a.promptHash, a.documentHash, a.sourceLockHash].every(sha) || a.documentHash !== documentHash || !iso(a.generatedAt) || a.humanReviewed !== false || !validation || Object.keys(validation).some(key => !['mode', 'model', 'reasoningEffort', 'promptHash', 'reportHash', 'validatedAt', 'status'].includes(key)) || !['model_self_check', 'model_review'].includes(validation.mode) || !nonempty(validation.model) || !nonempty(validation.reasoningEffort) || !sha(validation.promptHash) || !sha(validation.reportHash) || !iso(validation.validatedAt) || validation.status !== 'passed' || Date.parse(validation.validatedAt) < Date.parse(a.generatedAt)) throw new Error('Invalid model-generated annotation provenance; no human review may be claimed.');
}
export async function prepareDocument(doc: FrozenDataset['documents'][number], chunkTokens = 500, overlapTokens = 75, maxTokens = 1_000_000): Promise<PreparedDocument> {
  const text = canonicalText(doc), tokenCount = countTokens(text);
  if (tokenCount > maxTokens) throw new Error(`Document exceeds token limit: ${doc.id}`);
  const blocks = doc.blocks.map(b => ({ id: b.id, ordinal: b.index, text: b.text, start: b.start, end: b.end, page: b.page, paragraph: b.index + 1 }));
  return { id: doc.id, text, blocks: doc.blocks, tokenCount, chunks: await chunkBlocks(blocks, doc.id, { chunkTokens, overlapTokens }) };
}
export function jsonFromTarGz(bytes: Uint8Array, basename: string): Buffer {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  let found: Buffer | undefined;
  for (let pos = 0; pos + 512 <= tar.length; ) {
    const header = tar.subarray(pos, pos + 512), name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || pos + 512 + size > tar.length) throw new Error('Invalid tar member.');
    if (name.split('/').at(-1) === basename) { if (found) throw new Error('Duplicate JSON in archive.'); found = tar.subarray(pos + 512, pos + 512 + size); }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error(`Missing ${basename} in archive.`);
  return found;
}
const normalize = (s: string) => s.replace(/\s+/gu, ' ').trim();
interface RawAnswer { unanswerable: boolean; evidence: string[]; extractive_spans: string[]; free_form_answer: string; yes_no: boolean | null; }
interface RawQuestion { question_id: string; question: string; answers: Array<{ worker_id: string; annotation_id: string; answer: RawAnswer }> }
export interface RawQasperDocument { title: string; abstract: string; full_text: Array<{ section_name: string; paragraphs: string[] }>; qas: RawQuestion[] }
export function importQasperRaw(raw: Record<string, RawQasperDocument>, options: { split: 'test' | 'development'; positiveCount?: number; negativeCount?: number; seed?: number; rawSha256: string }): DatasetBundle {
  const split = options.split, projectId = `qasper-v0.3-${split}`, positive: FrozenQuestion[] = [], negative: FrozenQuestion[] = [], docs: FrozenDataset['documents'] = [];
  const audit = { questions: 0, conflicts: 0, insufficientReviewers: 0, unmappedReferences: 0, eligiblePositive: 0, eligibleNegative: 0 };
  for (const [paperId, doc] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const id = `qasper:${paperId}`;
    const blocks = textBlocks(id, [{ text: normalize(doc.title), heading: normalize(doc.title) }, { text: normalize(doc.abstract), heading: 'Abstract' }, ...doc.full_text.flatMap(section => [...(section.section_name?.trim() ? [{ text: normalize(section.section_name), heading: normalize(section.section_name) }] : []), ...section.paragraphs.map(p => ({ text: normalize(p) }))]) ]);
    const text = canonicalText({ blocks });
    docs.push({ id, projectId, title: doc.title, hash: sha256(text), version: 1, blockCount: blocks.length, sourceUrl: `https://arxiv.org/abs/${paperId}`, sections: blocks.filter(b => b.heading).map(b => ({ blockIndex: b.index, title: b.heading! })), blocks });
    const byText = new Map<string, TextBlock[]>(); for (const b of blocks) byText.set(normalize(b.text), [...(byText.get(normalize(b.text)) ?? []), b]);
    for (const q of doc.qas) {
      audit.questions++;
      const workers = new Set(q.answers.map(a => a.worker_id).filter(Boolean));
      if (!q.answers.length || workers.size < (split === 'test' ? 2 : 1) || q.answers.some(a => !a.worker_id || typeof a.answer.unanswerable !== 'boolean')) { audit.insufficientReviewers++; continue; }
      const flags = q.answers.map(a => a.answer.unanswerable), allNegative = flags.every(Boolean), allPositive = flags.every(x => !x);
      if (!allNegative && !allPositive) { audit.conflicts++; continue; }
      const base = { id: q.question_id, documentId: id, question: q.question };
      if (allNegative) { negative.push({ ...base, answer: '', evidenceSets: [], unanswerable: true }); continue; }
      const sets: FrozenQuestion['evidenceSets'] = []; let referenceAnswer = '';
      for (const entry of q.answers) {
        const evidence = entry.answer.evidence.filter(s => s.trim());
        if (!evidence.length || evidence.some(s => /^FLOAT SELECTED/iu.test(s.trim()))) continue;
        const matches = evidence.map(s => byText.get(normalize(s)) ?? []);
        // Ambiguous repeated paragraphs are not assigned invented offsets.
        if (matches.some(m => m.length !== 1)) { audit.unmappedReferences++; continue; }
        sets.push(matches.map(([b]) => ({ blockId: b.id, start: b.start, end: b.end, quote: b.text })));
        if (!referenceAnswer) referenceAnswer = entry.answer.free_form_answer || entry.answer.extractive_spans.join(' / ') || (entry.answer.yes_no === true ? 'Yes' : entry.answer.yes_no === false ? 'No' : '');
      }
      if (sets.length) positive.push({ ...base, answer: referenceAnswer, evidenceSets: sets, unanswerable: false });
    }
  }
  audit.eligiblePositive = positive.length; audit.eligibleNegative = negative.length;
  const nPositive = options.positiveCount ?? (split === 'test' ? 320 : 60), nNegative = options.negativeCount ?? (split === 'test' ? 76 : 0);
  if (positive.length < nPositive || negative.length < nNegative) throw new Error(`Insufficient eligible questions: ${JSON.stringify(audit)}; requested ${nPositive}+${nNegative}. Criteria were not relaxed.`);
  const questions = [...shuffled(positive.sort((a, b) => a.id.localeCompare(b.id)), options.seed ?? 42).slice(0, nPositive), ...shuffled(negative.sort((a, b) => a.id.localeCompare(b.id)), (options.seed ?? 42) + 1).slice(0, nNegative)].sort((a, b) => a.id.localeCompare(b.id));
  const selected = new Set(questions.map(q => q.documentId)), documents = docs.filter(d => selected.has(d.id));
  const freeze = makeFreeze(projectId, documents, questions); validateFreeze(freeze);
  const acquiredAt = new Date().toISOString();
  return { schemaVersion: 1, freeze, sources: documents.map(d => ({ documentId: d.id, corpus: split === 'test' ? 'qasper-test' : 'qasper-development', split, url: d.sourceUrl!, license: 'CC-BY-4.0 (QASPER dataset); original paper attribution retained', licenseUrl: 'https://huggingface.co/datasets/allenai/qasper', acquiredAt, rawSha256: options.rawSha256, textSha256: d.hash })), provenance: { dataset: 'QASPER', version: '0.3', sourceUrl: split === 'test' ? QASPER_TEST_URL : QASPER_TRAIN_URL, seed: options.seed ?? 42, audit, selection: { positive: nPositive, negative: nNegative }, evidenceGranularity: 'annotated paragraphs; complete alternatives; not exact answer spans', normalization: 'Unicode whitespace collapsed to one space; paragraphs preserved', ambiguousEvidence: 'excluded reference, never first-occurrence guessed' } };
}
export async function downloadQasper(split: 'test' | 'development', localArchive?: string): Promise<DatasetBundle> {
  let archive: Buffer;
  if (localArchive) archive = await readFile(localArchive);
  else {
    const response = await fetch(split === 'test' ? QASPER_TEST_URL : QASPER_TRAIN_URL, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error(`QASPER download HTTP ${response.status}`);
    const buffers: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    for (;;) { const { value: part, done } = await reader.read(); if (done) break; size += part.length; if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('Archive exceeds 32 MB download limit.'); } buffers.push(part); }
    archive = Buffer.concat(buffers);
  }
  const json = jsonFromTarGz(archive, split === 'test' ? 'qasper-test-v0.3.json' : 'qasper-train-v0.3.json'), hash = sha256(json);
  if (hash !== (split === 'test' ? QASPER_TEST_SHA : QASPER_TRAIN_SHA)) throw new Error(`QASPER ${split} v0.3 SHA-256 mismatch; refusing changed source.`);
  return importQasperRaw(JSON.parse(json.toString('utf8')), { split, rawSha256: hash });
}
/** The book protocol uses one human author and a personal check, not independent review. */
export function validateBookAnnotations(questions: FrozenQuestion[]): string {
  if (!questions.length) throw new Error('Book annotations are empty.');
  const annotators = new Set<string>();
  for (const question of questions) {
    const annotation = question.annotation;
    if (!annotation || annotation.mode !== 'single_annotator' || annotation.annotatorIds.length !== 1 || !/^[a-f0-9]{20}$/.test(annotation.annotatorIds[0]!) || !Number.isFinite(Date.parse(annotation.reviewedAt))) throw new Error('Books require frozen single-annotator provenance and a confirmed personal review for every question.');
    annotators.add(annotation.annotatorIds[0]!);
  }
  if (annotators.size !== 1) throw new Error('The book protocol requires the same single annotator across all book questions.');
  return [...annotators][0]!;
}
export function bundleBooks(freeze: FrozenDataset, sources: SourceRecord[], split: 'test' | 'development' = 'test'): DatasetBundle {
  validateFreeze(freeze);
  const annotatorId = validateBookAnnotations(freeze.questions);
  for (const doc of freeze.documents) {
    const source = sources.find(s => s.documentId === doc.id);
    if (!source || source.textSha256 !== doc.hash || !source.license || !source.licenseUrl || !source.rawSha256 || source.split !== split) throw new Error(`Missing verified acquisition/license record for ${doc.id}`);
    const questions = freeze.questions.filter(q => q.documentId === doc.id);
    if (split === 'test' && (questions.length !== 10 || ['factual', 'explanatory', 'multi_section'].some((t, i) => questions.filter(q => q.questionType === t).length !== [4, 3, 3][i]))) throw new Error('Book test requires 10 questions per book: 4 factual, 3 explanatory, 3 multi_section.');
  }
  if (split === 'test' && freeze.documents.length !== 8) throw new Error('Book test requires eight approved books.');
  return { schemaVersion: 1, freeze, sources, provenance: { dataset: 'OpenStax human evidence', split, frozenHumanAnnotations: true, annotationMode: 'single_annotator', annotatorIds: [annotatorId], independentReview: false, protocolAmendedAt: '2026-10-03', sourceOfTruth: 'annotation admin freeze export' } };
}

export interface ModelBookProtocol { mode: 'model_generated'; model: string; reasoningEffort: string; promptHash: string; humanReviewed: false; }
export type BookAnnotationProtocol = { mode: 'single_annotator'; annotatorId: string } | ModelBookProtocol | { mode: 'mixed_human_model'; humanAnnotatorIds: string[]; model: ModelBookProtocol; humanQuestions: number; modelGeneratedQuestions: number; };
/** A model-authored reference is an explicit alternative to the historical human protocol. */
export function validateModelBookAnnotations(questions: FrozenQuestion[]): ModelBookProtocol {
  if (!questions.length) throw new Error('Model-generated book annotations are empty.');
  let protocol: ModelBookProtocol | undefined;
  for (const question of questions) {
    const annotation = question.annotation;
    if (annotation?.mode !== 'model_generated') throw new Error('Cannot mix model-generated and human book annotations.');
    validateModelAnnotation(annotation, annotation.documentHash);
    const current: ModelBookProtocol = { mode: 'model_generated', model: annotation.model, reasoningEffort: annotation.reasoningEffort, promptHash: annotation.promptHash, humanReviewed: false };
    if (protocol && hashObject(current) !== hashObject(protocol)) throw new Error('Model-generated book authorship protocol differs across questions.');
    protocol = current;
  }
  return protocol!;
}

export function describeBookAnnotations(questions: FrozenQuestion[]): BookAnnotationProtocol {
  const generated = questions.filter(question => question.annotation?.mode === 'model_generated');
  if (!generated.length) return { mode: 'single_annotator', annotatorId: validateBookAnnotations(questions) };
  const model = validateModelBookAnnotations(generated), human = questions.filter(question => question.annotation?.mode !== 'model_generated');
  if (!human.length) return model;
  return { mode: 'mixed_human_model', humanAnnotatorIds: [validateBookAnnotations(human)], model, humanQuestions: human.length, modelGeneratedQuestions: generated.length };
}

/** Dedicated import path: cannot relabel AI references as a human annotation freeze. */
export function bundleModelGeneratedBooks(freeze: FrozenDataset, sources: SourceRecord[], split: 'test' | 'development' = 'test'): DatasetBundle {
  validateFreeze(freeze);
  const authoring = describeBookAnnotations(freeze.questions), expectedBooks = split === 'test' ? 8 : 2;
  if (authoring.mode === 'single_annotator') throw new Error('Use import-books for entirely human book references.');
  if (freeze.documents.length !== expectedBooks) throw new Error(`Model-generated book ${split} requires ${expectedBooks} approved books.`);
  if (sources.length !== freeze.documents.length || new Set(sources.map(source => source.documentId)).size !== sources.length) throw new Error('Exactly one source record per model-generated book is required.');
  for (const doc of freeze.documents) {
    const source = sources.find(s => s.documentId === doc.id);
    if (!source || source.split !== split || source.corpus !== (split === 'test' ? 'openstax-books' : 'openstax-development') || source.textSha256 !== doc.hash || !nonempty(source.url) || !nonempty(source.license) || !nonempty(source.licenseUrl) || !sha(source.rawSha256) || !sha(source.sourceLockHash)) throw new Error(`Missing verified model-book acquisition/source lock or split mismatch: ${doc.id}`);
    const questions = freeze.questions.filter(q => q.documentId === doc.id);
    if (questions.length !== 10 || ['factual', 'explanatory', 'multi_section'].some((type, i) => questions.filter(q => q.questionType === type).length !== [4, 3, 3][i])) throw new Error('Model-generated books require 10 questions per book: 4 factual, 3 explanatory, 3 multi_section.');
    for (const question of questions) {
      if (question.unanswerable || !question.answer.trim() || (question.annotation?.mode === 'model_generated' && question.annotation.sourceLockHash !== source.sourceLockHash)) throw new Error('Book references must be answerable and model-generated references must match their acquisition lock.');
      // Each complete evidence alternative for a multi-section question must cross a section.
      if (question.questionType === 'multi_section') for (const set of question.evidenceSets) {
        const sections = new Set(set.map(span => {
          const block = doc.blocks.find(b => b.id === span.blockId)!;
          const section = [...doc.sections].sort((a, b) => a.blockIndex - b.blockIndex).filter(s => s.blockIndex <= block.index).at(-1);
          return section?.blockIndex ?? -1;
        }));
        if (sections.size < 2) throw new Error('A multi_section reference requires evidence from at least two canonical sections.');
      }
    }
  }
  const humanQuestions = authoring.mode === 'mixed_human_model' ? authoring.humanQuestions : 0;
  return { schemaVersion: 1, freeze, sources, provenance: { dataset: authoring.mode === 'mixed_human_model' ? 'OpenStax references with preserved human questions and model-generated completion' : 'OpenStax model-generated questions and references', split, annotationMode: authoring.mode, authoring, frozenHumanAnnotations: false, allReferencesHumanReviewed: false, ...(humanQuestions ? {} : { humanReviewed: false }), humanQuestions, modelGeneratedQuestions: freeze.questions.length - humanQuestions, independentHumanReview: false, validation: 'Model-authored items have AI self-check/review and deterministic canonical UTF-16/source-hash validation, not human review. Existing human items retain their original personal-review provenance.', sourceOfTruth: 'immutable research book freeze; per-question authorship and validation provenance included in dataset hash' } };
}
