import { getEncoding } from 'js-tiktoken';
import ranks from 'js-tiktoken/ranks/cl100k_base';
import type { EvidenceSpan, RetrievalMetrics } from './types.js';
import { mean, quantile, seededRandom } from './util.js';

export type Interval = { start: number; end: number };
const encoder = getEncoding('cl100k_base');
// Decode vocabulary bytes, not each token as UTF-8: a token can end inside an emoji.
const byteLengths = new Map<number, number>();
for (const line of ranks.bpe_ranks.split('\n').filter(Boolean)) {
  const [, first, ...tokens] = line.split(' ');
  tokens.forEach((token, i) => byteLengths.set(Number(first) + i, Buffer.from(token, 'base64').length));
}
export class CanonicalTokens {
  readonly byteOffsets: Uint32Array;
  readonly utf16Bytes: Int32Array;
  readonly length: number;
  constructor(readonly text: string) {
    const tokens = encoder.encode(text, [], []);
    this.length = tokens.length;
    this.byteOffsets = new Uint32Array(tokens.length + 1);
    for (let i = 0; i < tokens.length; i++) {
      const size = byteLengths.get(tokens[i]);
      if (size === undefined) throw new Error('Unknown canonical token bytes.');
      this.byteOffsets[i + 1] = this.byteOffsets[i] + size;
    }
    this.utf16Bytes = new Int32Array(text.length + 1).fill(-1);
    let index = 0, bytes = 0;
    for (const point of text) { this.utf16Bytes[index] = bytes; index += point.length; bytes += Buffer.byteLength(point); }
    this.utf16Bytes[text.length] = bytes;
    if (bytes !== this.byteOffsets[tokens.length]) throw new Error('Canonical byte/token alignment failed.');
  }
  span(span: Interval): Interval {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end > this.text.length || span.end <= span.start
      || this.utf16Bytes[span.start] < 0 || this.utf16Bytes[span.end] < 0) throw new Error('Invalid UTF-16 source span.');
    const a = this.utf16Bytes[span.start], b = this.utf16Bytes[span.end];
    let lo = 0, hi = this.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.byteOffsets[mid + 1] <= a) lo = mid + 1; else hi = mid; }
    const start = lo; lo = 0; hi = this.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.byteOffsets[mid] < b) lo = mid + 1; else hi = mid; }
    return { start, end: lo };
  }
}
export function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const item of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (item.end <= item.start) continue;
    const last = result.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}
export const intervalSize = (spans: Interval[]) => union(spans).reduce((sum, x) => sum + x.end - x.start, 0);
export function intersectionSize(a: Interval[], b: Interval[]): number {
  const left = union(a), right = union(b); let i = 0, j = 0, size = 0;
  while (i < left.length && j < right.length) { size += Math.max(0, Math.min(left[i].end, right[j].end) - Math.max(left[i].start, right[j].start)); if (left[i].end <= right[j].end) i++; else j++; }
  return size;
}

/** Exact cardinality-constrained coverage of intervals, after compressing away non-gold tokens. */
export function oracleAtK(chunks: Interval[], gold: Interval[], k = 5, unitBalanced = false): { covered: number; exact: true } {
  if (!Number.isInteger(k) || k < 1) throw new Error('Invalid oracle k.');
  const merged = unitBalanced ? gold : union(gold);
  const prefix = (p: number) => merged.reduce((n, s) => n + Math.max(0, Math.min(p, s.end) - s.start) / (unitBalanced ? (s.end - s.start) * merged.length : 1), 0);
  const mapped = chunks.map(c => ({ start: prefix(c.start), end: prefix(c.end) })).filter(c => c.end > c.start).sort((a, b) => a.start - b.start || b.end - a.end);
  // A contained interval cannot improve an at-most-k union; discard it exactly.
  const candidates: Interval[] = [];
  for (const item of mapped) if (!candidates.length || item.end > candidates.at(-1)!.end) candidates.push(item);
  if (!candidates.length) return { covered: 0, exact: true };
  let previous = candidates.map(c => c.end - c.start), best = Math.max(...previous);
  for (let count = 2; count <= Math.min(k, candidates.length); count++) {
    const current = candidates.map(c => c.end - c.start);
    for (let j = 0; j < candidates.length; j++) {
      for (let i = 0; i < j; i++) current[j] = Math.max(current[j], previous[i] + candidates[j].end - Math.max(candidates[j].start, candidates[i].end));
    }
    previous = current; best = Math.max(best, ...current);
  }
  return { covered: best, exact: true };
}
export function evaluateRetrieval(tokens: CanonicalTokens, chunks: Interval[], retrieved: Interval[], evidenceSets: EvidenceSpan[][], k = 5): RetrievalMetrics {
  if (!evidenceSets.length || evidenceSets.some(s => !s.length)) throw new Error('Answerable evaluation requires complete nonempty alternative evidence sets.');
  const candidateTokens = chunks.map(c => tokens.span(c));
  const resultTokens = union(retrieved.slice(0, k).map(c => tokens.span(c)));
  const retrievedTokens = intervalSize(resultTokens);
  const alternatives = evidenceSets.map(set => {
    const units = set.map(s => tokens.span(s)), gold = union(units), goldTokens = intervalSize(gold), overlap = intersectionSize(gold, resultTokens);
    const coverage = mean(units.map(unit => intersectionSize([unit], resultTokens) / (unit.end - unit.start)));
    const oracle = oracleAtK(candidateTokens, units, k, true);
    return { coverage, precision: retrievedTokens ? overlap / retrievedTokens : 0, completeGold: overlap === goldTokens,
      oracleCoverage: Math.min(1, oracle.covered), normalizedCoverage: oracle.covered ? Math.min(1, coverage / oracle.covered) : 0, hit: overlap > 0, goldTokens, retrievedTokens, oracleExact: true as const };
  });
  // Each score is maximized over complete references, never a union of annotators' alternatives.
  const best = alternatives.sort((a, b) => b.coverage - a.coverage)[0], oracleCoverage = Math.max(...alternatives.map(x => x.oracleCoverage));
  return { ...best, precision: Math.max(...alternatives.map(x => x.precision)), completeGold: alternatives.some(x => x.completeGold), oracleCoverage, normalizedCoverage: oracleCoverage ? Math.min(1, best.coverage / oracleCoverage) : 0 };
}
export function clusterBootstrap(rows: Array<{ documentId: string; value: number }>, samples = 10000, seed = 42) {
  if (!rows.length) throw new Error('Bootstrap requires observations.');
  const groups = new Map<string, number[]>();
  for (const row of rows) { if (!Number.isFinite(row.value)) throw new Error('Nonfinite bootstrap observation.'); const group = groups.get(row.documentId) ?? []; group.push(row.value); groups.set(row.documentId, group); }
  const clusters = [...groups.values()].map(mean), random = seededRandom(seed), boot: number[] = [];
  for (let b = 0; b < samples; b++) { let sum = 0; for (let j = 0; j < clusters.length; j++) sum += clusters[Math.floor(random() * clusters.length)]; boot.push(sum / clusters.length); }
  return { mean: mean(clusters), low: quantile(boot, 0.025), high: quantile(boot, 0.975), clusters: groups.size, samples, seed };
}
