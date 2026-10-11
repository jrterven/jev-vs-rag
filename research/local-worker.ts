import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ResearchConfig } from './types.js';

export class LocalWorker {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  private counter = 0;
  private stderr = '';
  get pid() { return this.process.pid; }
  constructor(config: ResearchConfig) {
    this.process = spawn(config.local.python, ['-u', fileURLToPath(new URL('./python/worker.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4', CUBLAS_WORKSPACE_CONFIG: ':4096:8' } });
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    const reader = createInterface({ input: this.process.stdout });
    reader.on('line', line => {
      try { const message = JSON.parse(line) as { id: number; result?: unknown; error?: string; elapsedMs: number }, job = this.pending.get(message.id); if (!job) return; this.pending.delete(message.id); if (message.error) job.reject(new Error(message.error)); else job.resolve({ value: message.result, elapsedMs: message.elapsedMs }); }
      catch { this.fail(new Error('Invalid worker JSONL response.')); }
    });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', code => this.fail(new Error(`Local worker exited ${code}. ${this.stderr}`)));
  }
  private fail(error: Error) { for (const job of this.pending.values()) job.reject(error); this.pending.clear(); }
  async call<T>(operation: string, body: Record<string, unknown> = {}): Promise<{ value: T; elapsedMs: number }> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve: value => resolve(value as { value: T; elapsedMs: number }), reject }); this.process.stdin.write(JSON.stringify({ id, operation, ...body }) + '\n', error => { if (error) { this.pending.delete(id); reject(error); } }); });
  }
  close() { this.process.stdin.end(); this.process.kill('SIGTERM'); this.fail(new Error('Worker closed.')); }
}
