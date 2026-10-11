import type { AnswerRating, FrozenDataset } from '../annotation/shared/types.js';
import { validateFreeze } from './datasets.js';

type Sources = ReadonlyArray<{ documentId: string; corpus: string }> | Record<string, string>;
type Counts = Record<string, number>;
const categories = {
  correctness: ['0', '1', '2', 'null'], unsupported: ['yes', 'no', 'uncertain'],
  citations: ['supported', 'partial', 'unsupported', 'not_applicable'],
  abstention: ['justified', 'unjustified', 'not_applicable'],
} as const;
type Criterion = keyof typeof categories;
const criteria = Object.keys(categories) as Criterion[];
const emptyCounts = () => Object.fromEntries(criteria.map(key => [key, Object.fromEntries(categories[key].map(value => [value, 0]))])) as Record<Criterion, Counts>;
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}.`);
  return value;
}
function rating(value: unknown): AnswerRating {
  const item = object(value, 'rating');
  if (![0, 1, 2, null].includes(item.correctness as number | null)) throw new Error('Invalid correctness.');
  for (const key of ['unsupported', 'citations', 'abstention'] as const) if (!(categories[key] as readonly unknown[]).includes(item[key])) throw new Error(`Invalid ${key}.`);
  if (typeof item.issue !== 'string' || typeof item.comment !== 'string') throw new Error('Invalid rating issue/comment.');
  return item as unknown as AnswerRating;
}
interface Group {
  corpus: string; method: string; nAnswers: number; nQuestions: number; nDocuments: number;
  expectedRatings: number; receivedRatings: number; missingRatings: number;
  answersMissingRatings: number; answersWithIncidents: number; answersWithNullCorrectness: number;
  incidentRatings: number; nullRatings: number; eligibleAnswers: number;
  rawRatingCounts: Record<Criterion, Counts>; answerWeightedCounts: Record<Criterion, Counts>;
  disagreementCounts: Record<Criterion | 'any', number>;
}
/** Descriptive only: each complete, incident-free answer contributes one unit, split between its two raters. */
export function analyzeHumanRatings(input: unknown, freeze: FrozenDataset, sources?: Sources) {
  validateFreeze(freeze);
  const exported = object(input, 'ratings export');
  if (exported.schemaVersion !== 1 || exported.freezeId !== freeze.id) throw new Error('Ratings freezeId/schema mismatch.');
  if (exported.datasetHash !== undefined && exported.datasetHash !== freeze.hash) throw new Error('Ratings dataset hash mismatch.');
  if (!Array.isArray(exported.answers)) throw new Error('Invalid exported answers.');
  const corpusByDocument = new Map<string, string>();
  const entries = Array.isArray(sources) ? sources.map(source => [source.documentId, source.corpus] as const) : Object.entries(sources ?? {});
  for (const [documentId, corpus] of entries) {
    string(documentId, 'source documentId'); string(corpus, 'corpus');
    if (corpusByDocument.has(documentId) && corpusByDocument.get(documentId) !== corpus) throw new Error('Conflicting corpus mapping.');
    corpusByDocument.set(documentId, corpus);
  }
  const questions = new Map(freeze.questions.map(question => [question.id, question]));
  const seenAnswers = new Set<string>(), seenTasks = new Set<string>(), missingCorpus = new Set<string>();
  const groups = new Map<string, { value: Group; questions: Set<string>; documents: Set<string> }>();
  let ignoredAdjudicatedRatings = 0;
  for (const rawAnswer of exported.answers) {
    const answer = object(rawAnswer, 'answer');
    const questionId = string(answer.questionId, 'questionId'), method = string(answer.method, 'method'), runId = string(answer.runId, 'runId');
    const question = questions.get(questionId); if (!question) throw new Error(`Unknown questionId: ${questionId}`);
    const answerKey = JSON.stringify([questionId, method, runId]);
    if (seenAnswers.has(answerKey)) throw new Error('Duplicate answer.'); seenAnswers.add(answerKey);
    if (!Array.isArray(answer.raw) || answer.raw.length > 2) throw new Error('Each answer must have at most two raw ratings.');
    const participants = new Set<string>();
    const ratings = answer.raw.map(raw => {
      const row = object(raw, 'raw rating'), participant = string(row.participant, 'participant'), taskId = string(row.taskId, 'taskId');
      if (participants.has(participant)) throw new Error('Two distinct independent raters are required.');
      if (seenTasks.has(taskId)) throw new Error('Duplicate rating task.');
      participants.add(participant); seenTasks.add(taskId); return rating(row.rating);
    });
    if (Array.isArray(answer.adjudicated)) ignoredAdjudicatedRatings += answer.adjudicated.length;
    const corpus = corpusByDocument.get(question.documentId) ?? 'unspecified';
    if (!corpusByDocument.has(question.documentId)) missingCorpus.add(question.documentId);
    const key = JSON.stringify([corpus, method]);
    let group = groups.get(key);
    if (!group) {
      group = { questions: new Set(), documents: new Set(), value: { corpus, method, nAnswers: 0, nQuestions: 0, nDocuments: 0,
        expectedRatings: 0, receivedRatings: 0, missingRatings: 0, answersMissingRatings: 0, answersWithIncidents: 0,
        answersWithNullCorrectness: 0, incidentRatings: 0, nullRatings: 0, eligibleAnswers: 0,
        rawRatingCounts: emptyCounts(), answerWeightedCounts: emptyCounts(), disagreementCounts: { correctness: 0, unsupported: 0, citations: 0, abstention: 0, any: 0 } } };
      groups.set(key, group);
    }
    const summary = group.value;
    group.questions.add(questionId); group.documents.add(question.documentId);
    summary.nAnswers++; summary.expectedRatings += 2; summary.receivedRatings += ratings.length; summary.missingRatings += 2 - ratings.length;
    if (ratings.length < 2) summary.answersMissingRatings++;
    const incidents = ratings.filter(item => item.issue.trim()).length, nulls = ratings.filter(item => item.correctness === null).length;
    summary.incidentRatings += incidents; summary.nullRatings += nulls;
    if (incidents) summary.answersWithIncidents++;
    if (nulls) summary.answersWithNullCorrectness++;
    for (const item of ratings) for (const criterion of criteria) summary.rawRatingCounts[criterion][String(item[criterion])]++;
    if (ratings.length !== 2 || incidents || nulls) continue;
    summary.eligibleAnswers++;
    for (const item of ratings) for (const criterion of criteria) summary.answerWeightedCounts[criterion][String(item[criterion])] += 0.5;
    let differs = false;
    for (const criterion of criteria) if (ratings[0][criterion] !== ratings[1][criterion]) { summary.disagreementCounts[criterion]++; differs = true; }
    if (differs) summary.disagreementCounts.any++;
  }
  return {
    schemaVersion: 1 as const, kind: 'descriptive-human' as const, freezeId: freeze.id, datasetHash: freeze.hash,
    exportContainsDatasetHash: exported.datasetHash !== undefined, unit: 'answer (questionId, method, runId)',
    interpretation: 'Raw rating counts are descriptive votes, not independent questions. Quality distributions and disagreement use only two distinct numeric, incident-free raw ratings per answer. Each such answer has weight one. Missing/null/incident answers are not scored as incorrect. Adjudications never replace raw ratings. No confidence intervals or automatic quality winner.',
    missingCorpusDocumentIds: [...missingCorpus].sort(), ignoredAdjudicatedRatings,
    methods: [...groups.values()].map(({ value, questions, documents }) => ({ ...value, nQuestions: questions.size, nDocuments: documents.size,
      repeatedQuestionAnswers: value.nAnswers - questions.size,
      disagreementRates: Object.fromEntries(Object.entries(value.disagreementCounts).map(([key, count]) => [key, value.eligibleAnswers ? count / value.eligibleAnswers : null])),
    })).sort((a, b) => a.corpus.localeCompare(b.corpus) || a.method.localeCompare(b.method)),
  };
}
