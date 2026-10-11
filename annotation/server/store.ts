import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

/** All writes are synchronous; transactions cannot interleave across HTTP requests. */
export class AnnotationStore {
  readonly db: DatabaseSync;
  readonly filename: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filename = path.join(dataDir, 'annotation.sqlite');
    this.db = new DatabaseSync(this.filename);
    chmodSync(this.filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  all<T>(kind: string): T[] {
    return (this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as Array<{value: string}>).map(row => JSON.parse(row.value) as T);
  }
  put(kind: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, JSON.stringify(value));
  }
  insert(kind: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run(kind, id, JSON.stringify(value));
  }
  remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
