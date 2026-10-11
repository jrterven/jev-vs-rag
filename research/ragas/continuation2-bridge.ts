/** Second explicit narrow continuation of the frozen judge run; original bridge remains untouched. */
import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import { BudgetExceeded, Ledger, paidJson, type PriceSnapshot } from '../ledger.js';
import { hashObject, sha256, writeJson } from '../util.js';
import { Semaphore } from '../../server/engines/common.js';
import { createContinuation2Policy, CONTINUATION_RUN_ID } from './continuation2-policy.js';

export const JUDGE_MODEL = 'gpt-6.1-sol';
export const JUDGE_PRICE: PriceSnapshot = { input: '2', cachedInput: '0.10', cacheWrite: '2.50', output: '10', inputTokenLimit: 272_000, date: '2026-10-04', source: 'https://developers.openai.com/api/docs/pricing' };
export const JUDGE_METRICS = ['faithfulness', 'factual_correctness', 'answer_accuracy'] as const;
export interface JudgeRequest { requestId: string; sampleId: string; metric: typeof JUDGE_METRICS[number]; messages: Array<{ role: 'system' | 'developer' | 'user' | 'assistant'; content: string }>; schema: Record<string, unknown>; schemaName: string; }
export interface BridgeOptions { acknowledgmentPath: string; runId: string; directory: string; ledgerPath: string; apiKey: string; token: string; allowPaid: boolean; maxEvalUsd?: string; maxOutputTokens?: 4096 | 8192; concurrency?: number; timeoutMs?: number; inputHash?: string; signal?: AbortSignal; fetcher?: typeof fetch; }
class BridgeError extends Error { constructor(readonly status: number, message: string, readonly attemptId?: string, readonly code?: string) { super(message); } }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parseRequest(value: unknown): JudgeRequest {
  if (!isRecord(value) || Object.keys(value).some(k => !['requestId', 'sampleId', 'metric', 'messages', 'schema', 'schemaName'].includes(k))) throw new BridgeError(400, 'Invalid judge request fields.');
  for (const key of ['requestId', 'sampleId'] as const) if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 200 || /[\u0000-\u001f]/u.test(value[key])) throw new BridgeError(400, `Invalid ${key}.`);
  if (!JUDGE_METRICS.includes(value.metric as JudgeRequest['metric']) || typeof value.schemaName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.schemaName) || !isRecord(value.schema)) throw new BridgeError(400, 'Invalid metric or output schema.');
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 100 || value.messages.some(m => !isRecord(m) || Object.keys(m).some(k => !['role', 'content'].includes(k)) || !['system', 'developer', 'user', 'assistant'].includes(String(m.role)) || typeof m.content !== 'string')) throw new BridgeError(400, 'Invalid judge messages.');
  return value as unknown as JudgeRequest;
}

export function buildContinuation2JudgeBridge(options: BridgeOptions) {
  if (options.runId !== CONTINUATION_RUN_ID) throw new Error('Continuation is restricted to the acknowledged judge run.');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.runId)) throw new Error('Invalid judge run ID.');
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error('Judge bridge requires a 32-byte random hex bearer token.');
  const maxEvalUsd = options.maxEvalUsd ?? '80', maxOutputTokens = options.maxOutputTokens ?? 8192, concurrency = options.concurrency ?? 2;
  if (!new Decimal(maxEvalUsd).isFinite() || new Decimal(maxEvalUsd).lte(0) || new Decimal(maxEvalUsd).gt(200) || ![4096, 8192].includes(maxOutputTokens)) throw new Error('Invalid judge evaluation budget/output limit.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Judge concurrency must be an integer from 1 to 8.');
  if (options.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(options.inputHash)) throw new Error('Invalid input SHA-256.');
  const directory = resolve(options.directory), runPrefix = `${options.runId}:`;
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  mkdirSync(join(directory, 'requests'), { recursive: true, mode: 0o700 }); chmodSync(join(directory, 'requests'), 0o700);
  const ledger = new Ledger(resolve(options.ledgerPath), '200');
  const config = { schemaVersion: 1, kind: 'ragas-judge', runId: options.runId, ledgerPath: resolve(options.ledgerPath), model: JUDGE_MODEL, reasoning: { effort: 'medium' }, serviceTier: 'default', store: false, maxOutputTokens, timeoutMs: options.timeoutMs ?? 180_000, maxEvalUsd, globalBudgetUsd: '200', concurrency, retries: 0, stopOnSettledUnknownUsage: true, price: JUDGE_PRICE, inputByteLimit: 200_000, reservedInputTokens: 272_000, cachePolicy: 'implicit', ...(options.inputHash ? { inputHash: options.inputHash } : {}), bridgeSourceHash: sha256(readFileSync(new URL('./bridge.ts', import.meta.url))), ledgerSourceHash: sha256(readFileSync(new URL('../ledger.ts', import.meta.url))), accountingReference: 'https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance' };
  let policy: ReturnType<typeof createContinuation2Policy>;
  try {
    policy = createContinuation2Policy({ acknowledgmentPath: options.acknowledgmentPath, ledger, config, configPath: join(directory, 'bridge-config.json') });
    ledger.freeze(`ragas:${options.runId}:continuation2`, policy.lineage);
    writeJson(join(directory, 'continuation2.json'), policy.lineage, true);
  }
  catch (error) { ledger.close(); throw error; }
  // Reserve the full short-context boundary at the most expensive input rate,
  // plus all allowed output (including reasoning). This is released to actual
  // usage only when its complete read/write breakdown is known.
  const reservedUsd = new Decimal(config.reservedInputTokens).mul(JUDGE_PRICE.cacheWrite!).add(new Decimal(maxOutputTokens).mul(JUDGE_PRICE.output)).div(1e6).toFixed();
  const signal = options.signal ?? new AbortController().signal, semaphore = new Semaphore(concurrency);
  const inFlight = new Map<string, Promise<{ text: string; attemptId: string; model: string }>>();
  const saveBudget = () => writeJson(join(directory, 'continuation2-budget.json'), { runId: options.runId, global: ledger.totals(), evaluation: ledger.totals(runPrefix), maxEvalUsd });
  const app = Fastify({ logger: false, bodyLimit: 256_000 });
  app.addHook('onRequest', async (request, reply) => {
    const auth = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${options.token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply.code(401).send({ error: 'Unauthorized.' });
    if (request.headers.origin !== undefined) return reply.code(403).send({ error: 'Browser origins are not accepted.' });
  });
  app.get('/health', async () => ({ ok: true, model: JUDGE_MODEL, runId: options.runId }));
  app.post('/judge', async (request, reply) => {
    let input: JudgeRequest;
    try { input = parseRequest(request.body); } catch (error) { return reply.code(400).send({ error: error instanceof BridgeError ? error.message : 'Invalid judge request.' }); }
    try { policy.assertRequest(input); } catch { return reply.code(409).send({ error: 'Metric is terminal or outside the authorized missing scope.', code: 'continuation_scope' }); }
    const requestHash = hashObject(input), key = sha256(input.requestId), logicalKey = `${runPrefix}judge:${key}`, recordPath = join(directory, 'requests', `${key}.json`);
    const body = { model: JUDGE_MODEL, store: false, service_tier: 'default', reasoning: { effort: 'medium' }, max_output_tokens: maxOutputTokens, prompt_cache_options: { mode: 'implicit' }, input: input.messages, text: { format: { type: 'json_schema', name: input.schemaName, strict: true, schema: input.schema } } };
    if (Buffer.byteLength(JSON.stringify(body)) > config.inputByteLimit) return reply.code(413).send({ error: 'Judge input exceeds the conservative short-context byte limit.' });
    const record = { requestHash, payloadHash: hashObject(body), promptHash: hashObject(input.messages), schemaHash: hashObject(input.schema), request: input, providerBody: body };
    try { ledger.freeze(`${logicalKey}:input`, record); writeJson(recordPath, record, true); }
    catch { return reply.code(409).send({ error: 'Request ID already frozen with a different payload.' }); }
    const execute = async () => {
      const settled = ledger.get<{ ok: boolean; text?: string; attemptId?: string; model?: string; error?: string }>(`${logicalKey}:result`);
      if (settled) { if (!settled.ok) throw new BridgeError(409, 'This request already failed; no automatic paid retry.', settled.attemptId); return { text: settled.text!, attemptId: settled.attemptId!, model: settled.model! }; }
      const prior = ledger.attempts().find(a => a.logicalKey === logicalKey);
      if (prior && !ledger.response(logicalKey)) throw new BridgeError(409, 'Prior request is pending, failed or unknown; no automatic paid retry.', prior.id);
      if (!ledger.response(logicalKey)) {
        try { policy.beforeNewCall(); } catch { throw new BridgeError(409, 'Continuation guard failed; no new paid evaluation.', undefined, 'usage_unknown'); }
      }
      if (!options.allowPaid) throw new BridgeError(403, 'Paid judge calls are disabled.');
      let response: Awaited<ReturnType<typeof paidJson>> | undefined;
      try {
        response = await paidJson({ ledger, logicalKey, runId: `${runPrefix}${key}`, documentId: input.sampleId, method: 'ragas-judge', operation: `ragas_${input.metric}`, model: JUDGE_MODEL, price: JUDGE_PRICE, reservedUsd, budgetScope: { runPrefix, maxBudgetUsd: maxEvalUsd }, url: 'https://api.openai.com/v1/responses', apiKey: options.apiKey, body, provider: 'openai-generation', signal, timeoutMs: config.timeoutMs, allowPaid: options.allowPaid, fetcher: options.fetcher });
        const attemptId = response.attemptId ?? ledger.attempts().find(a => a.logicalKey === logicalKey)!.id;
        const data = response.data;
        if (response.status >= 400 || data.status !== 'completed') throw new BridgeError(502, `Judge response did not complete (HTTP ${response.status}).`, attemptId);
        if (data.model !== JUDGE_MODEL) throw new BridgeError(502, 'Judge returned an unexpected or missing model ID.', attemptId);
        const outputs = Array.isArray(data.output) ? data.output as Array<{ content?: Array<{ type?: string; text?: string }> }> : [];
        const text = outputs.flatMap(o => o.content ?? []).filter(c => c.type === 'output_text' && typeof c.text === 'string').map(c => c.text!).join('');
        try { JSON.parse(text); } catch { throw new BridgeError(502, 'Judge output is not complete structured JSON.', attemptId); }
        const result = { text, attemptId, model: JUDGE_MODEL };
        ledger.freeze(`${logicalKey}:result`, { ok: true, ...result });
        writeJson(join(directory, 'requests', `${key}.response.json`), { ok: true, ...result, providerResponse: data, attempt: ledger.attempts().find(a => a.id === attemptId) }, true);
        return result;
      } catch (error) {
        const attempt = ledger.attempts().find(a => a.logicalKey === logicalKey);
        const message = error instanceof BudgetExceeded ? 'Judge/global budget exhausted including unknown reservations.' : error instanceof BridgeError ? error.message : signal.aborted ? 'Judge interrupted; consumption may be unknown.' : 'Judge provider request failed; no automatic retry.';
        if (attempt) {
          const result = { ok: false, error: message, attemptId: attempt.id };
          ledger.freeze(`${logicalKey}:result`, result);
          writeJson(join(directory, 'requests', `${key}.response.json`), { ...result, attempt, ...(response ? { providerResponse: JSON.parse(JSON.stringify(response.data).replaceAll(options.apiKey || '\u0000', '[REDACTED]')) } : {}) }, true);
        }
        throw new BridgeError(error instanceof BudgetExceeded ? 402 : error instanceof BridgeError ? error.status : 502, message, attempt?.id);
      } finally { saveBudget(); }
    };
    try {
      let pending = inFlight.get(key);
      if (!pending) { pending = semaphore.use(signal, execute); inFlight.set(key, pending); void pending.finally(() => inFlight.delete(key)).catch(() => {}); }
      return await pending;
    } catch (error) { return reply.code(error instanceof BridgeError ? error.status : 503).send({ error: error instanceof BridgeError ? error.message : 'Judge unavailable.', ...(error instanceof BridgeError && error.attemptId ? { attemptId: error.attemptId } : {}), ...(error instanceof BridgeError && error.code ? { code: error.code } : {}) }); }
  });
  app.addHook('onClose', async () => { await Promise.allSettled(inFlight.values()); saveBudget(); ledger.close(); });
  saveBudget();
  return { app, ledger, config };
}

async function main() {
  await import('dotenv/config');
  const { values } = parseArgs({ options: { 'acknowledgment': { type: 'string' }, 'run-id': { type: 'string' }, out: { type: 'string' }, ledger: { type: 'string' }, 'max-eval-usd': { type: 'string', default: '80' }, 'max-output-tokens': { type: 'string', default: '8192' }, concurrency: { type: 'string', default: '2' }, port: { type: 'string', default: '0' }, input: { type: 'string' }, 'allow-paid': { type: 'boolean', default: false } } });
  if (!values.acknowledgment || !values['run-id'] || !values.out || !values.ledger || !values['allow-paid']) throw new Error('Required: --acknowledgment PATH --run-id ID --out DIR --ledger SHARED_LEDGER --allow-paid.');
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing server-side OPENAI_API_KEY.');
  const port = Number(values.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port.');
  const directory = resolve(values.out); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const lock = join(directory, 'bridge.lock'); writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const controller = new AbortController();
  let bridge: ReturnType<typeof buildContinuation2JudgeBridge> | undefined;
  try {
    const token = randomBytes(32).toString('hex'), tokenFile = join(directory, 'continuation2.token');
    writeFileSync(tokenFile, token + '\n', { mode: 0o600 }); chmodSync(tokenFile, 0o600);
    bridge = buildContinuation2JudgeBridge({ acknowledgmentPath: values.acknowledgment, runId: values['run-id'], directory, ledgerPath: values.ledger, apiKey: process.env.OPENAI_API_KEY, token, allowPaid: true, maxEvalUsd: values['max-eval-usd'], maxOutputTokens: Number(values['max-output-tokens']) as 4096 | 8192, concurrency: Number(values.concurrency), signal: controller.signal, ...(values.input ? { inputHash: sha256(readFileSync(resolve(values.input))) } : {}) });
    const address = await bridge.app.listen({ host: '127.0.0.1', port });
    const infoPath = join(directory, 'continuation2-info.json');
    writeJson(infoPath, { url: `${address}/judge`, tokenFile, model: JUDGE_MODEL, runId: values['run-id'] });
    process.stdout.write(JSON.stringify({ bridgeInfo: infoPath, url: `${address}/judge`, tokenFile, model: JUDGE_MODEL }) + '\n');
    await new Promise<void>(resolveDone => { const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); controller.abort(new Error('Judge bridge interrupted.')); resolveDone(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); });
  } finally { controller.abort(); if (bridge) await bridge.app.close(); unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Judge bridge failed.') + '\n'); process.exitCode = 1; });
