import { countTokens } from '../server/extraction.js';
import type { EvidenceSpan, FrozenQuestion, GenerationContextManifest, PreparedDocument, RankedChunk } from './types.js';
import { union, type Interval } from './metrics.js';
export interface GenerationContext { label: string; text: string; spans: EvidenceSpan[] }
export const contextContentTokens = (contexts: GenerationContext[]) => countTokens(contexts.map(c => c.text).join('\n\n'));
export function subtractIntervals(span: Interval, previous: Interval[]): Interval[] {
  const result: Interval[] = []; let cursor = span.start;
  for (const cut of union(previous)) { if (cut.end <= cursor || cut.start >= span.end) continue; if (cut.start > cursor) result.push({ start: cursor, end: Math.min(cut.start, span.end) }); cursor = Math.max(cursor, cut.end); if (cursor >= span.end) break; }
  if (cursor < span.end) result.push({ start: cursor, end: span.end }); return result;
}
function contextsFromSpans(doc: PreparedDocument, input: Interval[], maxContentTokens: number): GenerationContext[] {
  const contexts: GenerationContext[] = [], seen: Interval[] = [];
  for (const span of input) {
    const fresh = subtractIntervals(span, seen); seen.push(span);
    const spans = fresh.flatMap(part => doc.blocks.filter(b => b.start < part.end && b.end > part.start).map(b => { const start = Math.max(b.start, part.start), end = Math.min(b.end, part.end); return { blockId: b.id, start, end, quote: doc.text.slice(start, end) }; }));
    if (!spans.length) continue;
    const text = spans.map(s => s.quote).join('\n\n'); contexts.push({ label: `C${contexts.length + 1}`, text, spans });
  }
  if (contextContentTokens(contexts) > maxContentTokens) throw new Error('Complete deduplicated context exceeds content budget; no silent truncation.');
  return contexts;
}
/** Select complete, deduplicated contributions from the top five in rank order.
 * An omitted chunk never marks its source text as seen; later chunks may still fit.
 * Content accounting includes the separators used in the actual excerpt text.
 */
export function planRetrievalContext(doc: PreparedDocument, ranking: RankedChunk[], maxContentTokens = 2500): { contexts: GenerationContext[]; manifest: GenerationContextManifest } {
  if (!Number.isSafeInteger(maxContentTokens) || maxContentTokens < 0) throw new Error('Invalid generation content budget.');
  const byId = new Map(doc.chunks.map(c => [c.id, c]));
  const selected: Interval[] = [], processed = new Set<string>();
  const manifest: GenerationContextManifest = { policy: 'ranked-complete-deduplicated-v1', selectedChunkIds: [], omittedChunkIds: [], contentTokens: 0, budget: maxContentTokens };
  let contexts: GenerationContext[] = [];
  for (const candidate of ranking.slice(0, 5)) {
    const chunk = byId.get(candidate.chunkId);
    if (!chunk) throw new Error('Invalid generation candidate.');
    if (processed.has(chunk.id)) continue;
    processed.add(chunk.id);
    const proposed = contextsFromSpans(doc, [...selected, chunk], Infinity);
    const contentTokens = contextContentTokens(proposed);
    if (contentTokens > maxContentTokens) { manifest.omittedChunkIds.push(chunk.id); continue; }
    selected.push(chunk); manifest.selectedChunkIds.push(chunk.id);
    contexts = proposed; manifest.contentTokens = contentTokens;
  }
  return { contexts, manifest };
}
export function retrievalContext(doc: PreparedDocument, ranking: RankedChunk[], maxContentTokens = 2500): GenerationContext[] {
  return planRetrievalContext(doc, ranking, maxContentTokens).contexts;
}
export function oracleContext(doc: PreparedDocument, question: FrozenQuestion, maxContentTokens = 2500): GenerationContext[] {
  if (question.unanswerable) return [];
  const alternatives = question.evidenceSets.map((spans, index) => ({ spans, index, tokens: countTokens(spans.map(s => s.quote).join('\n\n')) })).sort((a, b) => a.tokens - b.tokens || a.index - b.index);
  for (const candidate of alternatives) { try { return contextsFromSpans(doc, candidate.spans, maxContentTokens); } catch (error) { if (!(error instanceof Error) || !error.message.startsWith('Complete deduplicated context exceeds')) throw error; } }
  throw new Error('Oracle full gold exceeds 2500 content tokens; control ineligible, no truncated oracle.');
}
