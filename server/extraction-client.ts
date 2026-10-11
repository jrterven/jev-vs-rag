import { Worker } from 'node:worker_threads';
import type { Block, Progress } from '../shared/types.js';
import type { RuntimeConfig } from './contracts.js';
import type { extractDocument, ExtractionResult } from './extraction.js';

type Message =
  | { type: 'progress'; progress: Progress }
  | { type: 'blocks'; blocks: Block[] }
  | { type: 'result'; result: ExtractionResult }
  | { type: 'error'; error: { name: string; message: string } };

// Explicit tsImport avoids inherited --import/--test flags and .ts worker loader
// differences between Node versions. The bootstrap itself is plain CommonJS.
const bootstrap = `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.loaderUrl)
    .then(({ tsImport }) => tsImport(workerData.entryUrl, workerData.parentUrl))
    .catch(error => {
      parentPort.postMessage({ type: 'error', error: { name: error.name || 'Error', message: error.message || String(error) } });
      parentPort.close();
    });
`;

/** CPU-heavy PDF parsing/tokenization never executes on the API event loop. */
export function extractInWorker(
  filePath: string,
  format: 'pdf' | 'docx' | 'txt',
  documentId: string,
  config: RuntimeConfig,
  callbacks: Parameters<typeof extractDocument>[4],
): Promise<ExtractionResult> {
  if (callbacks.signal.aborted) return Promise.reject(callbacks.signal.reason ?? new Error('Cancelado'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(bootstrap, {
      eval: true,
      execArgv: [],
      workerData: {
        filePath, format, documentId, config,
        loaderUrl: import.meta.resolve('tsx/esm/api'),
        entryUrl: new URL('./extraction-worker.ts', import.meta.url).href,
        parentUrl: import.meta.url,
      },
    });
    let settled = false;
    const finish = (error?: unknown, result?: ExtractionResult) => {
      if (settled) return;
      settled = true;
      callbacks.signal.removeEventListener('abort', cancel);
      worker.removeAllListeners('message');
      // Resolve/reject only after the worker has stopped, including on cancellation.
      void worker.terminate().then(() => {
        worker.removeAllListeners();
        if (error !== undefined) reject(error);
        else resolve(result!);
      }, terminationError => {
        worker.removeAllListeners();
        reject(error ?? terminationError);
      });
    };
    const cancel = () => finish(callbacks.signal.reason ?? new Error('Cancelado'));
    worker.on('message', (message: Message) => {
      if (settled) return;
      try {
        switch (message.type) {
          case 'progress': callbacks.onProgress(message.progress); break;
          case 'blocks': callbacks.onBlocks?.(message.blocks); break;
          case 'result': finish(undefined, message.result); break;
          case 'error': {
            const error = new Error(message.error.message);
            error.name = message.error.name;
            finish(error);
            break;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    worker.on('error', error => finish(error));
    worker.once('exit', code => finish(new Error(`La extracción se interrumpió (worker ${code}).`)));
    callbacks.signal.addEventListener('abort', cancel, { once: true });
    if (callbacks.signal.aborted) cancel();
  });
}
