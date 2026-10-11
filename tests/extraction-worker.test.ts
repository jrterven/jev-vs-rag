import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { extractInWorker } from '../server/extraction-client.js';
import type { RuntimeConfig } from '../server/contracts.js';

const directory = await mkdtemp(join(tmpdir(), 'jev-worker-'));
after(() => rm(directory, { recursive: true, force: true }));
const config: RuntimeConfig = {
  dataDir: directory, port: 3001, typesafeApiKey: '', openaiApiKey: '', jevModel: 'jev-1.13.0',
  embeddingModel: 'text-embedding-3-small', jevBaseUrl: '', openaiBaseUrl: '',
  maxFileMb: 100, maxTokens: 1_000_000, maxPdfPages: 2_000, chunkTokens: 500, overlapTokens: 75,
  jevWindowTokens: 12_000, concurrency: 2, requestTimeoutMs: 60_000,
  jevRate: '0.042', embeddingRate: '0.02', rateDate: '2026-10-02',
};

test('worker procesa un libro manteniendo disponible el event loop y transmite avances', async () => {
  const file = join(directory, 'book.txt');
  const paragraphs = Array.from({ length: 600 }, (_, index) => `Párrafo ${index + 1}. ${'Las estrellas iluminan el cielo durante toda la noche. '.repeat(15)}`);
  await writeFile(file, paragraphs.join('\n\n'));
  let ticks = 0;
  let persisted = 0;
  let ticksAtCountStart = 0;
  let countTicks = 0;
  const phases = new Set<string>();
  const ticker = setInterval(() => ticks++, 10);
  try {
    const result = await extractInWorker(file, 'txt', 'worker-book', config, {
      signal: new AbortController().signal,
      onBlocks: blocks => { persisted += blocks.length; },
      onProgress: progress => {
        phases.add(progress.phase);
        if (progress.phase === 'Contando tokens') {
          if (progress.current === 0) ticksAtCountStart = ticks;
          else countTicks = ticks - ticksAtCountStart;
        }
      },
    });
    assert.equal(result.blocks.length, 600);
    assert.equal(persisted, 600);
    assert.ok(result.tokenCount > 90_000);
    assert.ok(result.chunks.at(-1)?.text.includes('Párrafo 600'));
    assert.ok(phases.has('Fragmentando'));
    assert.ok(countTicks > 0, 'El event loop debe seguir atendiendo timers durante el conteo síncrono de tokens.');
    assert.ok(ticks >= 10);
  } finally {
    clearInterval(ticker);
  }
});

test('cancelación detiene el worker durante tokenización y no entrega eventos posteriores', async () => {
  const file = join(directory, 'cancel.txt');
  await writeFile(file, 'Contenido para cancelar durante conteo de tokens. '.repeat(30_000));
  const controller = new AbortController();
  let messages = 0;
  await assert.rejects(extractInWorker(file, 'txt', 'cancel', config, {
    signal: controller.signal,
    onProgress: progress => {
      messages++;
      if (progress.phase === 'Contando tokens' && progress.current === 0) controller.abort(new Error('Cancelado por usuario'));
    },
    onBlocks: () => { messages++; },
  }), /Cancelado por usuario/);
  const messagesAtStop = messages;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(messages, messagesAtStop);
});

test('worker propaga errores de extracción, cancelación previa y errores de persistencia', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Cancelación previa'));
  await assert.rejects(extractInWorker('not-used', 'txt', 'cancelled', config, { signal: controller.signal, onProgress: () => {} }), /Cancelación previa/);
  const file = join(directory, 'empty.txt');
  await writeFile(file, '');
  await assert.rejects(extractInWorker(file, 'txt', 'empty', config, { signal: new AbortController().signal, onProgress: () => {} }), /no contiene texto/);
  await writeFile(file, 'Un párrafo para persistir.');
  await assert.rejects(extractInWorker(file, 'txt', 'persist', config, {
    signal: new AbortController().signal, onProgress: () => {}, onBlocks: () => { throw new Error('Disco lleno'); },
  }), /Disco lleno/);
});
