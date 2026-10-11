import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, BudgetExceeded, paidJson } from '../ledger.js';
import { CanonicalTokens, intersectionSize } from '../metrics.js';
import { mockDataset } from '../fixtures.js';
import { prepareDocument, validateFreeze, importQasperRaw, type RawQasperDocument } from '../datasets.js';
import { retrievalContext, oracleContext } from '../context.js';
import { rrf } from '../methods.js';
import { hashObject } from '../util.js';

test('canonical token mapping preserves Unicode boundaries and overlapping chunks count once', () => {
  const text = 'Un libro 📚 contiene información. Otro párrafo.';
  const tokens = new CanonicalTokens(text), emoji = text.indexOf('📚');
  assert.throws(() => tokens.span({ start: emoji + 1, end: emoji + 2 }), /UTF-16/);
  const full = tokens.span({ start: 0, end: text.length });
  assert.equal(full.end, tokens.length);
  assert.equal(intersectionSize([full, full], [full]), tokens.length);
});

test('budget is shared, unknown reservations remain, immutable prices and exact decimal settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-ledger-'));
  const ledger = new Ledger(join(directory, 'budget.sqlite'), '1');
  try {
    const input = { logicalKey: 'key', runId: 'exp:run', documentId: 'd', method: 'jev-scan', operation: 'window', model: 'model', payloadHash: 'hash', price: { input: '0.042', output: '0', date: '2026-10-03', source: 'test' }, reservedUsd: '0.7' };
    const first = ledger.reserve(input); assert.throws(() => ledger.reserve(input), BudgetExceeded);
    ledger.finish(first.id, { status: 'completed', costUsd: '0.000000042', inputTokens: 1 });
    const second = ledger.reserve({ ...input, logicalKey: 'second' }); ledger.finish(second.id, { status: 'unknown', costUsd: null });
    assert.equal(ledger.totals().committedUsd, '0.700000042');
    assert.throws(() => ledger.finish(first.id, { status: 'completed', costUsd: '0' }), /once/);
    const reopened = new Ledger(join(directory, 'budget.sqlite'), '1');
    assert.equal(reopened.totals().unknownAttempts, 1); assert.throws(() => reopened.reserve({ ...input, reservedUsd: '0.3' }), BudgetExceeded); reopened.close();
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('provider recovery replays same logical response without charging; new run incurs new attempt; no retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-provider-')), ledger = new Ledger(join(directory, 'budget.sqlite'), '1'); let calls = 0;
  const args = { ledger, logicalKey: 'exp:one', runId: 'exp:one', documentId: 'd', method: 'openai-dense', operation: 'query_embedding', model: 'test-model', price: { input: '0.02', output: '0', date: '2026-10-03', source: 'test' }, reservedUsd: '0.1', url: 'https://test.invalid/embeddings', apiKey: 'fake-test-secret', body: { model: 'test-model', input: ['hello'] }, provider: 'openai-embedding' as const, allowPaid: true, fetcher: (async () => { calls++; return Response.json({ model: 'test-model', usage: { prompt_tokens: 2 }, data: [{ index: 0, embedding: [1, 0] }] }); }) as typeof fetch };
  try {
    await paidJson(args); await paidJson(args); assert.equal(calls, 1); assert.equal(ledger.attempts().length, 1);
    await paidJson({ ...args, logicalKey: 'exp:two', runId: 'exp:two' }); assert.equal(calls, 2); assert.equal(ledger.attempts().length, 2);
    await assert.rejects(paidJson({ ...args, body: { changed: true } }), /payload mismatch/);
    await assert.rejects(paidJson({ ...args, logicalKey: 'blocked', allowPaid: false }), /disabled/);
    await assert.rejects(paidJson({ ...args, logicalKey: 'timeout', fetcher: (async () => { calls++; throw new Error('timeout fake-test-secret'); }) as typeof fetch }));
    assert.equal(calls, 3); assert.equal(ledger.attempts().at(-1)!.status, 'unknown'); assert.ok(!JSON.stringify(ledger.attempts()).includes('fake-test-secret'));
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('over-reservation actual usage is recorded and halts future calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-overage-')), ledger = new Ledger(join(directory, 'budget.sqlite'), '1');
  try { const attempt = ledger.reserve({ logicalKey: 'k', runId: 'r', documentId: 'd', method: 'm', operation: 'o', model: 'model', payloadHash: 'h', price: { input: '1', output: '0', source: 'test', date: 'date' }, reservedUsd: '0.01' }); ledger.finish(attempt.id, { status: 'completed', costUsd: '0.02' }); assert.equal(ledger.totals().knownUsd, '0.02'); assert.throws(() => ledger.reserve({ ...attempt, logicalKey: 'next' }), BudgetExceeded); }
  finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('contexts deduplicate source overlap and retain accurate per-block citations; oracle never truncates', async () => {
  const bundle = mockDataset(), doc = await prepareDocument(bundle.freeze.documents[0]);
  const contexts = retrievalContext(doc, doc.chunks.slice(0, 5).map(c => ({ chunkId: c.id, score: 1 })));
  const spans = contexts.flatMap(c => c.spans).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].end);
  for (const span of spans) assert.equal(doc.text.slice(span.start, span.end), span.quote);
  assert.throws(() => oracleContext(doc, bundle.freeze.questions[0], 1), /no truncated oracle/);
  assert.deepEqual(oracleContext(doc, bundle.freeze.questions.at(-1)!), []);
});

test('QASPER rejects conflicting, single-reviewer, visual and ambiguous evidence; headings are common source text', () => {
  const ann = (worker: string, unanswerable: boolean, evidence: string[]) => ({ worker_id: worker, annotation_id: worker, answer: { unanswerable, evidence, extractive_spans: [], free_form_answer: '', yes_no: null } });
  const doc: RawQasperDocument = { title: 'Paper title', abstract: 'An abstract.', full_text: [{ section_name: 'Final section', paragraphs: ['Known evidence.', 'Repeated.', 'Repeated.'] }], qas: [
    { question_id: 'good', question: 'What is known?', answers: [ann('a', false, ['Known evidence.']), ann('b', false, ['Known evidence.'])] },
    { question_id: 'negative', question: 'Missing fact?', answers: [ann('a', true, []), ann('b', true, [])] },
    { question_id: 'conflict', question: 'Conflict?', answers: [ann('a', true, []), ann('b', false, ['Known evidence.'])] },
    { question_id: 'single', question: 'Single?', answers: [ann('a', true, [])] },
    { question_id: 'figure', question: 'Figure?', answers: [ann('a', false, ['FLOAT SELECTED: figure']), ann('b', false, ['FLOAT SELECTED: figure'])] },
    { question_id: 'ambiguous', question: 'Repeated?', answers: [ann('a', false, ['Repeated.']), ann('b', false, ['Repeated.'])] },
  ] };
  const bundle = importQasperRaw({ paper: doc }, { split: 'test', positiveCount: 1, negativeCount: 1, rawSha256: 'test' });
  validateFreeze(bundle.freeze); assert.deepEqual(bundle.freeze.questions.map(q => q.id), ['good', 'negative']);
  assert.equal(bundle.freeze.questions[0].questionType, undefined);
  assert.ok(bundle.freeze.documents[0].blocks.some(b => b.text === 'Final section'));
  assert.equal(bundle.freeze.documents[0].blocks[0].text, 'Paper title');
  assert.throws(() => importQasperRaw({ paper: doc }, { split: 'test', positiveCount: 2, negativeCount: 1, rawSha256: 'test' }), /not relaxed/);
});

test('RRF uses ranks, stable ties and rejects duplicates; synthetic fixture deterministic', () => {
  const rankings = [[{ chunkId: 'a', score: 1 }, { chunkId: 'b', score: 0 }], [{ chunkId: 'b', score: 99 }, { chunkId: 'a', score: 2 }]];
  assert.deepEqual(rrf(rankings).map(x => x.chunkId), ['a', 'b']);
  assert.throws(() => rrf([[rankings[0][0], rankings[0][0]]]), /Duplicate/);
  assert.equal(hashObject(mockDataset()), hashObject(mockDataset()));
});
