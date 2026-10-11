import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticRetention, auditAttemptCost, generationInputFacts, summarizeGenerationInputs } from '../scripts/study-readout.js';
import type { FrozenQuestion, PreparedDocument, QueryRun } from '../types.js';
import type { PaidAttempt } from '../ledger.js';
import { textBlocks } from '../datasets.js';
import { countTokens } from '../../server/extraction.js';
import { planRetrievalContext } from '../context.js';
import { generationBody } from '../ragas/export.js';
import { loadConfig, type ScheduledRun } from '../runner.js';
import { hashObject } from '../util.js';

const document = { id: 'doc', text: 'alpha beta gamma delta epsilon zeta', tokenCount: 6, blocks: [], chunks: [
  ['a', 0, 5], ['b', 6, 10], ['c', 11, 16], ['d', 17, 22], ['e', 23, 30], ['f', 31, 35],
].map(([id, start, end], ordinal) => ({ id: String(id), start: Number(start), end: Number(end), ordinal, text: '', references: [], path: [] })) } as PreparedDocument;
const question = { id: 'q', documentId: 'doc', question: 'test', answer: 'alpha zeta', evidenceSets: [[{ blockId: 'b', start: 0, end: 5, quote: 'alpha' }, { blockId: 'b', start: 31, end: 35, quote: 'zeta' }]] } as FrozenQuestion;
const trace = (stage: string, level: number, candidateIds: string[], retainedIds: string[]) => ({ stage, level, candidateIds, retainedIds, payloadHash: 'hash' });
const run = (traces: QueryRun['traces'], ranking: string[]) => ({ id: 'run', method: 'jev-scan', status: 'completed', questionId: 'q', documentId: 'doc', corpus: 'test', traces, ranking: ranking.map(chunkId => ({ chunkId, score: 1 })) }) as QueryRun;

test('semantic retention distinguishes first selection, final input and final-five', () => {
  const result = semanticRetention(run([
    trace('window', 0, ['a', 'b', 'c'], ['a', 'b']), trace('window', 0, ['d', 'e', 'f'], ['d', 'f']),
    trace('retained', 0, ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'd', 'f']),
    trace('retained', 1, ['a', 'b', 'd', 'f'], ['a', 'b', 'd']),
    trace('final', 2, ['a', 'b', 'd'], ['b', 'd']),
  ], ['b', 'd']), document, question)!;
  assert.deepEqual(result.phases.map(p => p.coverage), [1, 1, 0.5, 0]);
  assert.deepEqual(result.phases.map(p => p.candidates), [6, 4, 3, 2]);
  assert.equal(result.finalLevel, 2);
});

test('a one-window final does not masquerade as an intermediate selection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const result = semanticRetention(run([trace('window', 0, ids, ids), trace('final', 0, ids, ['a', 'b', 'c', 'd', 'e'])], ['a', 'b', 'c', 'd', 'e']), document, question)!;
  assert.deepEqual(result.phases.map(p => p.coverage), [1, 0.5, 1, 0.5]);
  assert.deepEqual(result.levels, []);
  assert.throws(() => semanticRetention(run([trace('window', 0, ids.slice(1), ids.slice(1)), trace('final', 0, ids.slice(1), ['b'])], ['b']), document, question), /initial coverage/);
});

test('historical cost reconciliation replaces regular input with read/write cache rates', () => {
  const attempt = { id: 'x', inputTokens: 1000, outputTokens: 100, cachedTokens: 200, cacheWriteTokens: 300, costUsd: '0.00277', price: { input: '2', cachedInput: '0.1', cacheWrite: '2.5', output: '10' } } as PaidAttempt;
  assert.equal(auditAttemptCost(attempt), '0.00277');
  assert.throws(() => auditAttemptCost({ ...attempt, costUsd: '0.00377' }), /differs/);
  assert.equal(auditAttemptCost({ ...attempt, costUsd: null }), null);
});

test('historical input audit exposes separator-driven five-to-four passage loss and rejects a changed payload', () => {
  const config = loadConfig(), paragraph = 'star '.repeat(499) + 'star';
  assert.equal(countTokens(paragraph), 500);
  const blocks = textBlocks('packing-doc', Array.from({ length: 5 }, () => ({ text: paragraph })));
  const text = blocks.map(b => b.text).join('\n\n');
  const doc: PreparedDocument = { id: 'packing-doc', text, blocks, tokenCount: countTokens(text), chunks: blocks.map((b, ordinal) => ({ id: `c${ordinal}`, ordinal, text: b.text, start: b.start, end: b.end, references: [], path: [] })) };
  const last = blocks[4], q: FrozenQuestion = { id: 'packing-q', documentId: doc.id, question: 'What is in the last source paragraph?', answer: paragraph, unanswerable: false, evidenceSets: [[{ blockId: last.id, start: last.start, end: last.end, quote: last.text }]] };
  const retrieval = { ...run([], doc.chunks.map(c => c.id)), id: 'packing-run', method: 'bm25', questionId: q.id, documentId: doc.id, corpus: 'qasper-test', round: 0 } as QueryRun;
  const plan = planRetrievalContext(doc, retrieval.ranking);
  retrieval.generation = { text: 'No evidence in the supplied excerpts.', citations: [], abstained: true, elapsedMs: 1, contextManifest: plan.manifest };
  const attempt = { id: 'paid-packing', runId: retrieval.id, documentId: doc.id, method: retrieval.method, operation: 'generation', status: 'completed', model: config.models.generation, reportedModel: config.models.generation, payloadHash: hashObject(generationBody(q, plan.contexts, retrieval.method, config)) } as PaidAttempt;
  const facts = generationInputFacts(retrieval, doc, q, config, [attempt])!;
  assert.equal(facts.retrievedPassages, 5); assert.equal(facts.contexts, 4); assert.equal(facts.selectedPassages, 4);
  assert.equal(facts.omittedPassages, 1); assert.deepEqual(facts.omittedChunkIds, ['c4']);
  assert.equal(facts.contentTokens, 2003); assert.equal(facts.contentBudget, 2500);
  assert.equal(facts.fewerContextsThanRetrieved, true); assert(facts.omittedSourceTokens! > 0);
  assert.equal(facts.retrievedEvidenceCoverage, 1); assert.equal(facts.consumedEvidenceCoverage, 0);
  assert.throws(() => generationInputFacts(retrieval, doc, q, config, [{ ...attempt, payloadHash: 'different' }]), /historical generation input/);
  assert.throws(() => generationInputFacts({ ...retrieval, generation: { ...retrieval.generation!, contextManifest: { ...plan.manifest, contentTokens: 2500 } } }, doc, q, config, [attempt]), /context manifest differs/);
  const legacy = { ...retrieval, generation: { ...retrieval.generation, contextManifest: undefined } };
  assert.deepEqual(generationInputFacts(legacy, doc, q, config, [attempt]), facts, 'legacy records still require an exact historical payload');

  const oversized = { ...retrieval, id: 'oversized-oracle', method: 'oracle', generation: undefined, generationError: 'Oracle full gold exceeds 2500 content tokens; control ineligible, no truncated oracle.' } as QueryRun;
  const failed = { ...retrieval, id: 'failed-generation', generation: undefined, generationError: 'Provider failed.' };
  const schedule = [retrieval, failed, oversized].map(r => ({ id: r.id, questionId: q.id, documentId: doc.id, corpus: r.corpus, method: r.method, round: 0, generate: true, timingSample: false })) as ScheduledRun[];
  const summaries = summarizeGenerationInputs(schedule, [retrieval, failed, oversized], [facts]);
  const ordinary = summaries.find(s => s.method === 'bm25')!, oracle = summaries.find(s => s.method === 'oracle')!;
  assert.equal(ordinary.scheduled, 2); assert.equal(ordinary.completed, 1); assert.equal(ordinary.failedOrUnavailable, 1);
  assert.equal(ordinary.fewerContextsThanRetrieved, 1); assert.equal(ordinary.omittedPassageGenerations, 1);
  assert.equal(ordinary.contentTokensMean, 2003, 'failed generation must not dilute effective-token means');
  assert.equal(ordinary.retrievedEvidenceCoverageDocumentMacro, 1); assert.equal(ordinary.consumedEvidenceCoverageDocumentMacro, 0);
  assert.equal(oracle.scheduled, 1); assert.equal(oracle.completed, 0); assert.equal(oracle.oracleIneligible, 1);
  assert.equal(oracle.contentTokensMean, null); assert.equal(oracle.consumedEvidenceCoverageDocumentMacro, null);
});

test('overlap deduplication reducing context count is not reported as a budget omission', () => {
  const config = loadConfig(), blocks = textBlocks('overlap-doc', [{ text: 'alpha beta gamma' }]);
  const doc: PreparedDocument = { id: 'overlap-doc', text: blocks[0].text, blocks, tokenCount: countTokens(blocks[0].text), chunks: ['a', 'b'].map((id, ordinal) => ({ ...blocks[0], id, ordinal, references: [], path: [] })) };
  const q = { ...question, id: 'overlap-q', documentId: doc.id, unanswerable: false, evidenceSets: [[{ blockId: blocks[0].id, start: 0, end: doc.text.length, quote: doc.text }]] };
  const retrieval = { ...run([], ['a', 'b']), id: 'overlap-run', method: 'bm25', questionId: q.id, documentId: doc.id } as QueryRun;
  const plan = planRetrievalContext(doc, retrieval.ranking);
  retrieval.generation = { text: doc.text, citations: [], abstained: false, elapsedMs: 1, contextManifest: plan.manifest };
  const attempt = { id: 'paid-overlap', runId: retrieval.id, documentId: doc.id, method: retrieval.method, operation: 'generation', status: 'completed', model: config.models.generation, reportedModel: config.models.generation, payloadHash: hashObject(generationBody(q, plan.contexts, retrieval.method, config)) } as PaidAttempt;
  const facts = generationInputFacts(retrieval, doc, q, config, [attempt])!;
  assert.equal(facts.contexts, 1); assert.equal(facts.retrievedPassages, 2); assert.equal(facts.fewerContextsThanRetrieved, true);
  assert.equal(facts.omittedPassages, 0); assert.equal(facts.omittedSourceTokens, 0);
  assert.equal(facts.retrievedSourceTokens, facts.consumedSourceTokens);
});
