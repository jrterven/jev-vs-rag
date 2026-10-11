import 'dotenv/config';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import type { RuntimeConfig } from './contracts.js';
import type { PublicConfig } from '../shared/types.js';
export const RATE_SOURCES = { jev: 'https://docs.typesafe.ai/models', rag: 'https://developers.openai.com/api/docs/models/text-embedding-3-small' };
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: valor fuera de rango.`);
  return value;
}
function rate(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const n = new Decimal(value);
  if (!n.isFinite() || n.isNegative()) throw new Error('Tarifa inválida.');
  return n.toString();
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const jevModel = env.JEV_MODEL || 'jev-1.13.0';
  const embeddingModel = env.EMBEDDING_MODEL || 'text-embedding-3-small';
  const chunkTokens = integer(env, 'CHUNK_TOKENS', 500, 100, 2000);
  const overlapTokens = integer(env, 'CHUNK_OVERLAP_TOKENS', 75, 0, chunkTokens - 1);
  return {
    dataDir: path.resolve(env.DATA_DIR || './data'), port: integer(env, 'PORT', 3001, 1, 65535), webPort: integer(env, 'WEB_PORT', 5174, 1, 65535),
    typesafeApiKey: env.TYPESAFE_API_KEY?.trim() || '', openaiApiKey: env.OPENAI_API_KEY?.trim() || '',
    jevModel, embeddingModel, jevBaseUrl: 'https://api.typesafe.ai/v1', openaiBaseUrl: 'https://api.openai.com/v1',
    maxFileMb: integer(env, 'MAX_FILE_MB', 100), maxTokens: integer(env, 'MAX_DOCUMENT_TOKENS', 1000000),
    maxPdfPages: integer(env, 'MAX_PDF_PAGES', 2000), chunkTokens, overlapTokens,
    jevWindowTokens: integer(env, 'JEV_WINDOW_TOKENS', 12000, 4000, 20000),
    concurrency: integer(env, 'PROVIDER_CONCURRENCY', 2, 1, 8), requestTimeoutMs: integer(env, 'REQUEST_TIMEOUT_MS', 120000, 1000, 600000),
    jevRate: rate(env.JEV_USD_PER_MILLION ?? (jevModel === 'jev-1.13.0' ? '0.042' : undefined)),
    embeddingRate: rate(env.EMBEDDING_USD_PER_MILLION ?? (embeddingModel === 'text-embedding-3-small' ? '0.02' : undefined)),
    rateDate: env.PRICE_DATE || '2026-10-02',
  };
}
export function publicConfig(c: RuntimeConfig): PublicConfig {
  return { keys: { jev: Boolean(c.typesafeApiKey), rag: Boolean(c.openaiApiKey) }, models: { jev: c.jevModel, rag: c.embeddingModel },
    limits: { maxFileMb: c.maxFileMb, maxTokens: c.maxTokens, maxPdfPages: c.maxPdfPages },
    chunkTokens: c.chunkTokens, overlapTokens: c.overlapTokens, jevWindowTokens: c.jevWindowTokens, concurrency: c.concurrency,
    rates: { jev: { usdPerMillion: c.jevRate, date: c.rateDate, source: RATE_SOURCES.jev }, rag: { usdPerMillion: c.embeddingRate, date: c.rateDate, source: RATE_SOURCES.rag } } };
}
