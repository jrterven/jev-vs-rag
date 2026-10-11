import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditFileSha256 } from '../ragas/audit.js';
import { sha256 } from '../util.js';

test('streamed audit hashes match byte hashing for empty, Unicode, binary and partial multi-chunk inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ragas-file-hash-'));
  try {
    const path = join(directory, 'input.bin');
    const binary = Buffer.alloc(2 * 1024 * 1024 + 19);
    for (let index = 0; index < binary.length; index++) binary[index] = index % 251;
    for (const bytes of [Buffer.alloc(0), Buffer.from('¿Dónde? 📚\u0000\r\n'), binary]) {
      writeFileSync(path, bytes);
      assert.equal(auditFileSha256(path), sha256(bytes));
      assert.deepEqual(readFileSync(path), bytes);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('streamed audit hash handles a sparse file above 2 GiB without whole-file allocation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ragas-large-file-hash-'));
  const path = join(directory, 'sparse.bin'), prefixBytes = 2 ** 31, tail = Buffer.from('audited-tail-📚');
  try {
    const fd = openSync(path, 'wx');
    try {
      ftruncateSync(fd, prefixBytes + tail.length);
      writeSync(fd, tail, 0, tail.length, prefixBytes);
    } finally { closeSync(fd); }
    assert.throws(() => readFileSync(path), { code: 'ERR_FS_FILE_TOO_LARGE' });
    const expected = createHash('sha256'), zeros = Buffer.alloc(1024 * 1024);
    for (let written = 0; written < prefixBytes; written += zeros.length) expected.update(zeros);
    expected.update(tail);
    assert.equal(auditFileSha256(path), expected.digest('hex'));
    assert.equal(statSync(path).size, prefixBytes + tail.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
