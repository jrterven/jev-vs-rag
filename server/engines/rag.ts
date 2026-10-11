import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import type { Block, Chunk } from '../../shared/types.js';
import type { EngineAdapter, RuntimeConfig, SearchOutput, WorkContext } from '../contracts.js';
import { emptyMetrics, EngineError, exhaustPacking, mapConcurrent, ProviderClient, tokenCount, yieldPacking } from './common.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const tablePrefix = (documentId: string) => `vec_${documentId.replace(/[^a-zA-Z0-9]/g, '_')}_`;
function* embeddingBatchSteps(chunks: Chunk[]): Generator<void, Chunk[][]> {
  const groups: Chunk[][] = []; let current: Chunk[] = []; let tokens = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const count = tokenCount(chunk.text);
    if (!count || count > 8191) throw new Error('Un fragmento está vacío o supera el límite del modelo de embeddings.');
    if (current.length && (current.length >= 64 || tokens + count > 300_000)) { groups.push(current); current = []; tokens = 0; }
    current.push(chunk); tokens += count;
    if ((index + 1) % 32 === 0) yield;
  }
  if (current.length) groups.push(current);
  return groups;
}
export const embeddingBatches = (chunks: Chunk[]): Chunk[][] => exhaustPacking(embeddingBatchSteps(chunks));
function parseEmbeddings(response: Record<string, unknown>, expected: number): number[][] {
  if (!Array.isArray(response.data) || response.data.length !== expected) throw new Error('OpenAI devolvió un lote de embeddings incompleto.');
  const vectors = new Array<number[]>(expected);
  for (const raw of response.data) {
    const item = raw as { index?: number; embedding?: number[] };
    if (!Number.isInteger(item.index) || item.index! < 0 || item.index! >= expected || vectors[item.index!] || !Array.isArray(item.embedding) || !item.embedding.length || item.embedding.some(value => !Number.isFinite(value))) throw new Error('OpenAI devolvió embeddings inválidos.');
    vectors[item.index!] = item.embedding;
  }
  if (vectors.some(v => v.length !== vectors[0].length)) throw new Error('OpenAI devolvió dimensiones de embedding inconsistentes.');
  return vectors;
}

export class RagEngine implements EngineAdapter {
  readonly engine = 'rag' as const;
  private client: ProviderClient;
  private connection?: Promise<Connection>;
  constructor(private config: RuntimeConfig, fetcher?: typeof fetch) { this.client = new ProviderClient('rag', config, fetcher); }
  private db(): Promise<Connection> { return this.connection ??= connect(join(this.config.dataDir, 'vectors')); }
  private name(documentId: string): string { return tablePrefix(documentId) + hash(JSON.stringify([this.config.embeddingModel, this.config.chunkTokens, this.config.overlapTokens])); }

  async prepare(_blocks: Block[], chunks: Chunk[], ctx: WorkContext) {
    ctx.signal.throwIfAborted();
    const connection = await this.db(); const name = this.name(ctx.documentId);
    let table: Table | undefined;
    const done = new Set<string>();
    if ((await connection.tableNames()).includes(name)) {
      table = await connection.openTable(name);
      const rows = await table.query().select(['id']).toArray();
      for (const row of rows) done.add(String(row.id));
    }
    let completed = chunks.filter(chunk => done.has(chunk.id)).length;
    const groups = await yieldPacking(embeddingBatchSteps(chunks.filter(chunk => !done.has(chunk.id))), ctx.signal);
    let writeTail: Promise<void> = Promise.resolve();
    ctx.progress({ phase: 'Generando embeddings', current: completed, total: chunks.length });
    await mapConcurrent(groups, this.config.concurrency, ctx.signal, async group => {
      const response = await this.client.request({ model: this.config.embeddingModel, input: group.map(chunk => chunk.text), encoding_format: 'float' }, 'document_embedding', ctx, true);
      const vectors = parseEmbeddings(response, group.length);
      const rows = group.map((chunk, index) => ({ id: chunk.id, vector: vectors[index] }));
      // Only writes are serialized. Independent provider calls stay concurrent.
      // Upserts + checking persisted IDs make the write/checkpoint crash gap safe.
      const write = writeTail.then(async () => {
        if (!table) table = await connection.createTable(name, rows);
        else await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
        ctx.checkpoint(`rag:embeddings:v1:${this.config.embeddingModel}:${hash(group.map(c => c.id).join('|'))}`, group.map(c => c.id));
        completed += group.length;
        ctx.progress({ phase: 'Generando embeddings', current: completed, total: chunks.length });
      });
      writeTail = write.catch(() => {});
      await write;
    });
    return {};
  }

  async search(query: string, chunks: Chunk[], ctx: WorkContext): Promise<SearchOutput> {
    const metrics = emptyMetrics(chunks.length, this.config.concurrency);
    try {
      if (!chunks.length) throw new Error('El documento no contiene fragmentos.');
      if (tokenCount(query) > 8191) throw new Error('La consulta supera el límite del modelo de embeddings.');
      const connection = await this.db(); const name = this.name(ctx.documentId);
      if (!(await connection.tableNames()).includes(name)) throw new Error('Falta preparar los embeddings de este documento.');
      ctx.progress({ phase: 'Embedding de consulta', current: 0, total: 1 });
      const embeddingStart = performance.now();
      const response = await this.client.request({ model: this.config.embeddingModel, input: [query], encoding_format: 'float' }, 'query_embedding', ctx, false, metrics);
      const [vector] = parseEmbeddings(response, 1);
      metrics.embeddingMs = performance.now() - embeddingStart;
      ctx.signal.throwIfAborted(); ctx.progress({ phase: 'Búsqueda vectorial', current: 0, total: 1 });
      const searchStart = performance.now();
      const table = await connection.openTable(name);
      // No vector index is created. bypassVectorIndex also preserves exact search if one is added externally.
      const rows = await table.vectorSearch(vector).distanceType('cosine').bypassVectorIndex().limit(5).toArray();
      metrics.searchMs = performance.now() - searchStart;
      const count = await table.countRows();
      metrics.windowsTotal = 1; metrics.windowsCompleted = count >= chunks.length ? 1 : 0;
      metrics.chunksCovered = Math.min(count, chunks.length);
      if (count !== chunks.length) throw new Error('El índice vectorial está incompleto. Reanuda la preparación.');
      const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
      const hits = rows.map(row => {
        const chunk = byId.get(String(row.id)); const distance = Number(row._distance);
        if (!chunk || !Number.isFinite(distance)) throw new Error('El índice contiene referencias inválidas. Reprocesa el documento.');
        return { chunkId: chunk.id, text: chunk.text, references: chunk.references, path: chunk.path, score: Math.max(-1, Math.min(1, 1 - distance)), scoreKind: 'cosine_similarity' as const };
      });
      ctx.progress({ phase: 'Completado', current: 1, total: 1 });
      return { hits, metrics };
    } catch (error) { throw new EngineError(error instanceof Error ? error.message : 'La búsqueda vectorial quedó incompleta.', metrics); }
  }

  async delete(documentId: string): Promise<void> {
    const connection = await this.db();
    for (const name of await connection.tableNames()) if (name.startsWith(tablePrefix(documentId))) await connection.dropTable(name);
  }
}
