import type { AnnotationDraft, AnswerRating, DocumentInfo, EvidenceSpan, TextBlock } from '../shared/types.js';
export class ApiError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
export function fail(status: number, message: string): never { throw new ApiError(status, message); }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Objeto inválido.'); return value as Record<string, unknown>; }
export function string(value: unknown, max = 10000, optional = false): string { if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) fail(400, 'Texto inválido.'); return value; }
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(400, 'Número inválido.'); return Number(value); }
export function choice<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) fail(400, 'Opción inválida.'); return value as T; }
export function array(value: unknown, max = 10000): unknown[] { if (!Array.isArray(value) || value.length > max) fail(400, 'Lista inválida.'); return value as unknown[]; }
export function validateAttribution(value: unknown): NonNullable<DocumentInfo['attribution']> {
  const raw = object(value);
  if (Object.keys(raw).some(key => !['text', 'url', 'license', 'licenseUrl', 'notice'].includes(key))) fail(400, 'Atribución inválida.');
  const link = (value: unknown) => {
    const text = string(value, 2000); let url: URL;
    try { url = new URL(text); } catch { fail(400, 'URL de atribución inválida.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(400, 'URL de atribución inválida.');
    return text;
  };
  return { text: string(raw.text, 10000), url: link(raw.url), license: string(raw.license, 2000), licenseUrl: link(raw.licenseUrl), ...(raw.notice !== undefined ? { notice: string(raw.notice, 10000) } : {}) };
}
function safeBoundary(text: string, offset: number): boolean { return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)); }
export function validateSpans(value: unknown, blocks: TextBlock[]): EvidenceSpan[] {
  const byId = new Map(blocks.map(block => [block.id, block]));
  return array(value, 1000).map(raw => {
    const span = object(raw), block = byId.get(string(span.blockId, 100));
    if (!block) fail(400, 'Bloque de evidencia ajeno al documento.');
    const start = integer(span.start), end = integer(span.end), quote = string(span.quote, 1_000_000);
    if (start < block.start || end > block.end || end <= start) fail(400, 'Evidencia fuera del bloque. Seleccione cada bloque por separado.');
    const localStart = start - block.start, localEnd = end - block.start;
    if (!safeBoundary(block.text, localStart) || !safeBoundary(block.text, localEnd) || block.text.slice(localStart, localEnd) !== quote) fail(400, 'El texto y las posiciones de evidencia no coinciden.');
    return { blockId: block.id, start, end, quote };
  });
}
export function validateRating(value: unknown, complete: boolean): AnswerRating {
  const rating = object(value);
  if (![0, 1, 2, null].includes(rating.correctness as number | null) || (complete && rating.correctness === null && !(typeof rating.issue === 'string' && rating.issue.trim()))) fail(400, 'Seleccione una puntuación de corrección.');
  return { correctness: rating.correctness as AnswerRating['correctness'],
    unsupported: choice(rating.unsupported, ['yes', 'no', 'uncertain']),
    citations: choice(rating.citations, ['supported', 'partial', 'unsupported', 'not_applicable']),
    abstention: choice(rating.abstention, ['justified', 'unjustified', 'not_applicable']),
    comment: string(rating.comment, 10000, true), issue: string(rating.issue, 10000, true) };
}
export function validateDraft(value: unknown, blocks: TextBlock[], complete: boolean, evaluation: boolean): AnnotationDraft {
  const raw = object(value);
  if (raw.unanswerable !== undefined && typeof raw.unanswerable !== 'boolean') fail(400, 'Estado sin respuesta inválido.');
  const draft: AnnotationDraft = {
    question: string(raw.question, 20000, !complete || evaluation),
    questionType: choice(raw.questionType, ['factual', 'explanatory', 'multi_section']),
    answer: string(raw.answer, 100000, !complete || evaluation || raw.unanswerable === true),
    evidenceSets: array(raw.evidenceSets, 100).map(set => validateSpans(set, blocks)),
  };
  if (raw.unanswerable !== undefined) draft.unanswerable = raw.unanswerable as boolean;
  if (raw.note !== undefined) draft.note = string(raw.note, 10000, true);
  if (raw.rating !== undefined) draft.rating = validateRating(raw.rating, complete && evaluation);
  if (complete && evaluation && !draft.rating) fail(400, 'Falta la valoración.');
  if (complete && !evaluation && !draft.unanswerable && (!draft.evidenceSets.length || draft.evidenceSets.some(set => !set.length))) fail(400, 'Añada evidencia o marque la pregunta sin respuesta.');
  if (draft.unanswerable && draft.evidenceSets.length) fail(400, 'Una pregunta sin respuesta no debe tener evidencia de respuesta.');
  return draft;
}
