export type Engine = 'jev' | 'rag';
export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Progress { phase: string; current: number; total: number; }
export interface SourceRef { blockId: string; page?: number; paragraph: number; }
export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'code';
export interface Block { id: string; ordinal: number; text: string; start: number; end: number; page?: number; paragraph: number; kind?: BlockKind; level?: number; path?: string[]; }
export interface Chunk { id: string; ordinal: number; text: string; start: number; end: number; references: SourceRef[]; path: string[]; }
export interface CostSummary { knownUsd: string; unknownAttempts: number; inputTokens: number; calls: number; }
export interface Preparation { status: Status; progress: Progress; elapsedMs?: number; error?: string; model: string; }
export interface DocumentRecord {
  id: string; name: string; size: number; format: 'pdf' | 'docx' | 'txt'; createdAt: string;
  status: Status; error?: string; pageCount: number; blockCount: number; chunkCount: number; tokenCount: number;
  extractionMs?: number; extractionComplete: boolean; warnings?: string[]; engines: Record<Engine, Preparation>;
}
export interface Hit { chunkId: string; text: string; references: SourceRef[]; path: string[]; score: number; scoreKind: 'choice_probability' | 'cosine_similarity'; }
export interface RunMetrics { calls: number; inputTokens: number; windowsTotal: number; windowsCompleted: number; chunksTotal: number; chunksCovered: number; reductionLevels: number; concurrency: number; embeddingMs?: number; searchMs?: number; }
export interface EngineRun {
  id: string; engine: Engine; round: number; status: Status; model: string;
  startedAt?: string; finishedAt?: string; elapsedMs?: number; progress: Progress;
  hits: Hit[]; metrics: RunMetrics; cost: CostSummary; error?: string;
  existence?: number; existenceScope?: 'document' | 'finalists';
}
export interface Comparison { id: string; documentId: string; query: string; createdAt: string; rounds: number; status: Status; runs: EngineRun[]; }
export interface Job { id: string; documentId: string; kind: 'prepare' | 'search' | 'benchmark'; status: Status; createdAt: string; updatedAt: string; progress: Progress; comparisonId?: string; error?: string; }
export interface Attempt {
  id: string; documentId: string; jobId: string; runId?: string; engine: Engine;
  operation: 'structure' | 'document_embedding' | 'query_embedding' | 'window' | 'reduction';
  model: string; startedAt: string; finishedAt?: string; durationMs?: number;
  status: 'pending' | 'completed' | 'failed' | 'unknown'; inputTokens?: number; outputTokens?: number;
  rateUsdPerMillion: string | null; rateDate: string; rateSource: string; costUsd: string | null; error?: string;
}
export interface Projection { queries: number; totalUsd: string; amortizedUsd: string; }
export interface EngineCosts { preparation: CostSummary; searches: CostSummary; total: CostSummary; sampleSize: number; projections: Projection[]; }
export interface Rating { comparisonId: string; runId: string; chunkId: string; value: 'useful' | 'partial' | 'irrelevant'; }
export interface Overview { document: DocumentRecord; jobs: Job[]; comparisons: Comparison[]; costs: Record<Engine, EngineCosts>; ratings: Rating[]; }
export interface PublicConfig {
  keys: Record<Engine, boolean>; models: Record<Engine, string>;
  limits: { maxFileMb: number; maxTokens: number; maxPdfPages: number; };
  chunkTokens: number; overlapTokens: number; jevWindowTokens: number; concurrency: number;
  rates: Record<Engine, { usdPerMillion: string | null; date: string; source: string; }>;
}
