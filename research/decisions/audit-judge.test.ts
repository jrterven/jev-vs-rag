import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCompletedScore } from './audit-judge.js';

const call = (schemaName: string, response: unknown) => ({ schemaName, response, rawText: JSON.stringify(response), status: 'completed', model: 'gpt-6.1-sol', attemptId: 'test-attempt' });
const accuracy = () => ({ status: 'completed', metric: 'answer_accuracy', score: .75, calls: [call('AnswerAccuracyOutput', { rating: 2 }), call('AnswerAccuracyOutput', { rating: 4 })] });
const faithful = () => ({ status: 'completed', metric: 'faithfulness', score: 2 / 3, calls: [
  call('StatementGeneratorOutput', { statements: ['A', 'B', 'C'] }),
  call('NLIStatementOutput', { statements: [{ statement: 'A', verdict: 1 }, { statement: 'B', verdict: 0 }, { statement: 'C', verdict: 1 }] }),
] });

test('recomputes both official metrics from provider JSON', () => {
  assert.equal(verifyCompletedScore(accuracy()), .75);
  assert.equal(verifyCompletedScore(faithful()), 2 / 3);
  assert.equal(verifyCompletedScore({ status: 'error', score: null }), null);
  assert.equal(verifyCompletedScore({ status: 'unscorable', score: null }), null);
});
test('cannot admit a one-judge fallback or a altered score', () => {
  const row = accuracy(); row.calls.pop(); assert.throws(() => verifyCompletedScore(row), /both official/);
  assert.throws(() => verifyCompletedScore({ ...accuracy(), score: .5 }), /recomputation differs/);
  assert.throws(() => verifyCompletedScore({ status: 'error', score: 0 }), /has a score/);
});
test('cannot replace raw provider JSON with a different parsed value', () => {
  const row = accuracy(); row.calls[0].response = { rating: 4 };
  assert.throws(() => verifyCompletedScore(row), /actual provider text/);
});
test('faithfulness cannot reorder, drop or fabricate statements', () => {
  for (const statements of [[{ statement: 'A', verdict: 1 }], [{ statement: 'B', verdict: 1 }, { statement: 'A', verdict: 0 }, { statement: 'C', verdict: 1 }]]) {
    const row = faithful(); row.calls[1] = call('NLIStatementOutput', { statements });
    assert.throws(() => verifyCompletedScore(row), /statements\/verdicts differ/);
  }
  const row = faithful(); row.calls[0] = call('StatementGeneratorOutput', { statements: [] });
  assert.throws(() => verifyCompletedScore(row), /requires statements/);
});
test('ratings and verdicts must have official discrete values', () => {
  const a = accuracy(); a.calls[0] = call('AnswerAccuracyOutput', { rating: true });
  assert.throws(() => verifyCompletedScore(a), /Invalid official/);
  const f = faithful(); f.calls[1] = call('NLIStatementOutput', { statements: [{ statement: 'A', verdict: 1 }, { statement: 'B', verdict: .5 }, { statement: 'C', verdict: 1 }] });
  assert.throws(() => verifyCompletedScore(f), /verdicts differ/);
});
