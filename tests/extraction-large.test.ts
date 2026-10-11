import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractInWorker } from '../server/extraction-client.js';
import type { RuntimeConfig } from '../server/contracts.js';

test('libro cercano al límite de un millón de tokens conserva todo el texto', {
  skip: process.env.RUN_LARGE_TESTS !== '1',
  timeout: 600_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-large-book-'));
  const terminalMarker = 'END_OF_BOOK_FINAL_VERIFICATION_MARKER';
  const source = Array.from({ length: 1_000 }, (_, index) => `Chapter ${index + 1}:${' galaxy'.repeat(940)}`).join('\n\n')
    + `\n${terminalMarker}`;
  const config: RuntimeConfig = {
    dataDir: directory, port: 3001, typesafeApiKey: '', openaiApiKey: '', jevModel: 'jev-1.13.0',
    embeddingModel: 'text-embedding-3-small', jevBaseUrl: '', openaiBaseUrl: '',
    maxFileMb: 100, maxTokens: 1_000_000, maxPdfPages: 2_000, chunkTokens: 500, overlapTokens: 75,
    jevWindowTokens: 12_000, concurrency: 2, requestTimeoutMs: 60_000,
    jevRate: '0.042', embeddingRate: '0.02', rateDate: '2026-10-02',
  };
  let persisted = 0;
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 25);
  try {
    const file = join(directory, 'large-book.txt');
    await writeFile(file, source);
    const startedAt = performance.now();
    const result = await extractInWorker(file, 'txt', 'large-verification', config, {
      signal: new AbortController().signal,
      onProgress: () => {},
      onBlocks: blocks => { persisted += blocks.length; },
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    assert.ok(result.tokenCount >= 900_000 && result.tokenCount <= 1_000_000);
    assert.equal(result.blocks.length, 1_000);
    assert.equal(persisted, 1_000);
    assert.equal(result.blocks.map(block => block.text).join('\n\n'), source);
    assert.equal(result.chunks[0].start, 0);
    assert.equal(result.chunks.at(-1)?.end, source.length);
    assert.ok(result.chunks.at(-1)?.text.endsWith(terminalMarker));
    let coveredUntil = 0;
    for (const [index, chunk] of result.chunks.entries()) {
      assert.equal(chunk.ordinal, index);
      assert.ok(chunk.start <= coveredUntil, `Hueco antes del fragmento ${index}.`);
      assert.ok(chunk.end > coveredUntil, `Fragmento ${index} sin avance.`);
      assert.equal(chunk.text, source.slice(chunk.start, chunk.end));
      assert.ok(chunk.references.length > 0);
      coveredUntil = chunk.end;
    }
    assert.equal(coveredUntil, source.length);
    assert.ok(ticks >= 100, 'El proceso principal continúa atendiendo timers.');
    console.info(JSON.stringify({ largeBookVerification: { elapsedMs, tokens: result.tokenCount, chunks: result.chunks.length, paragraphs: result.blocks.length, sourceBytes: Buffer.byteLength(source), eventLoopTicks: ticks } }));
  } finally {
    clearInterval(ticker);
    await rm(directory, { recursive: true, force: true });
  }
});
