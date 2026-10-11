import { makeFreeze, textBlocks, canonicalText } from './datasets.js';
import { sha256 } from './util.js';
import type { DatasetBundle } from './types.js';
export function mockDataset(): DatasetBundle {
  const projectId = 'MOCK-fixture-only';
  const documents = [
    ['MOCK-astronomy', 'MOCK: astronomy', ['Telescopes', 'A reflecting telescope gathers light with a curved mirror. The mirror focuses starlight onto a detector. '.repeat(30), 'Mars', 'Mars has two small moons named Phobos and Deimos. '.repeat(30)]],
    ['MOCK-biology', 'MOCK: biology', ['Cells', 'Mitochondria produce ATP through cellular respiration. '.repeat(45), 'Plants', 'Photosynthesis uses light energy to convert water and carbon dioxide into sugars. '.repeat(45)]],
  ].map(([id, title, paragraphs]) => { const blocks = textBlocks(id as string, (paragraphs as string[]).map(text => ({ text }))); return { id: id as string, projectId, title: title as string, hash: sha256(canonicalText({ blocks })), version: 1, blockCount: blocks.length, blocks, sections: [] }; });
  const questions = documents.map((d, i) => ({ id: `MOCK-q${i}`, documentId: d.id, question: i ? 'What do mitochondria produce?' : 'What gathers light in a reflecting telescope?', answer: i ? 'ATP' : 'A curved mirror', evidenceSets: [[{ blockId: d.blocks[1].id, start: d.blocks[1].start, end: d.blocks[1].end, quote: d.blocks[1].text }]], unanswerable: false }));
  const freeze = makeFreeze(projectId, documents, [...questions, { id: 'MOCK-q-negative', documentId: documents[0].id, question: 'What is the factory serial number of this telescope?', answer: '', evidenceSets: [], unanswerable: true }]);
  freeze.createdAt = '2026-10-03T00:00:00Z';
  return { schemaVersion: 1, freeze, sources: documents.map(d => ({ documentId: d.id, corpus: 'mock-corpus', split: 'test', url: 'https://example.invalid/mock-fixture', license: 'CC0 synthetic test fixture; NOT research annotations', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', acquiredAt: '2026-10-03T00:00:00Z', rawSha256: d.hash, textSha256: d.hash })), provenance: { mock: true, warning: 'Synthetic fixture. Never use as study evidence or measured benchmark.' } };
}
