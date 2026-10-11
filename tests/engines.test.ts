import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Attempt, Block, Chunk, Progress } from '../shared/types.js';
import type { RuntimeConfig, WorkContext } from '../server/contracts.js';
import { EngineError, ProviderClient, textPieces, tokenCount } from '../server/engines/common.js';
import { assembleStructure, JevEngine, packSearchWindows, packSearchWindowsAsync } from '../server/engines/jev.js';
import { embeddingBatches, RagEngine } from '../server/engines/rag.js';

const config: RuntimeConfig = {
  dataDir: '/tmp/jev-engine-tests-unused', port: 3001, typesafeApiKey: 'test-jev', openaiApiKey: 'test-openai',
  jevModel: 'jev-1.13.0', embeddingModel: 'text-embedding-3-small', jevBaseUrl: 'https://api.typesafe.ai/v1', openaiBaseUrl: 'https://api.openai.com/v1',
  maxFileMb: 100, maxTokens: 1_000_000, maxPdfPages: 2000, chunkTokens: 500, overlapTokens: 75,
  jevWindowTokens: 12_000, concurrency: 2, requestTimeoutMs: 3000, jevRate: '0.042', embeddingRate: '0.02', rateDate: '2026-10-02',
};
function context(settings = config) {
  const attempts: Attempt[] = []; const checkpoints = new Map<string, unknown>(); const progress: Progress[] = [];
  const abort = new AbortController();
  const ctx: WorkContext = {
    documentId: 'test-document', jobId: 'test-job', runId: 'test-run', config: settings, signal: abort.signal,
    attempts: { start(attempt) { attempts.push(attempt); }, finish(id, patch) { Object.assign(attempts.find(a => a.id === id)!, patch); } },
    progress(value) { progress.push({ ...value }); }, checkpoint(key, value) { checkpoints.set(key, value); },
    getCheckpoint<T>(key: string): T | undefined { return checkpoints.get(key) as T | undefined; },
  };
  return { ctx, attempts, checkpoints, progress, abort };
}
function chunks(count: number, text = 'sample text'): Chunk[] {
  return Array.from({ length: count }, (_, ordinal) => ({ id: `c${ordinal}`, ordinal, text: `${ordinal}: ${text}`, start: ordinal * 100, end: ordinal * 100 + 100, references: [{ blockId: `b${ordinal}`, paragraph: ordinal + 1 }], path: [] }));
}
type Payload = { model: string; state?: { id: string; text: string }[]; questions?: Record<string, { type: string; criteria: Record<string, unknown> }>; input?: string[] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function jevResult(body: Payload) {
  const ids = Object.keys(body.questions!.where.criteria);
  const ranked = [...ids].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const denominator = ids.length * (ids.length + 1) / 2;
  return { model: config.jevModel, answers: { where: { type: 'choice', choice: ranked[0], probabilities: Object.fromEntries(ranked.map((id, index) => [id, (ids.length - index) / denominator])) }, exists: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 100, output_tokens: 10 } };
}
function fake(handler: (body: Payload, init: RequestInit, url: string) => Promise<Response> | Response): typeof fetch {
  return async (input, init) => handler(JSON.parse(String(init?.body)) as Payload, init!, String(input));
}

test('Jev covers every initial chunk, then reranks finalists using one shared probability distribution', async () => {
  const state = context(); const all = chunks(300); const calls: Payload[] = [];
  let active = 0; let peak = 0;
  const engine = new JevEngine(config, fake(async body => { assert.ok(tokenCount(JSON.stringify(body)) <= config.jevWindowTokens); calls.push(body); peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 3)); active--; return response(jevResult(body)); }));
  const result = await engine.search('find the final passage', all, state.ctx);
  assert.equal(result.metrics.chunksCovered, 300); assert.equal(result.metrics.windowsTotal, 2);
  assert.equal(result.metrics.windowsCompleted, 2); assert.equal(result.metrics.reductionLevels, 1);
  assert.equal(result.existenceScope, 'finalists'); assert.equal(result.hits.length, 5);
  assert.equal(result.hits[0].chunkId, 'c299'); assert.ok(peak <= 2);
  assert.equal(new Set(calls.slice(0, 2).flatMap(call => call.state!.map(c => c.id))).size, 300);
  assert.equal(result.metrics.calls, 3); assert.equal(result.metrics.inputTokens, 300);
  assert.equal(state.attempts.length, 3); assert.ok(state.attempts.every(a => a.costUsd === '0.0000042'));
  assert.ok(state.attempts.every(a => a.status === 'completed'));
});

test('Jev small groups converge across multiple reduction levels and preserve first-phase coverage', async () => {
  const small = { ...config, jevWindowTokens: 1450 };
  const all = chunks(80, 'word '.repeat(230)); const state = context(small);
  const engine = new JevEngine(small, fake(body => response(jevResult(body))));
  const result = await engine.search('sample', all, state.ctx);
  assert.equal(result.metrics.chunksCovered, 80); assert.ok(result.metrics.reductionLevels >= 3);
  assert.equal(result.existenceScope, 'finalists'); assert.equal(result.hits[0].chunkId, 'c79');
  assert.equal(new Set(result.hits.map(hit => hit.chunkId)).size, result.hits.length);
});

test('A single-chunk Jev result keeps ranking probability separate from answer existence', async () => {
  const state = context(); const source = chunks(1, 'The observatory opened in 1987.');
  const engine = new JevEngine(config, fake(body => {
    assert.equal(body.state!.length, 1);
    return response({ ...jevResult(body), answers: { where: { type: 'choice', choice: 'c0', probabilities: { c0: 1 } }, exists: { type: 'noul', noul: 0.001 } } });
  }));
  const result = await engine.search('Who invented this telescope?', source, state.ctx);
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].score, 1);
  assert.equal(result.existence, 0.001); assert.equal(result.existenceScope, 'document');
  assert.equal(result.metrics.calls, 1); assert.equal(result.metrics.reductionLevels, 0);
  assert.equal(result.hits[0].text, source[0].text); assert.deepEqual(result.hits[0].references, source[0].references);
});

test('A multi-chunk single-window result follows the returned distribution rather than document order', async () => {
  const state = context(); const source = chunks(8);
  const engine = new JevEngine(config, fake(body => response(jevResult(body))));
  const result = await engine.search('Find the final fragment', source, state.ctx);
  assert.deepEqual(result.hits.map(hit => hit.chunkId), ['c7', 'c6', 'c5', 'c4', 'c3']);
  assert.equal(result.existenceScope, 'document'); assert.equal(result.metrics.chunksCovered, 8);
  assert.equal(result.metrics.calls, 1); assert.equal(result.metrics.reductionLevels, 0);
});

test('Structure parsing accepts only declared classification labels', async () => {
  const state = context();
  const block: Block = { id: 'b0', ordinal: 0, text: 'Body', start: 0, end: 4, paragraph: 1 };
  const engine = new JevEngine(config, fake(body => response({ answers: Object.fromEntries(body.state!.map(piece => [piece.id, { type: 'choice', choice: 'constructor' }])), usage: { input_tokens: 100 } })));
  await assert.rejects(engine.prepare([block], chunks(1), state.ctx), /clasificación de bloque incompleta/);
  assert.equal(state.checkpoints.size, 0); assert.equal(state.attempts[0].inputTokens, 100);
});

test('Jev splits only explicit context errors and counts every attempted call', async () => {
  const state = context();
  const engine = new JevEngine(config, fake(body => body.state!.length > 8 ? response({ error: { code: 'context_length_exceeded' } }, 422) : response(jevResult(body))));
  const result = await engine.search('sample', chunks(24), state.ctx);
  assert.equal(result.metrics.chunksCovered, 24); assert.equal(result.metrics.windowsTotal, 4);
  assert.equal(result.metrics.windowsCompleted, 4); assert.equal(result.hits[0].chunkId, 'c23');
  assert.equal(result.metrics.calls, state.attempts.length);
  assert.ok(state.attempts.some(a => a.costUsd === null && a.status === 'unknown'));
  const invalidState = context();
  const invalid = new JevEngine(config, fake(() => response({ detail: 'Invalid question criteria.' }, 422)));
  await assert.rejects(invalid.search('sample', chunks(24), invalidState.ctx), (error: unknown) => error instanceof EngineError && error.metrics.chunksCovered === 0 && error.metrics.calls === 1);
  assert.equal(invalidState.attempts.length, 1);
});

test('Jev tracks partial coverage on failed windows and never retries transient errors in a measured search', async () => {
  const state = context();
  const engine = new JevEngine(config, fake(body => body.state![0].id === 'c255' ? response({ error: 'busy' }, 529) : response(jevResult(body))));
  await assert.rejects(engine.search('sample', chunks(300), state.ctx), (error: unknown) => error instanceof EngineError && error.metrics.chunksCovered === 255 && error.metrics.windowsCompleted === 1);
  assert.equal(state.attempts.length, 2);
});

test('Jev classification checkpoints skip paid batches and paths include sections crossed by a fragment', async () => {
  const blocks: Block[] = [
    { id: 'b0', ordinal: 0, text: 'Chapter', start: 0, end: 7, paragraph: 1 },
    { id: 'b1', ordinal: 1, text: 'Deep section', start: 8, end: 20, paragraph: 2 },
    { id: 'b2', ordinal: 2, text: 'Body', start: 21, end: 25, paragraph: 3 },
    { id: 'b3', ordinal: 3, text: 'Next chapter', start: 26, end: 38, paragraph: 4 },
  ];
  const sourceChunks: Chunk[] = [{ ...chunks(1)[0], references: [{ blockId: 'b2', paragraph: 3 }, { blockId: 'b3', paragraph: 4 }] }];
  const state = context(); let calls = 0;
  const engine = new JevEngine(config, fake(body => {
    calls++;
    return response({ answers: Object.fromEntries(body.state!.map(p => [p.id, { choice: p.id.startsWith('b1') ? 'heading3' : p.id.startsWith('b2') ? 'paragraph' : 'heading1' }])), usage: { input_tokens: 200 } });
  }));
  const first = await engine.prepare(blocks, sourceChunks, state.ctx);
  const second = await engine.prepare(blocks, sourceChunks, state.ctx);
  assert.equal(calls, 1); assert.deepEqual(second, first);
  assert.deepEqual(first.blocks[2].path, ['Chapter', 'Deep section']);
  assert.deepEqual(first.chunks[0].path, ['Chapter / Deep section', 'Next chapter']);
  assert.equal(first.blocks[1].text, blocks[1].text);
  const untitled = assembleStructure([blocks[2]], sourceChunks, new Map());
  assert.deepEqual(untitled.blocks[0].path, []);
});

test('Provider ledger preserves unknown costs and sanitizes transport failures', async () => {
  const state = context();
  const client = new ProviderClient('jev', config, async () => { throw new Error('secret test-jev'); });
  await assert.rejects(client.request({ state: '' }, 'window', state.ctx, false), /No se recibió/);
  assert.equal(state.attempts[0].costUsd, null); assert.equal(state.attempts[0].status, 'unknown');
  assert.ok(!JSON.stringify(state.attempts).includes('test-jev'));
  const unknown = context({ ...config, jevRate: null });
  const withoutPrice = new ProviderClient('jev', { ...config, jevRate: null }, fake(() => response({ usage: { input_tokens: 42 } })));
  await withoutPrice.request({}, 'window', unknown.ctx, false);
  assert.equal(unknown.attempts[0].inputTokens, 42); assert.equal(unknown.attempts[0].costUsd, null);
  const changedModel = context();
  await new ProviderClient('jev', config, fake(() => response({ model: 'another-model', usage: { input_tokens: 100 } }))).request({}, 'window', changedModel.ctx, false);
  assert.equal(changedModel.attempts[0].model, 'another-model');
  assert.equal(changedModel.attempts[0].rateUsdPerMillion, null); assert.equal(changedModel.attempts[0].costUsd, null);
});

test('Cancellation stops queued calls while preserving every in-flight attempt', async () => {
  const settings = { ...config, concurrency: 1 }; const state = context(settings); let calls = 0;
  const client = new ProviderClient('jev', settings, async (_input, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const first = client.request({}, 'structure', state.ctx, true);
  const queued = client.request({}, 'structure', state.ctx, true);
  state.abort.abort(new Error('cancelled'));
  const outcomes = await Promise.allSettled([first, queued]);
  assert.equal(calls, 1); assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, 'unknown'); assert.equal(state.attempts[0].costUsd, null);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
});

test('Preparation retries transient HTTP failures with one ledger entry for each actual request', async () => {
  const state = context(); let count = 0;
  const client = new ProviderClient('jev', config, fake(() => ++count === 1 ? response({ error: 'busy' }, 429) : response({ usage: { input_tokens: 100 } })));
  await client.request({}, 'structure', state.ctx, true);
  assert.equal(count, 2); assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0].costUsd, null); assert.equal(state.attempts[1].costUsd, '0.0000042');
});

test('LanceDB stores all batches, resumes without new embeddings, searches exactly and embeds every new query', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jev-rag-test-'));
  try {
    const settings = { ...config, dataDir: folder }; const state = context(settings); const all = chunks(130);
    let embeddingCalls = 0; const batchSizes: number[] = [];
    const fetcher = fake(body => {
      embeddingCalls++; batchSizes.push(body.input!.length);
      return response({ model: config.embeddingModel, data: body.input!.map((text, index) => ({ index, embedding: text.startsWith('129:') || text === 'find final' ? [1, 0] : [0, 1] })), usage: { prompt_tokens: body.input!.length * 3 } });
    });
    const engine = new RagEngine(settings, fetcher);
    await engine.prepare([], all, state.ctx);
    assert.equal(embeddingCalls, 3); assert.deepEqual(batchSizes.sort((a, b) => a - b), [2, 64, 64]);
    const restart = new RagEngine(settings, fetcher);
    await restart.prepare([], all, context(settings).ctx);
    assert.equal(embeddingCalls, 3);
    const result = await restart.search('find final', all, state.ctx);
    assert.equal(result.hits[0].chunkId, 'c129'); assert.equal(result.hits[0].score, 1);
    assert.equal(result.metrics.chunksCovered, 130); assert.ok(result.metrics.embeddingMs! >= 0); assert.ok(result.metrics.searchMs! >= 0);
    await restart.search('find final', all, state.ctx); assert.equal(embeddingCalls, 5);
    await restart.delete(state.ctx.documentId);
    await assert.rejects(restart.search('find final', all, state.ctx), /Falta preparar/);
    assert.equal(embeddingCalls, 5);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Packing enforces option and embedding limits without dropping fragments', () => {
  const all = chunks(1000);
  const windows = packSearchWindows(all, 'query', config.jevModel, config.jevWindowTokens);
  assert.equal(windows.flat().length, all.length); assert.ok(windows.every(window => window.length <= 255));
  assert.throws(() => packSearchWindows(chunks(1, 'word '.repeat(500)), 'query', config.jevModel, 100), /presupuesto/);
  assert.throws(() => embeddingBatches(chunks(1, 'word '.repeat(8200))), /límite/);
  assert.equal(tokenCount('hello'), 1);
});

test('A million-token book packs without blocking event-loop progress', async t => {
  const all = chunks(2000, 'book '.repeat(500));
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 5);
  const start = performance.now();
  try {
    const windows = await packSearchWindowsAsync(all, 'Find the final chapter', config.jevModel, config.jevWindowTokens);
    const elapsed = performance.now() - start;
    assert.equal(windows.flat().length, 2000); assert.equal(new Set(windows.flat().map(c => c.id)).size, 2000);
    assert.ok(windows.every(window => window.length <= 255)); assert.ok(heartbeats > 5);
    assert.ok(elapsed < 20_000, `Packing took ${elapsed.toFixed(0)} ms`);
    t.diagnostic(`Packed >1,000,000 estimated text tokens in ${elapsed.toFixed(0)} ms; ${heartbeats} event-loop heartbeats.`);
  } finally { clearInterval(timer); }
});

test('Long source blocks split losslessly on Unicode boundaries with bounded token slices', () => {
  const text = '你好😀 hello\n'.repeat(3000);
  const pieces = textPieces(text, 512);
  assert.equal(pieces.join(''), text); assert.ok(pieces.length > 1);
  assert.ok(pieces.every(piece => tokenCount(piece) <= 512));
  assert.ok(pieces.every(piece => !piece.includes('\uFFFD')));
});
