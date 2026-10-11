import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costCurve, costBreakEven, studyStatistics, type ScoredQuery } from '../statistics.js';

test('paired statistics weight documents equally, include failures, and exclude negatives and timing replicas', () => {
  const rows: ScoredQuery[] = [];
  for (const [documentId, questions, score] of [['a', 9, 1], ['b', 1, 0]] as const) for (let i = 0; i < questions; i++) {
    for (const method of ['openai-dense', 'jev-scan']) rows.push({ questionId: `${documentId}${i}`, documentId, corpus: 'books', method, round: 0, metrics: { coverage: method === 'jev-scan' ? score : 0.25 } });
  }
  rows.push({ ...rows[0], round: 1, metrics: { coverage: 1 } }, { ...rows[0], questionId: 'negative', metrics: null });
  const out = studyStatistics(rows, { iterations: 1000 });
  assert.equal(out.pairedComparisons[0].mean, 0.25);
  assert.equal(out.pairedComparisons[0].nPairs, 10);
  assert.equal(out.pairedComparisons[0].clusters, 2);
  assert.deepEqual(out.bookSensitivity.find(x => x.method === 'jev-scan')!.leaveOneBookOut.map(x => x.coverage), [0, 1]);
  assert.deepEqual(out, studyStatistics(rows, { iterations: 1000 }));
});

test('unmatched queries are explicit and duplicate observations are refused', () => {
  const row: ScoredQuery = { questionId: 'q', documentId: 'd', corpus: 'qasper', method: 'openai-dense', round: 0, metrics: { coverage: 0.5 } };
  const rows = [row, { ...row, method: 'jev-scan' }, { ...row, questionId: 'missing' }];
  const out = studyStatistics(rows, { iterations: 10 });
  assert.equal(out.pairedComparisons[0].missingMethod, 1);
  assert.equal(out.pairedComparisons[0].missingBaseline, 0);
  assert.throws(() => studyStatistics([...rows, row]), /Duplicate/);
  assert.throws(() => studyStatistics([row, { ...row, method: 'jev-scan', documentId: 'other' }]), /changed documents/);
});

test('cost curves preserve tiny decimal costs and never price unknown attempts as zero', () => {
  const curve = costCurve('0.00000001', '0.00000002')!;
  assert.deepEqual(curve.map(x => x.queries), [1, 5, 10, 50, 100, 1000]);
  assert.equal(curve[5].totalUsd, '0.00002001');
  assert.equal(curve[5].amortizedUsd, '0.00000002001');
  assert.equal(costCurve('0', '0', 1), null);
});

test('break-even is reported only for positive crossings of complete cost lines', () => {
  const a = { preparationUsd: '0', queryMeanUsd: '0.01', unknownCostAttempts: 0 };
  const b = { preparationUsd: '1', queryMeanUsd: '0', unknownCostAttempts: 0 };
  assert.equal(costBreakEven(a, b).queries, '100');
  assert.equal(costBreakEven(a, a).reason, 'identical_lines');
  assert.equal(costBreakEven(a, { ...a, preparationUsd: '1' }).reason, 'parallel_lines');
  assert.equal(costBreakEven(a, { ...b, unknownCostAttempts: 1 }).reason, 'incomplete_costs');
  assert.equal(costBreakEven(a, { ...b, queryMeanUsd: '0.02' }).reason, 'no_positive_crossing');
});
