import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger.js';
import { readJson, hashObject } from '../util.js';
import type { ExperimentManifest } from '../runner.js';
import type { Chunk } from '../../shared/types.js';
import { tokenCount } from '../../server/engines/common.js';
import { translateAnswer, searchDecisions, EXTENSION, DECISIONS_MODEL } from './adapter.js';
import { extensionSchedule } from './run.js';
import { generate, type ExtensionRun } from './generation.js';
import { Methods } from '../methods.js';
const manifestPath = process.env.DECISIONS_BASE_MANIFEST ?? 'output/gb10-main-study-20261004-v1/manifest.json';
const config = readJson<ExperimentManifest>(manifestPath).config;
const chunk = (n: number): Chunk => ({ id: 'c' + n, ordinal: n, text: `Topic ${n}. ` + 'document '.repeat(200), start: n * 2000, end: n * 2000 + 1000, path: [], references: [] });
function fixture() { const path = mkdtempSync(join(tmpdir(), 'decisions-test-')); const ledger = new Ledger(join(path, 'ledger.sqlite')); return { ledger, close: () => { ledger.close(); rmSync(path, { recursive: true, force: true }); } }; }
function data(ids: string[]) { return { model: DECISIONS_MODEL, answers: [{ name: 'where', type: 'choice', choice: ids.at(-1), probabilities: ids.map((value, i) => ({ value, probability: i === ids.length - 1 ? 1 : 0 })) }, { name: 'exists', type: 'predicate', probability: 0.7 }], usage: { input_tokens: 100, output_tokens: 0, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 } } }; }
test('Decisions parsing rejects incomplete, duplicated, refused and wrong-model answers', () => {
  assert.equal(translateAnswer(data(['a', 'b']), ['a', 'b']).answers.exists.noul, 0.7);
  for (const value of [data(['a', 'a']), data(['a']), { ...data(['a', 'b']), model: 'another' }, { ...data(['a', 'b']), answers: [{ type: 'refusal' }] }]) assert.throws(() => translateAnswer(value, ['a', 'b']));
});
test('same traversal covers full source and reduces through multiple levels without cross-window scores', async () => {
  const f = fixture(); process.env.OPENAI_API_KEY = 'test-local'; let calls = 0;
  try {
    const chunks = Array.from({ length: 300 }, (_, i) => chunk(i));
    const response = await searchDecisions({ config, ledger: f.ledger, runId: `${EXTENSION}:test:scan`, documentId: 'doc', method: 'decisions-scan', chunks, query: 'Topic 299?', signal: new AbortController().signal, allowPaid: true,
      fetcher: async (url, init) => { assert.equal(url, 'https://api.openai.com/v1/decisions'); const body = JSON.parse(String(init?.body)); assert.ok(tokenCount(JSON.stringify(body)) <= 12000); const items = JSON.parse(body.input); for (const c of items) assert.equal(c.text, chunks.find(x => x.id === c.id)!.text); calls++; return Response.json(data(items.map((x: any) => x.id))); } });
    const initial = response.traces.filter(t => t.stage === 'window').flatMap(t => t.candidateIds);
    assert.equal(new Set(initial).size, chunks.length); assert.equal(initial.length, chunks.length);
    assert.equal(response.ranking.length, 5); assert.equal(new Set(response.ranking.map(r => r.chunkId)).size, 5);
    assert.equal(response.ranking[0].chunkId, 'c299');
    assert.ok(response.traces.some(t => t.stage === 'final' && t.level! >= 2));
    assert.equal(f.ledger.attempts().length, calls);
    assert.ok(f.ledger.attempts().every(a => a.costUsd === '0.00001'));
  } finally { f.close(); }
});
test('unknown HTTP failure remains reserved and cannot automatically retry the same request', async () => {
  const f = fixture(); process.env.OPENAI_API_KEY = 'test-local'; let calls = 0;
  const options = { config, ledger: f.ledger, runId: `${EXTENSION}:test:failure`, documentId: 'doc', method: 'decisions-scan' as const, chunks: [chunk(0)], query: 'x', signal: new AbortController().signal, allowPaid: true, fetcher: async () => { calls++; return Response.json({ error: { code: 'unavailable' } }, { status: 503 }); } };
  try { await assert.rejects(searchDecisions(options)); await assert.rejects(searchDecisions(options)); assert.equal(calls, 1); assert.equal(f.ledger.attempts().length, 1); assert.equal(f.ledger.totals().reservedUsd, '0.0272'); } finally { f.close(); }
});
test('new schedule preserves original question, round, generation and timing assignments', () => {
  const base = readJson<ExperimentManifest>(manifestPath);
  const schedule = extensionSchedule(base, [], 'main');
  assert.equal(schedule.length, 1352); assert.equal(schedule.filter(r => r.round === 0).length, 952); assert.equal(schedule.filter(r => r.timingSample).length, 600); assert.equal(schedule.filter(r => r.generate).length, 400);
  assert.equal(new Set(schedule.map(r => r.id)).size, 1352);
  for (const method of ['hybrid-decisions', 'decisions-scan']) assert.equal(new Set(schedule.filter(r => r.method === method && r.timingSample).map(r => r.questionId)).size, 100);
});
test('extension generation sends byte-equivalent payload to frozen generator', async () => {
  const a = fixture(), b = fixture(); process.env.OPENAI_API_KEY = 'test-local';
  const doc = { id: 'd', text: 'Evidence about freezing.', chunks: [{ ...chunk(0), text: 'Evidence about freezing.', start: 0, end: 24 }], blocks: [], tokenCount: 4 };
  const question = { id: 'q', documentId: 'd', question: 'When does it freeze?', answer: 'At zero.', evidenceSets: [] } as any;
  const run = { id: `${EXTENSION}:test:generation`, method: 'hybrid-decisions', ranking: [{ chunkId: 'c0', score: 1 }] } as ExtensionRun;
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ model: config.models.generation, status: 'completed', usage: { input_tokens: 100, output_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answer: 'At zero.', citationLabels: [], abstained: false }) }] }] }); };
  try {
    await generate(config, a.ledger, question, doc, run, new AbortController().signal, true, fetcher);
    const methods = new Methods({ config, ledger: b.ledger, experimentId: 'test', cacheDir: '/tmp', mock: false, allowPaid: true, signal: new AbortController().signal, fetcher });
    await methods.generate(question, doc, { ...run, method: 'hybrid-jev' } as any);
    assert.equal(hashObject(bodies[0]), hashObject(bodies[1]));
  } finally { a.close(); b.close(); }
});
