import type { FrozenDataset, FrozenQuestion, EvidenceSpan, TextBlock } from '../annotation/shared/types.js';
import type { Chunk } from '../shared/types.js';
export type { FrozenDataset, FrozenQuestion, EvidenceSpan };
export const METHOD_IDS = ['bm25', 'openai-dense', 'bge-m3', 'hybrid', 'hybrid-bge', 'hybrid-jev', 'jev-scan'] as const;
export type MethodId = typeof METHOD_IDS[number];
export type RunMethod = MethodId | 'closed-book' | 'oracle';
export const METHOD_LABELS: Record<MethodId, string> = { bm25: 'BM25', 'openai-dense': 'OpenAI dense', 'bge-m3': 'BGE-M3 dense', hybrid: 'BM25 + BGE-M3 RRF', 'hybrid-bge': 'Hybrid + BGE reranker', 'hybrid-jev': 'Hybrid + Jev', 'jev-scan': 'Jev full scan' };
export interface SourceRecord { documentId: string; corpus: string; split: 'development' | 'test'; url: string; license: string; licenseUrl: string; acquiredAt: string; rawSha256: string; textSha256: string; sourceLockHash?: string; }
export interface DatasetBundle { schemaVersion: 1; freeze: FrozenDataset; sources: SourceRecord[]; provenance: Record<string, unknown>; }
export interface ResearchConfig {
  structure?: boolean; chunkOrderSeed?: number;
  schemaVersion: 1; seed: number; methods: MethodId[]; chunkTokens: number; overlapTokens: number; topK: number;
  hybridDepth: number; rrfK: number; jevWindowTokens: number; jevRetain: number; concurrency: number;
  requestTimeoutMs: number;
  maxBudgetUsd: string; maxDocumentTokens: number; bootstrapSamples: number;
  models: { jev: string; openaiEmbedding: string; bge: string; bgeRevision: string; reranker: string; rerankerRevision: string; generation: string; };
  rates: { jevInput: string; embeddingInput: string; generationInput: string; generationCachedInput: string; generationOutput: string; date: string; };
  local: { python: string; device: string; batchSize: number; precision: 'fp32' | 'fp16'; modelCacheDir?: string; };
  timing: { questions: number; rounds: number; }; generation: { questions: number; maxOutputTokens: number; };
}
export interface RankedChunk { chunkId: string; score: number; }
export interface StageTrace { stage: string; level?: number; candidateIds: string[]; scores?: RankedChunk[]; retainedIds: string[]; payloadHash: string; elapsedMs?: number; existence?: number; }
export interface RetrievalResult { ranking: RankedChunk[]; phases: Record<string, number>; traces: StageTrace[]; existence?: number; }
export interface GenerationContextManifest {
  policy: 'ranked-complete-deduplicated-v1' | 'complete-gold-or-ineligible-v1' | 'closed-book-v1';
  selectedChunkIds: string[];
  omittedChunkIds: string[];
  contentTokens: number;
  budget: number;
}
export interface QueryRun extends RetrievalResult {
  id: string; questionId: string; documentId: string; corpus: string; method: RunMethod; round: number;
  status: 'completed' | 'failed' | 'interrupted'; startedAt: string; finishedAt: string; elapsedMs: number; error?: string;
  resumed?: boolean; timingValid?: boolean;
  timingSample?: boolean; generationError?: string;
  // Legacy frozen results lack contextManifest; every newly generated result records it.
  generation?: { text: string; citations: Array<{ label: string; spans: EvidenceSpan[] }>; abstained: boolean; elapsedMs: number; contextManifest?: GenerationContextManifest; };
}
export interface PreparedDocument { id: string; text: string; chunks: Chunk[]; tokenCount: number; blocks: TextBlock[]; }
export interface RetrievalMetrics { coverage: number; precision: number; completeGold: boolean; oracleCoverage: number; normalizedCoverage: number; hit: boolean; goldTokens: number; retrievedTokens: number; oracleExact: true; }
export interface MethodReport {
  id: MethodId; label: string; corpus: string; coverage: number | null; coverageLow?: number; coverageHigh?: number;
  latencyP50Ms: number | null; latencyP95Ms?: number; preparationUsd: string; queryMeanUsd: string;
  unknownCostAttempts: number; nQueries: number; nAnswerable: number; failures: number; completeGold?: number;
  nTimingRuns: number; timingFailures: number;
  oracleCoverage?: number; normalizedCoverage?: number; tokenPrecision?: number; projections?: Array<{ queries: number; totalUsd: string; amortizedUsd: string }>;
}
export interface ResearchReport { schemaVersion: 1; kind: 'measured' | 'mock'; datasetHash: string; methods: MethodReport[]; retention: Array<{ method: MethodId; corpus: string; stage: number; coverage: number; nQueries: number }>; [key: string]: unknown; }
