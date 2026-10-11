/** Decisions extension. The frozen Jev traversal is reused; only its evaluator changes. */
import { JevEngine } from '../../server/engines/jev.js';
import { ProviderError, tokenCount } from '../../server/engines/common.js';
import { readConfig } from '../../server/config.js';
import type { WorkContext } from '../../server/contracts.js';
import type { Chunk } from '../../shared/types.js';
import { Ledger, paidJson, type BudgetScope } from '../ledger.js';
import { hashObject, sha256 } from '../util.js';
import type { ResearchConfig, RetrievalResult, StageTrace } from '../types.js';

export const EXTENSION = 'decisions-extension-20261007-v1';
export const SCOPE: BudgetScope = { runPrefix: EXTENSION + ':', maxBudgetUsd: '100' };
export const DECISIONS_MODEL = 'gpt-6-luna';
// Flat input pricing: cache tokens are included in input, with no additional cache fee.
export const DECISIONS_PRICE = { input: '0.10', output: '0', cachedInput: '0.10', cacheWrite: '0.10', inputTokenLimit: 272000, date: '2026-10-07', source: 'https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability' };
export type ExtensionMethod = 'hybrid-decisions' | 'decisions-scan';
export interface JevSearchBody { state: Array<{ id: string; sections: string[]; text: string }>; questions: { where: { instructions: unknown }; exists: { instructions: unknown; criteria: unknown } }; }
export function translateRequest(body: JevSearchBody) {
  return { model: DECISIONS_MODEL, input: JSON.stringify(body.state), questions: [
    { type: 'choice', name: 'where', instructions: JSON.stringify(body.questions.where.instructions), choices: body.state.map(c => ({ value: c.id, description: `Fragment ${c.id}` })) },
    { type: 'predicate', name: 'exists', instructions: JSON.stringify({ instructions: body.questions.exists.instructions, criteria: body.questions.exists.criteria }) },
  ] };
}
export function translateAnswer(data: Record<string, unknown>, ids: string[]) {
  if (data.model !== DECISIONS_MODEL || !Array.isArray(data.answers) || data.answers.length !== 2) throw new Error('Decisions response model/answer count mismatch.');
  const [choice, exists] = data.answers as Array<Record<string, unknown>>;
  const prob = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  if (choice.type !== 'choice' || choice.name !== 'where' || exists.type !== 'predicate' || exists.name !== 'exists' || !prob(exists.probability)) throw new Error('Decisions refusal or unexpected answer schema.');
  const raw = choice.probabilities as Array<{ value: string; probability: number }>;
  if (!Array.isArray(raw) || raw.length !== ids.length || new Set(ids).size !== ids.length || new Set(raw.map(p => p.value)).size !== ids.length || raw.some(p => !ids.includes(p.value) || !prob(p.probability)) || !ids.includes(String(choice.choice))) throw new Error('Decisions omitted or duplicated a candidate probability.');
  if (Math.abs(raw.reduce((n, p) => n + p.probability, 0) - 1) > 0.02) throw new Error('Decisions probabilities do not sum to one.');
  return { model: data.model, usage: data.usage, answers: { where: { probabilities: Object.fromEntries(raw.map(p => [p.value, p.probability])) }, exists: { noul: exists.probability } } };
}
export function assertNotAttempted(ledger: Ledger, logicalKey: string) {
  if (ledger.db.prepare('SELECT id FROM attempts WHERE logical_key=? LIMIT 1').get(logicalKey)) throw new Error('Terminal/pending API attempt already exists; no automatic retry.');
}
export async function searchDecisions(options: { config: ResearchConfig; ledger: Ledger; runId: string; documentId: string; method: ExtensionMethod; chunks: Chunk[]; query: string; signal: AbortSignal; allowPaid: boolean; fetcher?: typeof fetch }): Promise<RetrievalResult> {
  const { config, ledger, runId, chunks, query, signal } = options;
  const traces: StageTrace[] = [], levels = new Map<string, number>();
  const trace = (event: StageTrace) => { ledger.trace(runId, event); traces.push(event); };
  // Preserve the original packing model string and traversal byte-for-byte.
  const runtime = readConfig({ JEV_MODEL: config.models.jev, JEV_WINDOW_TOKENS: String(config.jevWindowTokens), PROVIDER_CONCURRENCY: String(config.concurrency), TYPESAFE_API_KEY: 'decisions-adapter-no-jev-call', REQUEST_TIMEOUT_MS: String(config.requestTimeoutMs), DATA_DIR: 'data/research/decisions-cache' });
  const fetcher: typeof fetch = async (_url, init) => {
    const original = JSON.parse(String(init?.body)) as JevSearchBody;
    const level = levels.get(sha256(JSON.stringify(original)));
    if (level === undefined) throw new Error('Missing traversal request trace.');
    const body = translateRequest(original), payloadHash = hashObject(body), ids = original.state.map(c => c.id);
    const estimatedTokens = tokenCount(JSON.stringify(body));
    if (estimatedTokens > config.jevWindowTokens) {
      trace({ stage: 'decisions_local_budget_split', level, candidateIds: ids, retainedIds: [], payloadHash });
      // No provider call or paid attempt; the unchanged traversal splits the group.
      throw new ProviderError('Translated payload exceeds preventive token budget.', 413, true);
    }
    const operation = level === 0 ? 'window' : 'reduction';
    const logicalKey = `${runId}:decisions:${level}:${payloadHash}`;
    assertNotAttempted(ledger, logicalKey);
    const start = performance.now();
    trace({ stage: 'decisions_request', level, candidateIds: ids, retainedIds: [], payloadHash });
    const result = await paidJson({ ledger, logicalKey, runId, documentId: options.documentId, method: options.method, operation, model: DECISIONS_MODEL,
      price: DECISIONS_PRICE, reservedUsd: '0.0272', budgetScope: SCOPE, url: 'https://api.openai.com/v1/decisions', apiKey: process.env.OPENAI_API_KEY ?? '', body, provider: 'openai-generation', signal, timeoutMs: config.requestTimeoutMs, allowPaid: options.allowPaid, fetcher: options.fetcher });
    ledger.freeze(`${logicalKey}:receipt`, { attemptId: result.attemptId, estimatedTokens, level, candidateIds: ids, payloadHash, elapsedMs: performance.now() - start });
    if (result.status >= 400) return Response.json(result.data, { status: result.status });
    return Response.json(translateAnswer(result.data, ids));
  };
  const context: WorkContext = { documentId: options.documentId, jobId: EXTENSION, runId, config: runtime, signal,
    attempts: { start: () => {}, finish: () => {} }, progress: () => {}, checkpoint: (key, value) => { ledger.freeze(`${runId}:${key}`, value); }, getCheckpoint: key => ledger.get(`${runId}:${key}`),
    research: { retain: config.jevRetain, trace: event => { if (event.stage === 'request') levels.set(event.payloadHash, event.level); trace(event); } } };
  const start = performance.now();
  const output = await new JevEngine(runtime, fetcher).search(query, chunks, context);
  if (output.metrics.chunksCovered !== chunks.length) throw new Error('Decisions did not cover every initial candidate.');
  return { ranking: output.hits.map(h => ({ chunkId: h.chunkId, score: h.score })), phases: { decisionsSearchMs: performance.now() - start }, traces, existence: output.existence };
}
