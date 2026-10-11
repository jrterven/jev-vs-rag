import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../util.js';
import { writeCompactJsonExclusive } from '../scripts/materialize-final-report.js';

test('streamed compact JSON equals ordinary JSON semantics with complete repeated traces and Unicode', () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-report-test-')), path = join(root, 'report.json');
  try {
    const trace = { stage: 'window', candidates: ['α', '😃', 'quoted "text"'], note: 'line\nnext', score: .123, missing: undefined };
    const value = { schemaVersion: 1, numbers: [NaN, Infinity, -Infinity, -0], sparse: [undefined, null],
      perQuery: Array.from({ length: 2500 }, (_, i) => ({ id: `fixture:${i}`, traces: [trace, { ...trace, candidateIds: Array.from({ length: 15 }, (_, n) => `${i}:${n}`) }] })) };
    const expected = JSON.stringify(value) + '\n', result = writeCompactJsonExclusive(path, value);
    assert.equal(readFileSync(path, 'utf8'), expected); assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(expected));
    assert.equal(result.sha256, sha256(expected)); assert.equal(result.bytes, Buffer.byteLength(expected));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).perQuery[2499].traces[1].candidateIds.length, 15);
    assert.deepEqual(readdirSync(root), ['report.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compact writer refuses replacement, over-limit output and unsupported values without publishing partial files', () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-report-test-')), path = join(root, 'report.json');
  try {
    writeCompactJsonExclusive(path, { unchanged: true });
    assert.throws(() => writeCompactJsonExclusive(path, { changed: true }), /already exists/);
    assert.equal(readFileSync(path, 'utf8'), '{"unchanged":true}\n');
    const oversized = join(root, 'too-large.json');
    assert.throws(() => writeCompactJsonExclusive(oversized, { preserved: 'x'.repeat(500) }, 100), /above.*consumer limit.*not.*truncated/);
    assert.equal(existsSync(oversized), false);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const value of [cyclic, { date: new Date() }, { x: BigInt(1) }]) {
      assert.throws(() => writeCompactJsonExclusive(join(root, 'bad.json'), value)); assert.equal(existsSync(join(root, 'bad.json')), false);
    }
    assert.deepEqual(readdirSync(root), ['report.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
