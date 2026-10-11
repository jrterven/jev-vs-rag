import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from './extraction.js';
import type { RuntimeConfig } from './contracts.js';

export interface ExtractionWorkerInput {
  filePath: string;
  format: 'pdf' | 'docx' | 'txt';
  documentId: string;
  config: RuntimeConfig;
}

const port = parentPort;
if (!port) throw new Error('La extracción requiere un worker.');
const input = workerData as ExtractionWorkerInput;

try {
  const result = await extractDocument(input.filePath, input.format, input.documentId, input.config, {
    signal: new AbortController().signal,
    onProgress: progress => port.postMessage({ type: 'progress', progress }),
    onBlocks: blocks => port.postMessage({ type: 'blocks', blocks }),
  });
  port.postMessage({ type: 'result', result });
} catch (error) {
  port.postMessage({ type: 'error', error: {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  } });
} finally {
  port.close();
}
