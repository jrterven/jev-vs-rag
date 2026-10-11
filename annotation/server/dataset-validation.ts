import type { FrozenDataset, TextBlock } from '../shared/types.js';
import { hashDataset, sha256 } from './canonical.js';
import { array, choice, fail, integer, object, string, validateAttribution, validateSpans } from './validation.js';

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Campos fuera del contrato del dataset.');
}

/** Validate without rebuilding JSON objects: the signed snapshot's property order is retained. */
export function validateImportedDataset(value: unknown): FrozenDataset {
  const raw = object(value);
  fields(raw, ['schemaVersion', 'id', 'projectId', 'version', 'createdAt', 'hash', 'documents', 'questions']);
  if (raw.schemaVersion !== 1) fail(400, 'Versión del dataset no compatible.');
  string(raw.id, 100); const projectId = string(raw.projectId, 100); integer(raw.version, 1);
  if (!Number.isFinite(Date.parse(string(raw.createdAt, 100)))) fail(400, 'Fecha inválida.');
  const digest = string(raw.hash, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(400, 'Hash inválido.');
  const documents = array(raw.documents, 10000), questions = array(raw.questions, 100000);
  if (!documents.length || !questions.length) fail(400, 'Dataset vacío.');
  const documentIds = new Set<string>(), blockIds = new Set<string>(), byDocument = new Map<string, TextBlock[]>();
  let totalText = 0;
  for (const rawDocument of documents) {
    const document = object(rawDocument);
    fields(document, ['id', 'projectId', 'title', 'hash', 'version', 'blockCount', 'sourceUrl', 'sections', 'blocks', 'attribution']);
    const documentId = string(document.id, 100);
    if (documentIds.has(documentId) || document.projectId !== projectId) fail(400, 'Documento duplicado o de otro proyecto.');
    documentIds.add(documentId); string(document.title, 2000); integer(document.version, 1);
    if (document.sourceUrl !== undefined) {
      const source = string(document.sourceUrl, 2000); let url: URL;
      try { url = new URL(source); } catch { fail(400, 'URL de fuente inválida.'); }
      if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'URL de fuente inválida.');
    }
    if (document.attribution !== undefined) validateAttribution(document.attribution);
    const blocks = array(document.blocks, 100000);
    if (!blocks.length || integer(document.blockCount, 1) !== blocks.length) fail(400, 'Conteo de bloques inválido.');
    let offset = 0;
    for (const [index, rawBlock] of blocks.entries()) {
      const block = object(rawBlock); fields(block, ['id', 'index', 'text', 'start', 'end', 'heading', 'page']);
      const blockId = string(block.id, 100), text = string(block.text, 2_000_000);
      if (blockIds.has(blockId)) fail(400, 'ID de bloque duplicado.');
      blockIds.add(blockId);
      if (integer(block.index) !== index || integer(block.start) !== offset || integer(block.end) !== offset + text.length) fail(400, 'Posiciones canónicas inválidas.');
      if (block.heading !== undefined) string(block.heading, 2000);
      if (block.page !== undefined) integer(block.page, 1, 1000000);
      offset += text.length + 2; totalText += text.length;
    }
    if (totalText > 100_000_000) fail(400, 'Dataset demasiado grande para esta carga.');
    const typedBlocks = blocks as TextBlock[];
    if (sha256(typedBlocks.map(block => block.text).join('\n\n')) !== document.hash) fail(400, 'El hash de texto del documento no coincide.');
    for (const rawSection of array(document.sections, 100000)) { const section = object(rawSection); fields(section, ['blockIndex', 'title']); integer(section.blockIndex, 0, blocks.length - 1); string(section.title, 2000); }
    byDocument.set(documentId, typedBlocks);
  }
  const questionIds = new Set<string>();
  for (const rawQuestion of questions) {
    const question = object(rawQuestion);
    fields(question, ['id', 'documentId', 'question', 'questionType', 'answer', 'evidenceSets', 'unanswerable', 'annotation']);
    const questionId = string(question.id, 100), documentId = string(question.documentId, 100);
    const blocks = byDocument.get(documentId);
    if (!blocks || questionIds.has(questionId)) fail(400, 'Pregunta duplicada o sin documento.');
    questionIds.add(questionId); string(question.question, 20000); string(question.answer, 100000, true);
    if (question.questionType !== undefined) choice(question.questionType, ['factual', 'explanatory', 'multi_section']);
    if (question.unanswerable !== undefined && typeof question.unanswerable !== 'boolean') fail(400, 'Estado de respuesta inválido.');
    if (question.annotation !== undefined) {
      const annotation = object(question.annotation);
      fields(annotation, ['mode', 'annotatorIds', 'reviewedAt']);
      const mode = choice(annotation.mode, ['single_annotator', 'independent_review']);
      const annotatorIds = array(annotation.annotatorIds, 100).map(value => string(value, 20));
      if (annotatorIds.some(value => !/^[a-f0-9]{20}$/.test(value)) || new Set(annotatorIds).size !== annotatorIds.length || (mode === 'single_annotator' ? annotatorIds.length !== 1 : annotatorIds.length < 2)) fail(400, 'Identificadores de anotación inválidos para el modo declarado.');
      const reviewedAt = string(annotation.reviewedAt, 100), time = Date.parse(reviewedAt);
      if (!Number.isFinite(time) || new Date(time).toISOString() !== reviewedAt) fail(400, 'Fecha de revisión inválida.');
    }
    const evidence = array(question.evidenceSets, 100).map(set => { for (const span of array(set, 1000)) fields(object(span), ['blockId', 'start', 'end', 'quote']); return validateSpans(set, blocks); });
    if (question.unanswerable ? evidence.length > 0 : !evidence.length || evidence.some(set => !set.length)) fail(400, 'Evidencia incompatible con la pregunta.');
  }
  const dataset = raw as unknown as FrozenDataset;
  if (hashDataset(dataset) !== digest) fail(400, 'El hash del dataset no coincide.');
  return dataset;
}
