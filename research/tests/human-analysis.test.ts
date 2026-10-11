import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnswerRating, FrozenDataset } from '../../annotation/shared/types.js';
import { freezeHash } from '../datasets.js';
import { sha256 } from '../util.js';
import { analyzeHumanRatings } from '../human-analysis.js';

function fixture() {
  const text = 'The source evidence.';
  const freeze: FrozenDataset = { schemaVersion: 1, id: 'freeze', projectId: 'project', version: 1, createdAt: '2026-10-03T00:00:00Z', hash: '',
    documents: [{ id: 'doc', projectId: 'project', title: 'Source', hash: sha256(text), version: 1, blockCount: 1, sections: [], blocks: [{ id: 'block', index: 0, start: 0, end: text.length, text }] }],
    questions: ['q1', 'q2', 'q3'].map(id => ({ id, documentId: 'doc', question: 'What is the evidence?', answer: text, evidenceSets: [[{ blockId: 'block', start: 0, end: text.length, quote: text }]] })) };
  freeze.hash = freezeHash(freeze); return freeze;
}
const base: AnswerRating = { correctness: 2, unsupported: 'no', citations: 'supported', abstention: 'not_applicable', comment: '', issue: '' };
const row = (id: string, patch: Partial<AnswerRating> = {}) => ({ taskId: `task-${id}`, participant: `person-${id}`, rating: { ...base, ...patch } });
const answer = (questionId: string, raw: ReturnType<typeof row>[], extra = {}) => ({ questionId, method: 'jev-scan', runId: `run-${questionId}`, raw, adjudicated: [], ...extra });

test('two votes contribute one answer; disagreement and explicit rubric categories use complete pairs', () => {
  const out = analyzeHumanRatings({ schemaVersion: 1, freezeId: 'freeze', answers: [answer('q1', [row('a'), row('b', { correctness: 1, unsupported: 'uncertain', citations: 'not_applicable' })], { adjudicated: [{ rating: { ...base, correctness: 0 }, participant: 'secret-adjudicator' }] })] }, fixture(), [{ documentId: 'doc', corpus: 'books' }]);
  const group = out.methods[0];
  assert.equal(group.nAnswers, 1); assert.equal(group.nQuestions, 1); assert.equal(group.receivedRatings, 2); assert.equal(group.eligibleAnswers, 1);
  assert.deepEqual(group.answerWeightedCounts.correctness, { '0': 0, '1': 0.5, '2': 0.5, null: 0 });
  assert.equal(group.answerWeightedCounts.unsupported.uncertain, 0.5); assert.equal(group.answerWeightedCounts.citations.not_applicable, 0.5);
  assert.equal(group.disagreementRates.correctness, 1); assert.equal(out.ignoredAdjudicatedRatings, 1);
  assert.equal(out.datasetHash, fixture().hash); assert.equal(out.exportContainsDatasetHash, false);
  assert.ok(!JSON.stringify(out).includes('person-')); assert.ok(!JSON.stringify(out).includes('secret-adjudicator'));
});

test('incomplete, null and incident ratings remain missing or excluded, never incorrect', () => {
  const out = analyzeHumanRatings({ schemaVersion: 1, freezeId: 'freeze', answers: [answer('q1', [row('a')]), answer('q2', [row('b', { correctness: null, issue: 'Ambiguous source' }), row('c')]), answer('q3', [])] }, fixture());
  const group = out.methods[0];
  assert.equal(group.nAnswers, 3); assert.equal(group.missingRatings, 3); assert.equal(group.answersMissingRatings, 2);
  assert.equal(group.nullRatings, 1); assert.equal(group.incidentRatings, 1); assert.equal(group.eligibleAnswers, 0);
  assert.equal(group.rawRatingCounts.correctness['0'], 0); assert.equal(group.answerWeightedCounts.correctness['0'], 0); assert.equal(group.disagreementRates.any, null);
  assert.deepEqual(out.missingCorpusDocumentIds, ['doc']); assert.equal(group.corpus, 'unspecified');
});

test('hashes, freeze IDs, question IDs, duplicate answers and rater independence are validated', () => {
  const freeze = fixture(); const exported = { schemaVersion: 1, freezeId: 'freeze', answers: [answer('q1', [row('a'), row('b')])] };
  assert.throws(() => analyzeHumanRatings(exported, { ...freeze, hash: 'bad' }), /hash/);
  assert.throws(() => analyzeHumanRatings({ ...exported, freezeId: 'other' }, freeze), /freezeId/);
  assert.throws(() => analyzeHumanRatings({ ...exported, datasetHash: 'bad' }, freeze), /hash/);
  assert.throws(() => analyzeHumanRatings({ ...exported, answers: [answer('missing', [])] }, freeze), /Unknown questionId/);
  assert.throws(() => analyzeHumanRatings({ ...exported, answers: [...exported.answers, ...exported.answers] }, freeze), /Duplicate answer/);
  assert.throws(() => analyzeHumanRatings({ ...exported, answers: [answer('q1', [row('a'), { ...row('b'), participant: 'person-a' }])] }, freeze), /distinct independent/);
});
