import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildJudgeBridge, JUDGE_MODEL, JUDGE_PRICE, type BridgeOptions, type JudgeRequest } from './bridge.js';
import { Ledger, paidJson } from '../ledger.js';
import { hashObject } from '../util.js';

const token = 'a'.repeat(64), apiKey = 'OFFLINE-PRIVATE-API-PLACEHOLDER';
const request = (requestId = 'ragas:one'): JudgeRequest => ({ requestId, sampleId: 'sample:one', metric: 'faithfulness', messages: [{ role: 'system', content: 'Judge only the provided statements.' }, { role: 'user', content: 'A literal quote: <answer>α 📚</answer>.' }], schemaName: 'Verdict', schema: { type: 'object', properties: { verdict: { type: 'boolean' } }, required: ['verdict'], additionalProperties: false } });
const response = (overrides: Record<string, unknown> = {}) => ({ id: 'resp_offline', model: JUDGE_MODEL, status: 'completed', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":true}' }] }], ...overrides });
const setup = (extra: Partial<BridgeOptions> = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'ragas-bridge-'));
  const options: BridgeOptions = { runId: 'judge-offline', directory: join(directory, 'private'), ledgerPath: join(directory, 'budget.sqlite'), apiKey, token, allowPaid: true, fetcher: async () => Response.json(response(), { headers: { 'x-request-id': 'req_offline' } }), ...extra };
  return { directory, options, ...buildJudgeBridge(options) };
};
const call = (app: ReturnType<typeof buildJudgeBridge>['app'], payload = request(), authorization = `Bearer ${token}`) => app.inject({ method: 'POST', url: '/judge', headers: { authorization }, payload });

test('judge authentication, browser-origin guard, input validation and paid flag prevent provider calls', async () => {
  let calls = 0;
  const s = setup({ allowPaid: false, fetcher: async () => { calls++; throw new Error('No call expected'); } });
  try {
    assert.equal((await call(s.app, request(), '')).statusCode, 401);
    assert.equal((await call(s.app, request(), `Bearer ${'é'.repeat(64)}`)).statusCode, 401);
    assert.equal((await s.app.inject({ method: 'POST', url: '/judge', headers: { authorization: `Bearer ${token}`, origin: 'https://example.invalid' }, payload: request() })).statusCode, 403);
    assert.equal((await call(s.app, { ...request(), model: 'other' } as JudgeRequest)).statusCode, 400);
    assert.equal((await call(s.app)).statusCode, 403);
    assert.equal(calls, 0); assert.equal(s.ledger.attempts().length, 0);
  } finally { await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
});

test('structured judge request is frozen verbatim and three input price categories plus reasoning output are billed once', async () => {
  let sent: Record<string, unknown> | undefined;
  const s = setup({ fetcher: async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json(response(), { headers: { 'x-request-id': 'req_offline' } }); } });
  try {
    const result = await call(s.app); assert.equal(result.statusCode, 200);
    assert.deepEqual(sent?.input, request().messages);
    assert.deepEqual(sent?.reasoning, { effort: 'medium' });
    assert.equal(sent?.model, 'gpt-6.1-sol'); assert.equal(sent?.max_output_tokens, 8192); assert.equal(sent?.store, false); assert.equal(sent?.service_tier, 'default');
    assert.deepEqual((sent?.text as { format: unknown }).format, { type: 'json_schema', name: 'Verdict', strict: true, schema: request().schema });
    const attempt = s.ledger.attempts()[0];
    assert.equal(attempt.method, 'ragas-judge'); assert.equal(attempt.operation, 'ragas_faithfulness');
    assert.equal(attempt.costUsd, '0.00277'); assert.equal(attempt.cacheWriteTokens, 300); assert.equal(attempt.cachedTokens, 200); assert.equal(attempt.outputTokens, 100);
    assert.equal(attempt.providerRequestId, 'req_offline'); assert.equal(attempt.responseId, 'resp_offline'); assert.deepEqual(attempt.usage, response().usage);
    assert.equal(result.json().attemptId, attempt.id); assert.equal(attempt.payloadHash, hashObject(sent));
    const files = readdirSync(join(s.options.directory, 'requests'));
    const sourceFile = files.find(x => !x.includes('.response.'))!;
    const persisted = JSON.parse(readFileSync(join(s.options.directory, 'requests', sourceFile), 'utf8'));
    assert.deepEqual(persisted.request, request()); assert.deepEqual(persisted.providerBody, sent);
    assert.equal(statSync(s.options.directory).mode & 0o777, 0o700);
    assert.ok(files.every(file => (statSync(join(s.options.directory, 'requests', file)).mode & 0o777) === 0o600));
    assert.equal(s.ledger.totals().knownUsd, '0.00277');
  } finally { await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
});

test('concurrent duplicate request and process restart reuse one settled attempt; changed payload is rejected', async () => {
  let calls = 0;
  const s = setup({ fetcher: async () => { calls++; await delay(10); return Response.json(response()); } });
  try {
    const [a, b] = await Promise.all([call(s.app), call(s.app)]);
    assert.equal(a.statusCode, 200); assert.deepEqual(a.json(), b.json()); assert.equal(calls, 1);
    assert.equal((await call(s.app, { ...request(), messages: [{ role: 'user', content: 'Changed prompt' }] })).statusCode, 409);
    await s.app.close();
    const reopened = buildJudgeBridge(s.options);
    try { assert.deepEqual((await call(reopened.app)).json(), a.json()); assert.equal(calls, 1); assert.equal(reopened.ledger.attempts().length, 1); }
    finally { await reopened.app.close(); }
    assert.throws(() => buildJudgeBridge({ ...s.options, maxEvalUsd: '21' }), /Immutable/);
  } finally { await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
});

test('evaluation and global budgets reserve atomically before the provider; unknown usage stays committed', async () => {
  let calls = 0;
  const scoped = setup({ maxEvalUsd: '0.7', fetcher: async () => { calls++; return Response.json(response()); } });
  try { assert.equal((await call(scoped.app)).statusCode, 402); assert.equal(calls, 0); assert.equal(scoped.ledger.attempts().length, 0); }
  finally { await scoped.app.close(); rmSync(scoped.directory, { recursive: true, force: true }); }
  const unknown = setup({ maxEvalUsd: '1', fetcher: async () => { calls++; return Response.json(response({ usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } } })); } });
  try {
    assert.equal((await call(unknown.app)).statusCode, 502);
    assert.equal(unknown.ledger.attempts()[0].costUsd, null); assert.equal(unknown.ledger.attempts()[0].status, 'unknown');
    assert.equal(unknown.ledger.totals().reservedUsd, '0.76192');
    const halted = await call(unknown.app, request('ragas:two'));
    assert.equal(halted.statusCode, 402);
    assert.equal((await call(unknown.app)).statusCode, 409, 'terminal errors are never retried');
    assert.equal(unknown.ledger.attempts().length, 1);
  } finally { await unknown.app.close(); rmSync(unknown.directory, { recursive: true, force: true }); }
  const global = setup();
  try {
    global.ledger.reserve({ logicalKey: 'existing', runId: 'prior-study:request', documentId: 'd', method: 'other', operation: 'other', model: 'other', payloadHash: 'x', price: { input: '1', output: '0', date: '2026-10-04', source: 'test' }, reservedUsd: '199.5' });
    assert.equal((await call(global.app)).statusCode, 402); assert.equal(global.ledger.attempts().length, 1);
  } finally { await global.app.close(); rmSync(global.directory, { recursive: true, force: true }); }
});

test('HTTP failure is terminal without retry and secrets stay out of client errors and response files', async () => {
  let calls = 0;
  const s = setup({ fetcher: async () => { calls++; return Response.json({ ...response(), error: { message: `Unavailable ${apiKey}` } }, { status: 429, headers: { 'retry-after': '1' } }); } });
  try {
    const first = await call(s.app); assert.equal(first.statusCode, 502); assert.ok(!first.body.includes(apiKey));
    const repeated = await call(s.app); assert.equal(repeated.statusCode, 409); assert.equal(calls, 1); assert.equal(s.ledger.attempts().length, 1);
    for (const file of readdirSync(join(s.options.directory, 'requests'))) assert.ok(!readFileSync(join(s.options.directory, 'requests', file), 'utf8').includes(apiKey));
  } finally { await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
});

test('interruption settles the in-flight request as unknown and persists both budget summaries', async () => {
  const controller = new AbortController(); let announce: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const s = setup({ signal: controller.signal, fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => { announce(); init?.signal?.addEventListener('abort', () => reject(new Error('simulated interruption')), { once: true }); }) });
  try {
    const pending = call(s.app); await started; controller.abort();
    assert.equal((await pending).statusCode, 502);
    assert.equal(s.ledger.attempts()[0].status, 'unknown');
    const budget = JSON.parse(readFileSync(join(s.options.directory, 'budget.json'), 'utf8'));
    assert.equal(budget.global.unknownAttempts, 1); assert.equal(budget.evaluation.unknownAttempts, 1);
    assert.equal(budget.global.committedUsd, '0.76192');
  } finally { await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
});

test('write-aware usage is unknown for missing, inconsistent, unpriced or wrong-model values; legacy prices remain compatible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ragas-usage-')), ledger = new Ledger(join(directory, 'budget.sqlite'));
  const cases = [
    { ...response(), usage: { input_tokens: 10, output_tokens: 1 } },
    { ...response(), usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 6 } } },
    { ...response(), usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: '0', cache_write_tokens: 0 } } },
    response({ model: 'different-model' }), response({ model: undefined }),
    response({ usage: { input_tokens: 272001, output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }),
  ];
  try {
    for (const [i, data] of cases.entries()) await paidJson({ ledger, logicalKey: `bad-${i}`, runId: 'usage:bad', documentId: 'd', method: 'ragas-judge', operation: 'ragas_faithfulness', model: JUDGE_MODEL, price: JUDGE_PRICE, reservedUsd: '1', url: 'https://example.invalid', apiKey, body: { i }, provider: 'openai-generation', allowPaid: true, fetcher: async () => Response.json(data) });
    assert.ok(ledger.attempts().every(a => a.costUsd === null));
    const legacy = { input: '0.4', cachedInput: '0.1', output: '1.6', date: '2026-10-04', source: 'test' };
    await paidJson({ ledger, logicalKey: 'legacy', runId: 'usage:legacy', documentId: 'd', method: 'old', operation: 'generation', model: 'old-model', price: legacy, reservedUsd: '1', url: 'https://example.invalid', apiKey, body: {}, provider: 'openai-generation', allowPaid: true, fetcher: async () => Response.json({ model: 'old-model', usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } } }) });
    assert.equal(ledger.attempts().at(-1)!.costUsd, '0.00005');
    await paidJson({ ledger, logicalKey: 'unpriced-write', runId: 'usage:legacy', documentId: 'd', method: 'old', operation: 'generation', model: JUDGE_MODEL, price: legacy, reservedUsd: '1', url: 'https://example.invalid', apiKey, body: {}, provider: 'openai-generation', allowPaid: true, fetcher: async () => Response.json(response()) });
    assert.equal(ledger.attempts().at(-1)!.costUsd, null);
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('question-aware answer_accuracy forwards the original prompt/schema and records its separate operation', async () => {
  let sent: Record<string, unknown> | undefined;
  const output = '{"rating":4,"reasoning":"The answer agrees with the reference in the context of the question."}';
  const s = setup({ fetcher: async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json(response({ output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] })); } });
  try {
    const input: JudgeRequest = { ...request('ragas:accuracy'), metric: 'answer_accuracy', messages: [{ role: 'user', content: 'Question: Did the treatment improve accuracy?\nReference: Yes.\nAnswer: The treatment improved accuracy.' }], schemaName: 'AccuracyRating', schema: { type: 'object', properties: { rating: { type: 'integer', enum: [0, 1, 2, 3, 4] }, reasoning: { type: 'string' } }, required: ['rating', 'reasoning'], additionalProperties: false } };
    const result = await call(s.app, input);
    assert.equal(result.statusCode, 200); assert.equal(result.json().text, output);
    assert.deepEqual(sent?.input, input.messages);
    assert.deepEqual((sent?.text as { format: unknown }).format, { type: 'json_schema', name: input.schemaName, strict: true, schema: input.schema });
    assert.equal(sent?.model, JUDGE_MODEL); assert.deepEqual(sent?.reasoning, { effort: 'medium' });
    assert.equal(s.ledger.attempts()[0].operation, 'ragas_answer_accuracy');
    assert.equal(s.ledger.attempts()[0].method, 'ragas-judge');
    assert.equal(s.config.concurrency, 2, 'backward-compatible default');
    assert.equal((await call(s.app, { ...input, requestId: 'ragas:bad-metric', metric: 'invented' } as unknown as JudgeRequest)).statusCode, 400);
  } finally { await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
});

test('configured provider concurrency is bounded, recorded and immutable', async () => {
  for (const concurrency of [2, 4]) {
    let active = 0, peak = 0, sent = 0;
    const releases: Array<() => void> = [];
    const s = setup({ concurrency, fetcher: async () => {
      sent++; active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--; return Response.json(response());
    } });
    const pending = Array.from({ length: 9 }, (_, i) => call(s.app, { ...request(`parallel:${i}`), metric: 'answer_accuracy' }));
    const waitFor = async (predicate: () => boolean) => { const deadline = performance.now() + 2000; while (!predicate()) { assert.ok(performance.now() < deadline, 'provider calls did not reach the expected barrier'); await delay(1); } };
    try {
      await waitFor(() => sent === concurrency); await delay(5);
      assert.equal(active, concurrency); assert.equal(sent, concurrency, 'queued requests must not enter the provider');
      while (sent < 9 || active) { while (releases.length) releases.shift()!(); await delay(1); }
      assert.ok((await Promise.all(pending)).every(r => r.statusCode === 200));
      assert.equal(peak, concurrency); assert.equal(sent, 9); assert.equal(s.ledger.attempts().length, 9);
      assert.equal(s.config.concurrency, concurrency);
      await s.app.close();
      assert.throws(() => buildJudgeBridge({ ...s.options, concurrency: concurrency + 1 }), /Immutable/);
      for (const invalid of [0, -1, 1.5, 9, NaN]) assert.throws(() => buildJudgeBridge({ ...s.options, concurrency: invalid }), /concurrency/);
    } finally { while (releases.length) releases.shift()!(); await s.app.close(); rmSync(s.directory, { recursive: true, force: true }); }
  }
});

 test('isolated provider failures stay terminal, three consecutive failures stop admissions',async()=>{
 let calls=0;const s=setup({fetcher:async()=>{calls++;return Response.json({error:{code:'server_overloaded'}},{status:503});}});
 try{for(let i=0;i<3;i++)assert.equal((await call(s.app,request('bounded:'+i))).statusCode,502);const stopped=await call(s.app,request('bounded:3'));assert.equal(stopped.statusCode,409);assert.equal(calls,3);assert.equal(s.ledger.attempts().length,3);assert.equal(s.ledger.totals().reservedUsd,'2.28576');}finally{await s.app.close();rmSync(s.directory,{recursive:true,force:true});}
 });
 test('extension and cumulative judge budgets include previous phases before admitting a call',async()=>{
 for(const [method,runId,reservedUsd] of [['other','decisions-extension-20261007-v1:earlier','99.5'],['ragas-judge','older-judge:earlier','79.5']]){
 let calls=0;const s=setup({fetcher:async()=>{calls++;return Response.json(response());}});
 try{s.ledger.reserve({logicalKey:'earlier',runId,documentId:'d',method,operation:'earlier',model:'m',payloadHash:'x',price:{input:'1',output:'0',date:'2026-10-07',source:'test'},reservedUsd});assert.equal((await call(s.app)).statusCode,402);assert.equal(calls,0);}finally{await s.app.close();rmSync(s.directory,{recursive:true,force:true});}
 }
 });
