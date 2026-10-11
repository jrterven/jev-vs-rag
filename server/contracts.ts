import type { Attempt, Block, Chunk, Engine, Hit, Progress, RunMetrics } from '../shared/types.js';
export interface RuntimeConfig {
  dataDir: string; port: number; webPort?: number; typesafeApiKey: string; openaiApiKey: string;
  jevModel: string; embeddingModel: string; jevBaseUrl: string; openaiBaseUrl: string;
  maxFileMb: number; maxTokens: number; maxPdfPages: number; chunkTokens: number; overlapTokens: number;
  jevWindowTokens: number; concurrency: number; requestTimeoutMs: number;
  jevRate: string | null; embeddingRate: string | null; rateDate: string;
}
export interface AttemptSink { start(attempt: Attempt): void; finish(id: string, patch: Partial<Attempt>): void; }
export interface WorkContext {
  documentId: string; jobId: string; runId?: string; config: RuntimeConfig; signal: AbortSignal;
  attempts: AttemptSink;
  progress(progress: Progress): void;
  checkpoint<T>(key: string, value: T): void;
  getCheckpoint<T>(key: string): T | undefined;
  /** Optional research instrumentation; absent in normal app jobs. */
  research?: { retain?: number; trace(event: { stage: string; level: number; candidateIds: string[]; scores?: Array<{ chunkId: string; score: number }>; retainedIds: string[]; payloadHash: string; existence?: number }): void };
}
export interface SearchOutput { hits: Hit[]; metrics: RunMetrics; existence?: number; existenceScope?: 'document' | 'finalists'; }
export interface EngineAdapter {
  engine: Engine;
  prepare(blocks: Block[], chunks: Chunk[], context: WorkContext): Promise<{ blocks?: Block[]; chunks?: Chunk[] }>;
  search(query: string, chunks: Chunk[], context: WorkContext): Promise<SearchOutput>;
  delete(documentId: string): Promise<void>;
}
