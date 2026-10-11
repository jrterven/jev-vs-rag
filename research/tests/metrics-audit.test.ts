import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalTokens, clusterBootstrap, evaluateRetrieval, intersectionSize, oracleAtK, type Interval } from '../metrics.js';
import { seededRandom } from '../util.js';

const near = (actual: number, expected: number, tolerance = 1e-10) => assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function evidence(text: string, start: number, end: number) { return { blockId: 'source', start, end, quote: text.slice(start, end) }; }

function bruteOracle(chunks: Interval[], gold: Interval[], k: number, unitBalanced: boolean): number {
  let best = 0;
  for (let bits = 0; bits < 2 ** chunks.length; bits++) {
    const selected = chunks.filter((_chunk, index) => (bits & (1 << index)) !== 0);
    if (selected.length > k) continue;
    const value = unitBalanced
      ? gold.reduce((sum, unit) => sum + intersectionSize(selected, [unit]) / (unit.end - unit.start), 0) / gold.length
      : intersectionSize(selected, gold);
    best = Math.max(best, value);
  }
  return best;
}

test('normalized evidence coverage uses global EC divided by the global achievable oracle', () => {
  const text = 'a '.repeat(120), tokens = new CanonicalTokens(text);
  const chunks = [{ start: 60, end: 100 }, { start: 0, end: 100 }];
  // The second reference is mostly unreachable, so maximizing per-reference ratios
  // would falsely give 1 even though a different passage fully covers reference one.
  const metrics = evaluateRetrieval(tokens, chunks, [chunks[0]!], [[evidence(text, 0, 100)], [evidence(text, 60, 194)]], 1);
  assert(metrics.coverage > 0 && metrics.coverage < 0.5);
  assert.equal(metrics.oracleCoverage, 1);
  near(metrics.normalizedCoverage, metrics.coverage / metrics.oracleCoverage);
  assert.equal(metrics.completeGold, false);
});

test('the exact interval oracle agrees with exhaustive subsets for overlapping, contained and disjoint intervals', () => {
  const random = seededRandom(1729);
  const cases: Array<{ chunks: Interval[]; gold: Interval[] }> = [
    { chunks: [{ start: 0, end: 10 }, { start: 2, end: 4 }, { start: 0, end: 10 }, { start: 9, end: 15 }], gold: [{ start: 1, end: 3 }, { start: 7, end: 14 }] },
    { chunks: [{ start: 0, end: 2 }, { start: 8, end: 10 }], gold: [{ start: 3, end: 6 }] },
    { chunks: [{ start: 0, end: 7 }, { start: 4, end: 12 }, { start: 9, end: 20 }], gold: [{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 15, end: 20 }] },
  ];
  for (let sample = 0; sample < 80; sample++) {
    const interval = (): Interval => { const start = Math.floor(random() * 24); return { start, end: start + 1 + Math.floor(random() * 12) }; };
    cases.push({ chunks: Array.from({ length: 7 }, interval), gold: Array.from({ length: 1 + Math.floor(random() * 4) }, interval) });
  }
  for (const [index, fixture] of cases.entries()) for (const k of [1, 2, 3]) for (const unitBalanced of [false, true]) {
    const actual = oracleAtK(fixture.chunks, fixture.gold, k, unitBalanced);
    const expected = bruteOracle(fixture.chunks, fixture.gold, k, unitBalanced);
    assert.equal(actual.exact, true);
    assert(Math.abs(actual.covered - expected) <= 1e-10, `case ${index}, k=${k}, balanced=${unitBalanced}: ${actual.covered} != ${expected}`);
  }
});

test('short and long evidence units have equal weight and overlapping retrieval is counted once', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const tokens = new CanonicalTokens(text), short = evidence(text, 0, 5), long = evidence(text, 6, text.length);
  const chunks = [{ start: short.start, end: short.end }, { start: long.start, end: long.end }];
  const metric = evaluateRetrieval(tokens, chunks, [chunks[0]!, chunks[0]!], [[short, long]], 2);
  assert(tokens.span(long).end - tokens.span(long).start > 5 * (tokens.span(short).end - tokens.span(short).start));
  near(metric.coverage, 0.5);
  assert.equal(metric.retrievedTokens, tokens.span(short).end - tokens.span(short).start);
  near(metric.precision, 1);
  assert.equal(metric.completeGold, false);
});

test('alternative references remain complete sets instead of a mixed choice of convenient evidence units', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta';
  const a = evidence(text, 0, 5), b = evidence(text, 6, 10), c = evidence(text, 11, 16), d = evidence(text, 17, 22);
  const chunks = [a, b, c, d].map(({ start, end }) => ({ start, end }));
  const metric = evaluateRetrieval(new CanonicalTokens(text), chunks, [chunks[0]!, chunks[3]!], [[a, b], [c, d]], 2);
  near(metric.coverage, 0.5);
  assert.equal(metric.completeGold, false);
  near(metric.oracleCoverage, 1);
});

test('cluster bootstrap macro-averages documents and deterministically resamples whole document units', () => {
  const rows = [...Array.from({ length: 9 }, () => ({ documentId: 'many-questions', value: 1 })), { documentId: 'one-question', value: 0 }];
  const result = clusterBootstrap(rows, 1000, 42);
  assert.equal(result.mean, 0.5); assert.equal(result.clusters, 2); assert.equal(result.samples, 1000);
  assert.equal(result.low, 0); assert.equal(result.high, 1);
  assert.deepEqual(result, clusterBootstrap(rows, 1000, 42));
  assert.throws(() => clusterBootstrap([], 1000, 42));
});
