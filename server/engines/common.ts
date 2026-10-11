import { randomUUID } from 'node:crypto';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { getEncoding } from 'js-tiktoken';
import type { Attempt, Engine, RunMetrics } from '../../shared/types.js';
import type { RuntimeConfig, WorkContext } from '../contracts.js';
import { costForTokens } from '../costs.js';

const encoder = getEncoding('cl100k_base');
export const tokenCount = (text: string): number => encoder.encode(text, [], []).length;
export function* iterateTextPieces(text: string, maxTokens: number): Generator<string> {
  // Work on bounded character slices, never re-encode a book's entire remainder.
  for (let offset = 0; offset < text.length;) {
    let size = Math.min(text.length - offset, maxTokens * 4);
    let piece = '';
    while (size > 0) {
      if (/[\uD800-\uDBFF]/.test(text[offset + size - 1])) size--;
      piece = text.slice(offset, offset + size);
      const count = tokenCount(piece);
      if (count <= maxTokens) break;
      size = Math.min(size - 1, Math.floor(size * maxTokens / count * 0.9));
    }
    if (!size) throw new Error('El presupuesto de tokens es demasiado pequeño.');
    yield piece; offset += size;
  }
}
export const textPieces = (text: string, maxTokens: number): string[] => [...iterateTextPieces(text, maxTokens)];

/** Linear conservative packing followed by one complete payload check per window.
 * The checks protect against token-boundary effects and JSON metadata overhead.
 * Runtime callers consume this generator asynchronously to keep the server responsive.
 */
export function* tokenBudgetPacking<T>(items: T[], body: (group: T[]) => unknown, itemTokens: (item: T) => number, budget: number, maxItems: number): Generator<void, T[][]> {
  const overhead = tokenCount(JSON.stringify(body([]))) + 8;
  const rough: T[][] = []; let group: T[] = []; let size = overhead;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]; const increment = itemTokens(item) + 8;
    if (group.length && (group.length >= maxItems || size + increment > budget)) { rough.push(group); group = []; size = overhead; }
    group.push(item); size += increment;
    if ((index + 1) % 32 === 0) yield;
  }
  if (group.length) rough.push(group);
  const windows: T[][] = [];
  for (const proposed of rough) {
    const pending = [proposed];
    while (pending.length) {
      const candidate = pending.pop()!;
      if (tokenCount(JSON.stringify(body(candidate))) <= budget) windows.push(candidate);
      else {
        if (candidate.length === 1) throw new Error('Un fragmento y la consulta superan el presupuesto de Jev. Aumenta JEV_WINDOW_TOKENS o reduce la consulta.');
        const middle = Math.ceil(candidate.length / 2);
        pending.push(candidate.slice(middle), candidate.slice(0, middle));
      }
      yield;
    }
  }
  return windows;
}
export function exhaustPacking<T>(steps: Generator<void, T[][]>): T[][] {
  let step = steps.next(); while (!step.done) step = steps.next(); return step.value;
}
export async function yieldPacking<T>(steps: Generator<void, T[][]>, signal?: AbortSignal): Promise<T[][]> {
  signal?.throwIfAborted();
  let step = steps.next();
  while (!step.done) { await yieldLoop(); signal?.throwIfAborted(); step = steps.next(); }
  return step.value;
}

export class EngineError extends Error {
  constructor(message: string, public readonly metrics: RunMetrics) { super(message); this.name = 'EngineError'; }
}
export class ProviderError extends Error {
  constructor(message: string, public status: number, public contextOverflow = false, public retryAfterMs = 0) {
    super(message); this.name = 'ProviderError';
  }
}
export const emptyMetrics = (chunks: number, concurrency: number): RunMetrics => ({ calls: 0, inputTokens: 0, windowsTotal: 0, windowsCompleted: 0, chunksTotal: chunks, chunksCovered: 0, reductionLevels: 0, concurrency });

export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private limit: number) {}
  async use<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiters = this.waiters.filter(w => w !== ready); reject(signal.reason); };
        this.waiters.push(ready); signal.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await work(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
}

export async function mapConcurrent<T, U>(values: T[], concurrency: number, signal: AbortSignal, fn: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0; let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length && failure === undefined) {
      const index = cursor++;
      try { signal.throwIfAborted(); results[index] = await fn(values[index], index); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure;
  return results;
}

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
const reportedTokens = (x: unknown): number | undefined => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : undefined;
const endpoint = (base: string, route: string) => {
  const clean = base.replace(/\/$/, '').replace(new RegExp(`/${route}$`), '');
  return `${clean.endsWith('/v1') ? clean : `${clean}/v1`}/${route}`;
};

export class ProviderClient {
  private semaphore: Semaphore;
  constructor(private engine: Engine, private config: RuntimeConfig, private fetcher: typeof fetch = fetch) {
    this.semaphore = new Semaphore(config.concurrency);
  }
  async request(body: Json, operation: Attempt['operation'], ctx: WorkContext, prepare: boolean, metrics?: RunMetrics): Promise<Json> {
    const key = this.engine === 'jev' ? this.config.typesafeApiKey : this.config.openaiApiKey;
    if (!key) throw new Error(`Falta ${this.engine === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY'} en .env.`);
    for (let retry = 0; ; retry++) {
      try {
        return await this.semaphore.use(ctx.signal, async () => {
          const id = randomUUID(); const start = performance.now();
          const model = this.engine === 'jev' ? this.config.jevModel : this.config.embeddingModel;
          const rate = this.engine === 'jev' ? this.config.jevRate : this.config.embeddingRate;
          ctx.attempts.start({ id, documentId: ctx.documentId, jobId: ctx.jobId, runId: ctx.runId, engine: this.engine, operation, model, startedAt: new Date().toISOString(), status: 'pending', rateUsdPerMillion: rate, rateDate: this.config.rateDate, rateSource: this.engine === 'jev' ? 'https://docs.typesafe.ai/models' : 'https://developers.openai.com/api/docs/models/text-embedding-3-small', costUsd: null });
          if (metrics) metrics.calls++;
          let inputTokens: number | undefined; let outputTokens: number | undefined; let actualModel: string | undefined;
          try {
            const base = this.engine === 'jev' ? this.config.jevBaseUrl : this.config.openaiBaseUrl;
            const response = await this.fetcher(endpoint(base, this.engine === 'jev' ? 'systemone' : 'embeddings'), { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]) });
            let data: Json = {};
            try { const value: unknown = await response.json(); if (isObject(value)) data = value; } catch { /* Usage is unknown when no parseable response arrives. */ }
            const usage = isObject(data.usage) ? data.usage : {};
            inputTokens = reportedTokens(this.engine === 'jev' ? usage.input_tokens : usage.prompt_tokens);
            outputTokens = reportedTokens(usage.output_tokens);
            actualModel = typeof data.model === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(data.model) ? data.model : undefined;
            if (metrics && inputTokens !== undefined) metrics.inputTokens += inputTokens;
            if (!response.ok) {
              // Inspect provider details only for routing; never persist echoed document text or credentials.
              const detail = JSON.stringify(data.error ?? data.detail ?? data).toLowerCase();
              const contextOverflow = [400, 413, 422].includes(response.status) && /context_length_exceeded|context.{0,45}(exceed|too long|limit|maximum)|token.{0,35}(exceed|maximum|limit)|too many tokens/.test(detail);
              const retryAfter = response.headers.get('retry-after');
              const retryAfterMs = retryAfter ? Math.max(0, Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
              const message = contextOverflow ? 'La petición supera el contexto permitido.' : `${this.engine === 'jev' ? 'Jev' : 'OpenAI'} devolvió HTTP ${response.status}.`;
              throw new ProviderError(message, response.status, contextOverflow, retryAfterMs);
            }
            const appliedRate = actualModel && actualModel !== model ? null : rate;
            ctx.attempts.finish(id, { status: 'completed', finishedAt: new Date().toISOString(), durationMs: performance.now() - start, inputTokens, outputTokens, model: actualModel ?? model, rateUsdPerMillion: appliedRate, costUsd: inputTokens === undefined ? null : costForTokens(inputTokens, appliedRate) });
            return data;
          } catch (error) {
            const message = ctx.signal.aborted ? 'Operación cancelada.' : error instanceof ProviderError ? error.message : 'No se recibió una respuesta válida del proveedor.';
            const appliedRate = actualModel && actualModel !== model ? null : rate;
            ctx.attempts.finish(id, { status: inputTokens === undefined ? 'unknown' : 'failed', finishedAt: new Date().toISOString(), durationMs: performance.now() - start, inputTokens, outputTokens, model: actualModel ?? model, rateUsdPerMillion: appliedRate, costUsd: inputTokens === undefined ? null : costForTokens(inputTokens, appliedRate), error: message });
            if (ctx.signal.aborted) ctx.signal.throwIfAborted();
            if (error instanceof ProviderError) throw error;
            throw new ProviderError(message, 0);
          }
        });
      } catch (error) {
        if (!prepare || retry >= 2 || !(error instanceof ProviderError) || !(error.status === 0 || error.status === 429 || error.status >= 500)) throw error;
        const ms = Math.max(1000 * 2 ** retry, error.retryAfterMs || 0);
        await delay(ms, undefined, { signal: ctx.signal });
      }
    }
  }
}
