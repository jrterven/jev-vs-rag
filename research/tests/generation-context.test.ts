import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTokens } from '../../server/extraction.js';
import { textBlocks } from '../datasets.js';
import { oracleContext, planRetrievalContext, retrievalContext } from '../context.js';
import { Ledger } from '../ledger.js';
import { Methods } from '../methods.js';
import { loadConfig } from '../runner.js';
import type { FrozenQuestion, PreparedDocument, QueryRun, RankedChunk, RunMethod } from '../types.js';

function document(paragraphs: string[]): PreparedDocument {
  const blocks = textBlocks('context-doc', paragraphs.map(text => ({ text })));
  const text = blocks.map(b => b.text).join('\n\n');
  return { id: 'context-doc', blocks, text, tokenCount: countTokens(text), chunks: blocks.map((b, ordinal) => ({ id: `chunk-${ordinal}`, ordinal, text: b.text, start: b.start, end: b.end, references: [{ blockId: b.id, paragraph: ordinal + 1 }], path: [] })) };
}
const ranking = (ids: string[]): RankedChunk[] => ids.map((chunkId, i) => ({ chunkId, score: 100 - i }));
function question(doc: PreparedDocument): FrozenQuestion {
  const b = doc.blocks[0];
  return { id: 'context-question', documentId: doc.id, question: 'What does the source say?', answer: b.text, evidenceSets: [[{ blockId: b.id, start: b.start, end: b.end, quote: b.text }]] };
}
function run(doc: PreparedDocument, method: RunMethod): QueryRun {
  return { id: `context:${method}`, questionId: 'context-question', documentId: doc.id, corpus: 'fixture', method, round: 0, status: 'completed', startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:00:00Z', elapsedMs: 0, ranking: ranking(doc.chunks.map(c => c.id)), phases: {}, traces: [] };
}

test('five complete 500-token chunks fit greedily after retokenizing context separators', () => {
  const chunk = 'star '.repeat(499) + 'star', doc = document(Array(5).fill(chunk));
  assert.equal(countTokens(chunk), 500);
  assert.equal(countTokens(doc.text), 2504, 'five nominal chunks exceed the budget when separators are included');
  const hits = ranking(doc.chunks.map(c => c.id));
  const plan = planRetrievalContext(doc, hits);
  assert.deepEqual(plan.manifest, { policy: 'ranked-complete-deduplicated-v1', selectedChunkIds: ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3'], omittedChunkIds: ['chunk-4'], contentTokens: 2003, budget: 2500 });
  assert.deepEqual(plan.contexts.map(c => c.text), Array(4).fill(chunk), 'accepted chunks remain complete');
  assert.deepEqual(plan.contexts.map(c => c.label), ['C1', 'C2', 'C3', 'C4']);
  assert.equal(plan.manifest.contentTokens, countTokens(plan.contexts.map(c => c.text).join('\n\n')));
  assert.deepEqual(retrievalContext(doc, hits), plan.contexts, 'legacy context API uses the same planner');
});

test('overlapping Unicode excerpts preserve exact source offsets, quotes, and contiguous labels', () => {
  const doc = document(['Árbol 📚 café e\u0301.', '第二段 🧪 con evidencia.', 'Final útil.']);
  doc.chunks = [
    { ...doc.chunks[0], end: doc.blocks[1].end, text: doc.text.slice(0, doc.blocks[1].end) },
    { ...doc.chunks[1], end: doc.blocks[2].end, text: doc.text.slice(doc.blocks[1].start) },
  ];
  const plan = planRetrievalContext(doc, ranking(doc.chunks.map(c => c.id)));
  assert.deepEqual(plan.manifest.selectedChunkIds, ['chunk-0', 'chunk-1']);
  assert.deepEqual(plan.manifest.omittedChunkIds, []);
  assert.deepEqual(plan.contexts.map(c => c.label), ['C1', 'C2']);
  assert.deepEqual(plan.contexts.map(c => c.text), [doc.blocks.slice(0, 2).map(b => b.text).join('\n\n'), doc.blocks[2].text]);
  const spans = plan.contexts.flatMap(c => c.spans);
  assert.equal(spans.length, 3);
  for (const [i, span] of spans.entries()) {
    const block = doc.blocks.find(b => b.id === span.blockId)!;
    assert.equal(span.quote, doc.text.slice(span.start, span.end));
    assert.equal(span.quote, block.text);
    assert.ok(span.start >= block.start && span.end <= block.end);
    if (i) assert.ok(spans[i - 1].end <= span.start);
  }
});

test('an omitted overlapping chunk does not consume later evidence and planning continues in rank order', () => {
  const doc = document(['anchor', 'large '.repeat(100), 'tail']);
  doc.chunks[1] = { ...doc.chunks[1], end: doc.blocks[2].end, text: doc.text.slice(doc.blocks[1].start) };
  const budget = countTokens('anchor\n\ntail');
  const plan = planRetrievalContext(doc, ranking(doc.chunks.map(c => c.id)), budget);
  assert.deepEqual(plan.manifest.selectedChunkIds, ['chunk-0', 'chunk-2']);
  assert.deepEqual(plan.manifest.omittedChunkIds, ['chunk-1']);
  assert.deepEqual(plan.contexts.map(c => [c.label, c.text]), [['C1', 'anchor'], ['C2', 'tail']]);
  assert.equal(plan.manifest.contentTokens, budget);
});

test('only the first five ranked entries are eligible even when all five are omitted', () => {
  const doc = document([...Array(5).fill('large '.repeat(20)), 'a']);
  const plan = planRetrievalContext(doc, ranking(doc.chunks.map(c => c.id)), 1);
  assert.deepEqual(plan.contexts, []);
  assert.deepEqual(plan.manifest.selectedChunkIds, []);
  assert.deepEqual(plan.manifest.omittedChunkIds, doc.chunks.slice(0, 5).map(c => c.id));
  assert.equal(plan.manifest.contentTokens, 0);
  assert.equal(plan.manifest.budget, 1);
});

test('duplicate IDs add no text and fully covered chunks are selected without additional tokens', () => {
  const doc = document(['a', 'large '.repeat(20)]);
  doc.chunks.push({ ...doc.chunks[0], id: 'covered', ordinal: 2 });
  const plan = planRetrievalContext(doc, ranking(['chunk-0', 'chunk-0', 'covered', 'chunk-1', 'chunk-1']), 1);
  assert.deepEqual(plan.manifest.selectedChunkIds, ['chunk-0', 'covered']);
  assert.deepEqual(plan.manifest.omittedChunkIds, ['chunk-1']);
  assert.deepEqual(plan.contexts.map(c => [c.label, c.text]), [['C1', 'a']]);
  assert.equal(plan.manifest.contentTokens, 1);
});

test('oracle retains complete gold or remains ineligible instead of applying retrieval omission', () => {
  const doc = document(['gold '.repeat(2600)]), q = question(doc);
  assert.throws(() => oracleContext(doc, q), /control ineligible, no truncated oracle/);
  assert.deepEqual(oracleContext(doc, { ...q, unanswerable: true, evidenceSets: [] }), []);
});

test('mock generation exposes and checkpoints all three context policies without provider calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'generation-context-mock-'));
  const ledger = new Ledger(join(directory, 'study.sqlite')), config = loadConfig(), doc = document(['A complete source.']);
  let calls = 0;
  const methods = new Methods({ config, ledger, experimentId: 'context', cacheDir: directory, mock: true, allowPaid: false, signal: new AbortController().signal, fetcher: (async () => { calls++; throw new Error('Unexpected provider call'); }) as typeof fetch });
  try {
    for (const [method, policy] of [['bm25', 'ranked-complete-deduplicated-v1'], ['oracle', 'complete-gold-or-ineligible-v1'], ['closed-book', 'closed-book-v1']] as const) {
      const result = run(doc, method), generated = await methods.generate(question(doc), doc, result);
      const manifest = generated.contextManifest;
      assert.ok(manifest);
      assert.deepEqual(Object.keys(manifest).sort(), ['budget', 'contentTokens', 'omittedChunkIds', 'policy', 'selectedChunkIds']);
      assert.equal(manifest.policy, policy);
      assert.equal(manifest.budget, 2500);
      assert.equal(manifest.contentTokens, method === 'closed-book' ? 0 : countTokens(doc.text));
      assert.deepEqual(manifest.selectedChunkIds, method === 'bm25' ? ['chunk-0'] : []);
      assert.deepEqual(manifest.omittedChunkIds, []);
      assert.deepEqual(ledger.get(`${result.id}:generation-context`), manifest);
      assert.deepEqual(generated.citations.map(c => c.label), method === 'closed-book' ? [] : ['C1']);
    }
    assert.equal(calls, 0);
    assert.equal(ledger.attempts().length, 0);
  } finally { methods.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('each generation context manifest is durable before the provider boundary and survives failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'generation-context-failure-')), path = join(directory, 'study.sqlite');
  const ledger = new Ledger(path), config = loadConfig(), doc = document(['Source evidence.']);
  const previousKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'unit-test-only';
  let activeRun: QueryRun, calls = 0;
  const methods = new Methods({ config, ledger, experimentId: 'context', cacheDir: directory, mock: false, allowPaid: true, signal: new AbortController().signal, fetcher: (async () => {
    calls++;
    const checkpoint = ledger.get(`${activeRun.id}:generation-context`);
    assert.ok(checkpoint, 'manifest must exist before provider execution');
    const reopened = new Ledger(path);
    try { assert.deepEqual(reopened.get(`${activeRun.id}:generation-context`), checkpoint); } finally { reopened.close(); }
    return Response.json({ status: 'failed', model: config.models.generation, usage: { input_tokens: 1, output_tokens: 0 } }, { status: 400 });
  }) as typeof fetch });
  try {
    for (const method of ['bm25', 'oracle', 'closed-book'] as const) {
      activeRun = run(doc, method);
      await assert.rejects(methods.generate(question(doc), doc, activeRun), /Generation did not complete/);
      assert.ok(ledger.get(`${activeRun.id}:generation-context`));
    }
    assert.equal(calls, 3);
    assert.equal(ledger.attempts().length, 3);
    assert.ok(ledger.attempts().every(a => a.status === 'failed'));
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    methods.close(); ledger.close(); rmSync(directory, { recursive: true, force: true });
  }
});
