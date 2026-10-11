import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { hashObject, stableJson } from './util.js';
import type { QueryRun } from './types.js';
import type { StageTrace } from './types.js';

export interface PriceSnapshot { input: string; output: string; cachedInput?: string; cacheWrite?: string; inputTokenLimit?: number; date: string; source: string; }
export interface BudgetScope { runPrefix: string; maxBudgetUsd: string; }
export interface PaidAttempt { id: string; logicalKey: string; runId: string; documentId: string; method: string; operation: string; model: string; reportedModel?: string; payloadHash: string; price: PriceSnapshot; reservedUsd: string; status: 'pending' | 'completed' | 'failed' | 'unknown'; costUsd: string | null; inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number; usage?: Record<string, unknown>; responseId?: string; providerRequestId?: string; responseStatus?: string; startedAt: string; finishedAt?: string; elapsedMs?: number; error?: string; }
export class BudgetExceeded extends Error { constructor() { super('API budget exhausted including pending and unknown reservations.'); } }
export class Ledger {
  readonly db: DatabaseSync;
  readonly limit: Decimal;
  constructor(path: string, readonly maxBudgetUsd = '200') {
    this.limit = new Decimal(maxBudgetUsd);
    if (!this.limit.isFinite() || this.limit.lte(0) || this.limit.gt(200)) throw new Error('Research API budget must be >0 and <= USD 200.');
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS immutable(key TEXT PRIMARY KEY, hash TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, logical_key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS responses(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.freeze('budget-limit', { maxBudgetUsd });
  }
  close() { this.db.close(); }
  freeze<T>(key: string, value: T): T { const found = this.get<T>(key); if (found !== undefined) { if (stableJson(found) !== stableJson(value)) throw new Error(`Immutable manifest/checkpoint mismatch: ${key}`); return found; } this.db.prepare('INSERT INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value)); return value; }
  get<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value,hash FROM immutable WHERE key=?').get(key) as { value: string; hash: string } | undefined; if (!row) return undefined; const value: T = JSON.parse(row.value); if (hashObject(value) !== row.hash) throw new Error('Stored checkpoint hash mismatch.'); return value; }
  trace(runId: string, event: StageTrace) { this.freeze(`${runId}:trace:${hashObject(event)}`, event); }
  traces(runId: string): StageTrace[] { const prefix = `${runId}:trace:`; return (this.db.prepare('SELECT value FROM immutable WHERE substr(key,1,?)=? ORDER BY rowid').all(prefix.length, prefix) as Array<{ value: string }>).map(r => JSON.parse(r.value)); }
  attempts(): PaidAttempt[] { return (this.db.prepare('SELECT value FROM attempts ORDER BY rowid').all() as Array<{ value: string }>).map(r => JSON.parse(r.value)); }
  totals(runPrefix?: string) { let known = new Decimal(0), reserved = new Decimal(0), unknown = 0; for (const a of this.attempts().filter(a => runPrefix === undefined || a.runId.startsWith(runPrefix))) { if (a.costUsd !== null) known = known.add(a.costUsd); else { reserved = reserved.add(a.reservedUsd); unknown++; } } return { knownUsd: known.toFixed(), reservedUsd: reserved.toFixed(), committedUsd: known.add(reserved).toFixed(), unknownAttempts: unknown }; }
  reserve(input: Omit<PaidAttempt, 'id' | 'status' | 'costUsd' | 'startedAt'>, scope?: BudgetScope): PaidAttempt {
    const reserve = new Decimal(input.reservedUsd); if (!reserve.isFinite() || reserve.lt(0)) throw new Error('Invalid budget reservation.');
    if (scope && (!scope.runPrefix || !input.runId.startsWith(scope.runPrefix) || !new Decimal(scope.maxBudgetUsd).isFinite() || new Decimal(scope.maxBudgetUsd).lte(0) || new Decimal(scope.maxBudgetUsd).gt(this.limit))) throw new Error('Invalid scoped budget.');
    this.db.exec('BEGIN IMMEDIATE');
    try { if (scope) { this.freeze(`budget-scope:${scope.runPrefix}`, scope); if (new Decimal(this.totals(scope.runPrefix).committedUsd).add(reserve).gt(scope.maxBudgetUsd)) throw new BudgetExceeded(); } if (this.get('budget-halt') || new Decimal(this.totals().committedUsd).add(reserve).gt(this.limit)) throw new BudgetExceeded(); const attempt: PaidAttempt = { ...input, id: randomUUID(), status: 'pending', costUsd: null, startedAt: new Date().toISOString() }; this.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, attempt.logicalKey, JSON.stringify(attempt)); this.db.exec('COMMIT'); return attempt; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(id: string, patch: Pick<PaidAttempt, 'status' | 'costUsd'> & Partial<Pick<PaidAttempt, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'usage' | 'responseId' | 'providerRequestId' | 'responseStatus' | 'elapsedMs' | 'error' | 'reportedModel'>>, response?: { key: string; value: unknown }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT value FROM attempts WHERE id=?').get(id) as { value: string } | undefined;
      if (!row) throw new Error('Unknown attempt.'); const current: PaidAttempt = JSON.parse(row.value);
      if (current.status !== 'pending') throw new Error('An attempt can be settled only once.');
      if (patch.costUsd !== null && new Decimal(patch.costUsd).gt(current.reservedUsd) && !this.get('budget-halt')) this.freeze('budget-halt', { reason: 'Reported usage exceeded reservation; reconcile before further calls.', attemptId: id });
      const done = { ...current, ...patch, finishedAt: new Date().toISOString() };
      this.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(done), id);
      if (response) this.db.prepare('INSERT INTO responses VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(response.key, JSON.stringify(response.value));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  response<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM responses WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : undefined; }
  startRun(id: string, value: unknown) { const row = this.db.prepare('SELECT status FROM runs WHERE id=?').get(id) as { status: string } | undefined; if (row?.status === 'completed') throw new Error('Completed run is immutable.'); this.db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value').run(id, 'running', JSON.stringify(value)); }
  saveRun(run: QueryRun) { const old = this.runs().find(r => r.id === run.id); if (old?.status === 'completed' && stableJson(old) !== stableJson(run)) throw new Error('Completed run is immutable.'); this.db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value').run(run.id, run.status, JSON.stringify(run)); }
  runs(): QueryRun[] { return (this.db.prepare("SELECT value FROM runs WHERE status!='running' ORDER BY rowid").all() as Array<{ value: string }>).map(r => JSON.parse(r.value)); }
  pendingRuns(): string[] { return (this.db.prepare("SELECT id FROM runs WHERE status='running'").all() as Array<{ id: string }>).map(r => r.id); }
}

export async function paidJson(options: { ledger: Ledger; logicalKey: string; runId: string; documentId: string; method: string; operation: string; model: string; price: PriceSnapshot; reservedUsd: string; url: string; apiKey: string; body: unknown; provider: 'jev' | 'openai-embedding' | 'openai-generation'; budgetScope?: BudgetScope; signal?: AbortSignal; timeoutMs?: number; allowPaid: boolean; fetcher?: typeof fetch }): Promise<{ status: number; data: Record<string, unknown>; retryAfter?: string; attemptId?: string }> {
  const cached = options.ledger.response<{ status: number; data: Record<string, unknown>; payloadHash: string; retryAfter?: string; attemptId?: string }>(options.logicalKey);
  if (cached) { if (cached.payloadHash !== hashObject(options.body)) throw new Error('Response recovery payload mismatch.'); return cached; } // Recovery of the same immutable run, never a query cache between repetitions.
  if (!options.allowPaid) throw new Error('Paid calls disabled. Pass --allow-paid explicitly.');
  if (!options.apiKey) throw new Error('Missing server-side API key.');
  options.signal?.throwIfAborted();
  const attempt = options.ledger.reserve({ logicalKey: options.logicalKey, runId: options.runId, documentId: options.documentId, method: options.method, operation: options.operation, model: options.model, payloadHash: hashObject(options.body), price: options.price, reservedUsd: options.reservedUsd }, options.budgetScope);
  const start = performance.now(); let settled = false;
  try {
    const response = await (options.fetcher ?? fetch)(options.url, { method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(options.body), signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 120000)]) });
    const data = await response.json() as Record<string, unknown>, usage = (data.usage ?? {}) as Record<string, unknown>;
    const tokens = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
    const input = tokens(usage[options.provider === 'openai-embedding' ? 'prompt_tokens' : 'input_tokens']);
    const output = tokens(usage.output_tokens) ?? (options.provider === 'openai-generation' ? undefined : 0);
    const details = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
    // GPT-5.6+ cache writes replace ordinary-input billing; they are not additive.
    // A configured write tariff requires an explicit, valid read/write breakdown.
    const cachedInput = details.cached_tokens === undefined && options.price.cacheWrite === undefined ? 0 : tokens(details.cached_tokens);
    const cacheWrite = details.cache_write_tokens === undefined && options.price.cacheWrite === undefined ? 0 : tokens(details.cache_write_tokens);
    const actualModel = typeof data.model === 'string' ? data.model : options.model;
    const priceKnown = actualModel === options.model && (options.price.cacheWrite === undefined || typeof data.model === 'string');
    const cost = input !== undefined && output !== undefined && priceKnown && cachedInput !== undefined && cacheWrite !== undefined && cachedInput + cacheWrite <= input && (cacheWrite === 0 || options.price.cacheWrite !== undefined) && (options.price.inputTokenLimit === undefined || input <= options.price.inputTokenLimit) ? new Decimal(input - cachedInput - cacheWrite).mul(options.price.input).add(new Decimal(cachedInput).mul(options.price.cachedInput ?? options.price.input)).add(new Decimal(cacheWrite).mul(options.price.cacheWrite ?? 0)).add(new Decimal(output).mul(options.price.output)).div(1e6).toFixed() : null;
    const value = { status: response.status, data, attemptId: attempt.id, payloadHash: hashObject(options.body), ...(response.headers.get('retry-after') ? { retryAfter: response.headers.get('retry-after')! } : {}) };
    options.ledger.finish(attempt.id, { status: cost === null ? 'unknown' : response.ok ? 'completed' : 'failed', costUsd: cost, inputTokens: input, outputTokens: output, cachedTokens: cachedInput, cacheWriteTokens: cacheWrite, usage, responseId: typeof data.id === 'string' ? data.id : undefined, responseStatus: typeof data.status === 'string' ? data.status : undefined, providerRequestId: response.headers.get('x-request-id') ?? undefined, reportedModel: typeof data.model === 'string' ? data.model : undefined, elapsedMs: performance.now() - start, ...(!response.ok ? { error: `HTTP ${response.status}` } : {}) }, response.ok ? { key: options.logicalKey, value } : undefined); settled = true;
    return value;
  } catch (error) { if (!settled) options.ledger.finish(attempt.id, { status: 'unknown', costUsd: null, elapsedMs: performance.now() - start, error: error instanceof Error ? error.message.replaceAll(options.apiKey, '[REDACTED]').slice(0, 300) : 'Provider request failed.' }); throw error; }
}
