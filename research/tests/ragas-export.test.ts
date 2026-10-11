import test from 'node:test';
import assert from 'node:assert/strict';
import { metricApplicability, generationBody } from '../ragas/export.js';
import type { FrozenQuestion, ResearchConfig } from '../types.js';
import { loadConfig } from '../runner.js';

const q = { id: 'q', documentId: 'd', question: 'Where?', answer: 'Mexico', unanswerable: false, evidenceSets: [] } as FrozenQuestion;
const g = { text: 'Mexico', abstained: false, citations: [], elapsedMs: 1 };
const contexts = [{ label: 'C1', text: 'Mexico', spans: [] }];
test('RAGAS applicability separates evidence support, reference correctness and abstention', () => {
  assert.deepEqual(metricApplicability(q, g, contexts).metrics, ['faithfulness', 'factual_correctness']);
  assert.deepEqual(metricApplicability(q, { ...g, abstained: true }, contexts).metrics, ['factual_correctness']);
  assert.deepEqual(metricApplicability({ ...q, unanswerable: true }, g, contexts).metrics, ['faithfulness']);
  assert.deepEqual(metricApplicability(q, g, []).metrics, ['factual_correctness']);
  assert.deepEqual(metricApplicability({ ...q, unanswerable: true }, { ...g, abstained: true }, []).metrics, []);
});
test('historical generation reconstruction preserves exact labeled evidence and generator settings', () => {
  const config = loadConfig() as ResearchConfig;
  const body = generationBody(q, contexts, 'jev-scan', config);
  assert.deepEqual(JSON.parse(body.input), { question: 'Where?', excerpts: [{ label: 'C1', text: 'Mexico' }] });
  assert.equal(body.temperature, 0); assert.equal(body.max_output_tokens, 512);
  assert.match(generationBody(q, [], 'closed-book', config).instructions, /own knowledge/);
  assert.match(body.instructions, /only the supplied excerpts/);
});
