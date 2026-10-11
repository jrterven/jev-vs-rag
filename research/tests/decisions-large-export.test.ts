import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../util.js';
import { auditFileSha256 } from '../ragas/audit.js';

test('large-ledger exporter preserves every scientific statement of the pinned exporter', () => {
  const original = readFileSync('research/ragas/study-export.ts', 'utf8');
  assert.equal(sha256(original), '21307b8b50172c74271a61811dd4f491ef73a76583d3a6bbcc22c8d3f8f47c03');
  let extension = readFileSync('research/ragas/study-export-large.ts', 'utf8');
  extension = extension.replace(/import \{ auditFileSha256 \} from '\.\/audit\.js';\n\n\/\/ Operational clone:[\s\S]*?throw new Error\('Original scientific exporter changed\.'\);\n/, '');
  extension = extension.replace('ledgerSha256: auditFileSha256(options.ledger)', 'ledgerSha256: sha256(readFileSync(options.ledger))');
  extension = extension.replace("exporterSha256: sha256(readFileSync(new URL('./study-export-large.ts', import.meta.url))), originalExporterSha256, ledgerHashPolicy: 'SHA256 of exact bytes in bounded chunks; no sample or metric policy change',", "exporterSha256: sha256(readFileSync(new URL('./study-export.ts', import.meta.url))),");
  assert.equal(extension, original);
});

test('streamed ledger fingerprint equals direct SHA256 across chunk boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decisions-stream-hash-'));
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 53);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const path = join(dir, 'ledger.bin');
    writeFileSync(path, bytes);
    assert.equal(auditFileSha256(path), sha256(bytes));
  } finally { rmSync(dir, { recursive: true }); }
});
