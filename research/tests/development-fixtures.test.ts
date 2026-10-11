import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildDevelopmentValidation, makeDevelopmentStress, STABLE_TIMESTAMP } from '../development-validation.js';
import { canonicalText, makeFreeze, prepareDocument, QASPER_TRAIN_SHA, QASPER_TRAIN_URL, validateFreeze } from '../datasets.js';
import { mockDataset } from '../fixtures.js';
import { hashObject, sha256 } from '../util.js';

/** Fabricated portable test data with the expected provenance shape, never study evidence. */
function developmentFixture() {
  const bundle = mockDataset();
  bundle.provenance = { dataset: 'QASPER', version: '0.3', sourceUrl: QASPER_TRAIN_URL, unitTestFixture: true, warning: 'Synthetic in-memory fixture; not acquired QASPER or research annotations.' };
  bundle.sources = bundle.sources.map(s => ({ ...s, corpus: 'qasper-development', split: 'development', rawSha256: QASPER_TRAIN_SHA }));
  const question = bundle.freeze.questions[0], first = bundle.freeze.documents[0].blocks[1], last = bundle.freeze.documents[0].blocks[3];
  question.evidenceSets.push([first, last].map(block => ({ blockId: block.id, start: block.start + 2, end: block.start + 19, quote: block.text.slice(2, 19) })));
  question.annotation = { mode: 'single_annotator', annotatorIds: ['a'.repeat(20)], reviewedAt: STABLE_TIMESTAMP };
  bundle.freeze = makeFreeze(bundle.freeze.projectId, bundle.freeze.documents, bundle.freeze.questions);
  bundle.freeze.createdAt = STABLE_TIMESTAMP;
  return bundle;
}

function miniArchive(member: string, body: string): Buffer {
  const content = Buffer.from(body), header = Buffer.alloc(512);
  header.write(member, 0, 100, 'utf8');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((n, byte) => n + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]));
}

test('development builders reject nondevelopment and forged source hashes before consuming raw data', async () => {
  const source = developmentFixture();
  validateFreeze(source.freeze);
  const wrongSplit = structuredClone(source); wrongSplit.sources[0].split = 'test';
  assert.throws(() => buildDevelopmentValidation(new Uint8Array(), wrongSplit), /source split, corpus or train hash mismatch/);
  await assert.rejects(makeDevelopmentStress(wrongSplit, 26_000), /source split, corpus or train hash mismatch/);
  const wrongHash = structuredClone(source); wrongHash.sources[0].rawSha256 = '0'.repeat(64);
  assert.throws(() => buildDevelopmentValidation(new Uint8Array(), wrongHash), /source split, corpus or train hash mismatch/);
  await assert.rejects(makeDevelopmentStress(wrongHash, 26_000), /source split, corpus or train hash mismatch/);
  const wrongText = structuredClone(source); wrongText.sources[0].textSha256 = '0'.repeat(64);
  await assert.rejects(makeDevelopmentStress(wrongText, 26_000), /source split, corpus or train hash mismatch/);
});

test('negative selection verifies the pinned train JSON member hash before parsing its contents', () => {
  const archive = miniArchive('fixture/qasper-train-v0.3.json', 'intentionally invalid JSON, not the official source');
  assert.throws(() => buildDevelopmentValidation(archive, developmentFixture()), /QASPER train JSON SHA-256 mismatch/);
});

test('synthetic stress is deterministic and preserves all complete repeats and evidence offsets without inventing human annotation', async () => {
  const source = developmentFixture(), before = hashObject(source), parent = source.freeze.documents[0], original = source.freeze.questions[0];
  const first = await makeDevelopmentStress(source, 26_000), second = await makeDevelopmentStress(source, 26_000);
  assert.deepEqual(first, second); validateFreeze(first.freeze);
  assert.equal(hashObject(source), before, 'the original bundle remains unchanged');
  assert.equal(first.provenance.synthetic, true); assert.equal(first.provenance.technicalOnly, true);
  assert.equal(first.provenance.parentDatasetHash, source.freeze.hash);
  assert.equal(first.provenance.parentDocumentId, parent.id); assert.equal(first.provenance.parentDocumentHash, parent.hash);
  assert.equal(first.provenance.parentQuestionId, original.id);
  const doc = first.freeze.documents[0], text = canonicalText(doc), repeats = first.provenance.repeats as number;
  assert.equal(text, Array.from({ length: repeats }, () => canonicalText(parent)).join('\n\n'), 'no source text is truncated or replaced');
  assert.equal(doc.hash, sha256(text));
  const prepared = await prepareDocument(doc);
  assert.ok(prepared.tokenCount >= 26_000); assert.ok(prepared.chunks.length > 50);
  assert.equal(first.provenance.tokenCount, prepared.tokenCount); assert.equal(first.provenance.chunkCount, prepared.chunks.length);
  assert.equal(first.freeze.createdAt, STABLE_TIMESTAMP);
  for (const record of first.sources) {
    assert.equal(record.split, 'development'); assert.equal(record.corpus, 'synthetic-development-stress');
    assert.equal(record.rawSha256, QASPER_TRAIN_SHA); assert.equal(record.textSha256, doc.hash);
    assert.equal(record.acquiredAt, STABLE_TIMESTAMP);
  }
  const positive = first.freeze.questions.find(q => !q.unanswerable)!;
  assert.equal(positive.question, original.question); assert.equal(positive.answer, original.answer);
  assert.equal(positive.evidenceSets.length, repeats * original.evidenceSets.length);
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let alternative = 0; alternative < original.evidenceSets.length; alternative++) {
      const actualSet = positive.evidenceSets[repeat * original.evidenceSets.length + alternative];
      const originalSet = original.evidenceSets[alternative];
      assert.equal(actualSet.length, originalSet.length);
      for (let index = 0; index < actualSet.length; index++) {
        const span = actualSet[index], oldSpan = originalSet[index];
        const oldBlock = parent.blocks.find(b => b.id === oldSpan.blockId)!;
        const newBlock = doc.blocks[repeat * parent.blocks.length + oldBlock.index];
        assert.equal(span.blockId, newBlock.id);
        assert.equal(span.start, newBlock.start + oldSpan.start - oldBlock.start);
        assert.equal(span.end, newBlock.start + oldSpan.end - oldBlock.start);
        assert.equal(span.quote, oldSpan.quote); assert.equal(text.slice(span.start, span.end), span.quote);
      }
    }
  }
  assert.ok(first.freeze.questions.every(q => q.annotation === undefined), 'derived evidence never receives copied human reviewer claims');
  const negative = first.freeze.questions.find(q => q.unanswerable)!;
  assert.match(negative.question, /SYNTHETIC/); assert.deepEqual(negative.evidenceSets, []);
  assert.match(String(first.provenance.evidenceProvenance), /not new human annotations/);
});
