import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMethodCosts } from '../scripts/study-readout.js';
import type { ExperimentManifest, ScheduledRun } from '../runner.js';
import type { PaidAttempt } from '../ledger.js';
import type { QueryRun } from '../types.js';

// Auditable synthetic accounting fixture only; no provider calls or main results.
function fixture() {
  const methods = ['jev-scan', 'openai-dense', 'bm25'];
  const schedule: ScheduledRun[] = methods.flatMap(method => ['a1', 'a2', 'b1'].map(questionId => ({ id: `fixture:${method}:${questionId}`, questionId, documentId: questionId[0]!, corpus: 'qasper-test', method: method as ScheduledRun['method'], round: 0, timingSample: false, generate: true })));
  schedule.push({ ...schedule[0]!, id: 'fixture:jev-scan:a1:timing', round: 1, generate: false });
  const manifest = { id: 'fixture', datasetHash: 'a'.repeat(64), config: { structure: false }, schedule } as ExperimentManifest;
  const perQuery: QueryRun[] = schedule.map(row => ({ ...row, status: 'completed', startedAt: '', finishedAt: '', elapsedMs: 1, ranking: [], phases: {}, traces: [] }));
  const report = { perQuery, methods: methods.map(id => ({ id, corpus: 'qasper-test', nQueries: 3, preparationUsd: id === 'openai-dense' ? '.015' : '0', queryMeanUsd: id === 'bm25' ? '0' : '.0055', unknownCostAttempts: 0 })) };
  let index = 0;
  const known = (runId: string, documentId: string, method: string, operation: string, inputTokens: number): PaidAttempt => ({ id: `attempt-${index++}`, logicalKey: runId + operation, runId, documentId, method, operation, model: 'fixture-model', payloadHash: 'b'.repeat(64), reservedUsd: '.1', status: 'completed', costUsd: String(inputTokens / 1e6), inputTokens, outputTokens: 0, price: { input: '1', output: '0', date: 'fixture', source: 'fixture' }, startedAt: '' });
  const attempts = ['jev-scan', 'openai-dense'].flatMap(method => ['a1', 'a2', 'b1'].map((q, i) => known(`fixture:${method}:${q}`, q[0]!, method, method === 'jev-scan' ? 'window' : 'query_embedding', [1000, 3000, 9000][i]!)));
  attempts.push(known('fixture:prepare:a', 'a', 'openai-dense', 'document_embedding', 10000), known('fixture:prepare:b', 'b', 'openai-dense', 'document_embedding', 20000));
  const unknown = (operation: string, runId = 'fixture:jev-scan:a1') => ({ ...known(runId, 'a', 'jev-scan', operation, 0), id: `unknown-${index++}`, status: 'unknown' as const, costUsd: null, inputTokens: undefined, outputTokens: undefined, reservedUsd: '.042', error: 'fetch failed' });
  return { report, manifest, attempts, known, unknown };
}

test('cost audit reproduces document macro rather than question micro and retains all base denominators', () => {
  const f = fixture(), result = auditMethodCosts(f.report, f.manifest, f.attempts);
  const scan = result.methods.find(row => row.method === 'jev-scan')!;
  assert.equal(scan.knownQueryUsdPerAssignedBaseQuery, '0.0055');
  assert.notEqual(scan.knownQueryUsdPerAssignedBaseQuery, String(.013 / 3));
  assert.deepEqual(scan.perDocument.map(row => row.nBaseRuns), [2, 1]);
  assert.equal(scan.baseRetrievalComplete, true); assert.equal(scan.preparationComplete, true);
});

test('one unknown base window marks only base query cost incomplete and retains its reservation separately', () => {
  const f = fixture(); f.attempts.push(f.unknown('window')); f.report.methods[0]!.unknownCostAttempts = 1;
  f.report.perQuery[0]!.status = 'failed';
  const scan = auditMethodCosts(f.report, f.manifest, f.attempts).methods[0]!;
  assert.equal(scan.nBaseRuns, 3); assert.equal(scan.knownQueryUsdPerAssignedBaseQuery, '0.0055');
  assert.equal(scan.preparationComplete, true); assert.equal(scan.baseRetrievalComplete, false);
  assert.equal(scan.categories.baseRetrieval.unknownAttempts, 1);
  assert.equal(scan.categories.baseRetrieval.knownSubtotalUsd, '.013'.replace(/^\./, '0.'));
  assert.equal(scan.categories.baseRetrieval.unresolvedReservationUsd, '0.042');
});

test('generation-only and timing-only unknowns do not contaminate exact preparation/base-query estimands', () => {
  for (const operation of ['generation', 'window']) {
    const f = fixture(); f.attempts.push(f.unknown(operation, operation === 'window' ? 'fixture:jev-scan:a1:timing' : 'fixture:jev-scan:a1')); f.report.methods[0]!.unknownCostAttempts = 1;
    const scan = auditMethodCosts(f.report, f.manifest, f.attempts).methods[0]!;
    assert.equal(scan.preparationComplete, true); assert.equal(scan.baseRetrievalComplete, true);
    assert.equal(scan.categories[operation === 'generation' ? 'generation' : 'repeatedRetrieval'].unknownAttempts, 1);
  }
});

test('shared preparation is attributed as in the report but counted once in the experiment', () => {
  const f = fixture(); f.manifest.config.structure = true;
  f.attempts.push(f.known('fixture:prepare:a', 'a', 'shared-structure', 'structure', 3000), f.known('fixture:prepare:b', 'b', 'shared-structure', 'structure', 5000));
  for (const row of f.report.methods) row.preparationUsd = row.id === 'openai-dense' ? '.019' : '.004';
  const result = auditMethodCosts(f.report, f.manifest, f.attempts);
  assert.deepEqual(result.methods.map(row => row.knownPreparationUsdPerDocument), ['0.004', '0.019', '0.004']);
  assert.equal(result.experiment.knownSubtotalUsd, '0.064');
});

test('cost audit refuses changed report subtotals, unmatched assignments, duplicate attempts and unknown-flag drift', () => {
  for (const mutation of ['subtotal', 'assignment', 'duplicate', 'flag', 'missing-base']) {
    const f = fixture();
    if (mutation === 'subtotal') f.report.methods[0]!.queryMeanUsd = '.5';
    if (mutation === 'assignment') f.attempts[0]!.runId = 'fixture:unassigned';
    if (mutation === 'duplicate') f.attempts.push(f.attempts[0]!);
    if (mutation === 'flag') f.report.methods[0]!.unknownCostAttempts = 1;
    if (mutation === 'missing-base') f.report.perQuery.shift();
    assert.throws(() => auditMethodCosts(f.report, f.manifest, f.attempts));
  }
});
