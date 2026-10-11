import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Attempt, Block, Chunk, Comparison, DocumentRecord, Job, Rating } from '../shared/types.js';
type Row = { data: string };
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'app.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS blocks_doc ON blocks(document_id, ordinal);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id, ordinal);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, job_id TEXT NOT NULL, run_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_doc ON attempts(document_id);
      CREATE TABLE IF NOT EXISTS checkpoints(document_id TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(document_id,key));
      CREATE TABLE IF NOT EXISTS ratings(document_id TEXT NOT NULL, run_id TEXT NOT NULL, chunk_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,chunk_id));`);
  }
  private one<T>(table: string, id: string): T | undefined { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as Row | undefined; return row ? JSON.parse(row.data) as T : undefined; }
  private rows<T>(table: string, docId?: string): T[] { return (this.db.prepare(`SELECT data FROM ${table}${docId ? ' WHERE document_id=?' : ''}`).all(...(docId ? [docId] : [])) as Row[]).map(r => JSON.parse(r.data)); }
  private entity(table: string, value: { id: string; documentId: string }): void { this.db.prepare(`INSERT INTO ${table}(id,document_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,value.documentId,JSON.stringify(value)); }
  transaction(fn: () => void): void { this.db.exec('BEGIN'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  saveDocument(d: DocumentRecord): void { this.db.prepare('INSERT INTO documents(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(d.id,JSON.stringify(d)); }
  document(id: string): DocumentRecord | undefined { return this.one('documents',id); }
  documents(): DocumentRecord[] { return this.rows<DocumentRecord>('documents').sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  updateDocument(id: string, fn: (d: DocumentRecord) => void): DocumentRecord { const d = this.document(id); if (!d) throw new Error('Documento no encontrado.'); fn(d); this.saveDocument(d); return d; }
  saveBlocks(id: string, blocks: Block[]): void { const s = this.db.prepare('INSERT INTO blocks(id,document_id,ordinal,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'); this.transaction(() => { for (const b of blocks) s.run(b.id,id,b.ordinal,JSON.stringify(b)); }); }
  saveChunks(id: string, chunks: Chunk[]): void { const s = this.db.prepare('INSERT INTO chunks(id,document_id,ordinal,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'); this.transaction(() => { for (const c of chunks) s.run(c.id,id,c.ordinal,JSON.stringify(c)); }); }
  blocks(id: string, offset = 0, limit = 10000000): Block[] { return (this.db.prepare('SELECT data FROM blocks WHERE document_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(id,limit,offset) as Row[]).map(r => JSON.parse(r.data)); }
  chunks(id: string): Chunk[] { return this.rows<Chunk>('chunks',id).sort((a,b) => a.ordinal-b.ordinal); }
  chunk(id: string): Chunk | undefined { return this.one('chunks',id); }
  clearExtraction(id: string): void { this.transaction(() => { this.db.prepare('DELETE FROM blocks WHERE document_id=?').run(id); this.db.prepare('DELETE FROM chunks WHERE document_id=?').run(id); }); }
  saveJob(j: Job): void { this.entity('jobs',j); }
  job(id: string): Job | undefined { return this.one('jobs',id); }
  jobs(id?: string): Job[] { return this.rows<Job>('jobs',id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  updateJob(id: string, fn: (j: Job) => void): Job { const j=this.job(id); if(!j) throw new Error('Trabajo no encontrado.'); fn(j); j.updatedAt=new Date().toISOString(); this.saveJob(j); return j; }
  saveComparison(c: Comparison): void { this.entity('comparisons',c); }
  comparison(id: string): Comparison | undefined { return this.one('comparisons',id); }
  comparisons(id?: string): Comparison[] { return this.rows<Comparison>('comparisons',id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  updateComparison(id: string, fn: (c: Comparison) => void): Comparison { const c=this.comparison(id); if(!c) throw new Error('Consulta no encontrada.'); fn(c); this.saveComparison(c); return c; }
  startAttempt(a: Attempt): void { this.db.prepare('INSERT INTO attempts(id,document_id,job_id,run_id,data) VALUES(?,?,?,?,?)').run(a.id,a.documentId,a.jobId,a.runId ?? null,JSON.stringify(a)); }
  finishAttempt(id: string, patch: Partial<Attempt>): void { const a=this.one<Attempt>('attempts',id); if(!a) throw new Error('Intento no encontrado.'); this.db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify({...a,...patch,id}),id); }
  attempts(id?: string): Attempt[] { return this.rows<Attempt>('attempts',id); }
  checkpoint<T>(id: string,key: string,value: T): void { this.db.prepare('INSERT INTO checkpoints(document_id,key,data) VALUES(?,?,?) ON CONFLICT(document_id,key) DO UPDATE SET data=excluded.data').run(id,key,JSON.stringify(value)); }
  getCheckpoint<T>(id: string,key: string): T | undefined { const r=this.db.prepare('SELECT data FROM checkpoints WHERE document_id=? AND key=?').get(id,key) as Row | undefined; return r ? JSON.parse(r.data) : undefined; }
  saveRating(id: string,r: Rating): void { this.db.prepare('INSERT INTO ratings(document_id,run_id,chunk_id,data) VALUES(?,?,?,?) ON CONFLICT(run_id,chunk_id) DO UPDATE SET data=excluded.data').run(id,r.runId,r.chunkId,JSON.stringify(r)); }
  ratings(id: string): Rating[] { return this.rows('ratings',id); }
  removeDocument(id: string): void { this.transaction(() => { for(const t of ['blocks','chunks','jobs','comparisons','attempts','checkpoints','ratings']) this.db.prepare(`DELETE FROM ${t} WHERE document_id=?`).run(id); this.db.prepare('DELETE FROM documents WHERE id=?').run(id); }); }
  recoverInterrupted(): void {
    for(const a of this.attempts()) if(a.status==='pending') this.finishAttempt(a.id,{status:'unknown',error:'Interrumpido; consumo sin confirmar.',finishedAt:new Date().toISOString()});
    for(const job of this.jobs()) if(job.status==='running'||job.status==='queued') this.updateJob(job.id,j=>{j.status='interrupted';j.error='Servidor reiniciado.';});
    for(const comp of this.comparisons()) if(comp.status==='running'||comp.status==='queued') this.updateComparison(comp.id,c=>{c.status='interrupted'; for(const run of c.runs) if(run.status==='running'||run.status==='queued') {run.status='interrupted';run.error='Servidor reiniciado.';}});
    for(const doc of this.documents()) if(doc.status==='running'||doc.status==='queued') this.updateDocument(doc.id,d=>{d.status='interrupted';for(const p of Object.values(d.engines)) if(p.status==='running'||p.status==='queued') p.status='interrupted';});
  }
  close(): void { this.db.close(); }
}
