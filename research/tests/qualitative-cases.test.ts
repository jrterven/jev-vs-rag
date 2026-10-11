import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFreeze, textBlocks, canonicalText, prepareDocument } from '../datasets.js';
import { implementationSnapshot } from '../implementation.js';
import { CanonicalTokens, evaluateRetrieval } from '../metrics.js';
import { createManifest, loadConfig } from '../runner.js';
import { METHOD_IDS, type DatasetBundle, type FrozenQuestion, type QueryRun, type ResearchReport, type RetrievalMetrics } from '../types.js';
import { hashObject, sha256, writeJson } from '../util.js';
import { qualitySnapshot } from '../scripts/snapshot-halted-report.js';
import { semanticRetention } from '../scripts/study-readout.js';
import { qualitativeCases, selectContrasts, validateBaseRuns } from '../scripts/qualitative-cases.js';

type Scored = QueryRun & { metrics: RetrievalMetrics | null; generate: boolean };

// Synthetic fixture only, never an experiment result or research reference.
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qualitative-fixture-')), documentId = 'SYNTHETIC-book';
  const blocks = textBlocks(documentId, Array.from({ length: 6 }, (_, i) => ({ text: `word${i} ` + ('synthetic '.repeat(600)) })));
  const document = { id: documentId, projectId: 'SYNTHETIC', title: 'SYNTHETIC fixture, not research',
    hash: sha256(canonicalText({ blocks })), version: 1, blockCount: blocks.length, blocks, sections: [] };
  const questions: FrozenQuestion[] = ['a-positive', 'b-negative', 'c-tie'].map(id => ({ id, documentId,
    question: 'SYNTHETIC: which first word?', answer: 'word0', questionType: 'factual', unanswerable: false,
    evidenceSets: [[{ blockId: blocks[0].id, start: 0, end: 5, quote: 'word0' }]] }));
  const bundle: DatasetBundle = { schemaVersion: 1, freeze: makeFreeze('SYNTHETIC', [document], questions),
    sources: [{ documentId, corpus: 'openstax-books', split: 'development', url: 'https://example.invalid/synthetic',
      license: 'CC0 synthetic fixture', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', acquiredAt: '2026-10-04T00:00:00Z', rawSha256: document.hash, textSha256: document.hash }],
    provenance: { fixture: true, notStudyEvidence: true } };
  const config = loadConfig(); config.methods = [...METHOD_IDS]; config.generation.questions = 0;
  config.timing = { questions: 3, rounds: 2 }; config.bootstrapSamples = 100;
  const manifest = createManifest([bundle], config, { id: 'SYNTHETIC-qualitative', mock: true, phase: 'pilot' });
  manifest.kind = 'measured'; // Exercise measured-artifact gates using synthetic data, not paid calls.
  const prepared = await prepareDocument(document), tokens = new CanonicalTokens(prepared.text);
  assert(prepared.chunks.length > 5);
  const ids = prepared.chunks.map(c => c.id), first = ids[0], last = ids.at(-1)!;
  const runs: Scored[] = manifest.schedule.filter(row => row.round === 0).map(row => {
    const hit = row.questionId !== 'b-negative' ? row.method !== 'openai-dense' : row.method === 'openai-dense';
    const retained = [hit ? first : last];
    const traces = row.method === 'jev-scan' ? [
      { stage: 'window', level: 0, candidateIds: ids, retainedIds: retained, payloadHash: hashObject([row.id, 'window']) },
      { stage: 'final', level: 0, candidateIds: ids, retainedIds: retained, payloadHash: hashObject([row.id, 'final']) },
    ] : [{ stage: 'dense', candidateIds: ids, retainedIds: retained, payloadHash: hashObject([row.id, 'dense']) }];
    return { ...row, status: 'completed', startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:00:01Z', elapsedMs: 1000,
      phases: {}, traces, ranking: retained.map(chunkId => ({ chunkId, score: 0.9 })),
      metrics: evaluateRetrieval(tokens, prepared.chunks, retained.map(id => prepared.chunks.find(c => c.id === id)!), questions.find(q => q.id === row.questionId)!.evidenceSets) };
  });
  const report = { schemaVersion: 1, kind: 'measured', experimentId: manifest.id, datasetHash: manifest.datasetHash,
    implementationHash: manifest.implementationHash, configHash: manifest.configHash,
    perQuery: runs, methods: [], retention: [], missingScheduledRuns: manifest.schedule.length - runs.length } as ResearchReport & {
      experimentId: string; configHash: string; implementationHash: string; missingScheduledRuns: number; perQuery: Scored[] };
  const quality = await qualitySnapshot(report, [bundle], manifest), retention = runs.filter(row => row.method === 'jev-scan')
    .map(row => semanticRetention(row, prepared, questions.find(q => q.id === row.questionId)!)!);
  writeJson(join(dir, 'manifest.json'), manifest); writeJson(join(dir, 'datasets.json'), [bundle]);
  writeJson(join(dir, 'source-snapshot.json'), implementationSnapshot()); writeJson(join(dir, 'report.json'), report);
  writeJson(join(dir, 'primary-quality.json'), quality);
  const fileHash = (name: string) => sha256(readFileSync(join(dir, name)));
  const hashes = Object.fromEntries(['manifest.json', 'datasets.json', 'source-snapshot.json'].map(name => [name, fileHash(name)]));
  const stage = { schemaVersion: 1, kind: 'halted-study-snapshot', stage: 'halted-http402-primary-quality-complete',
    retrievalQualityComplete: true, timingComplete: false, ragasEligible: false, experimentId: manifest.id,
    datasetHash: manifest.datasetHash, implementationHash: manifest.implementationHash,
    primaryBase: { scheduled: runs.length, recorded: runs.length, completed: runs.length, failed: 0, interrupted: 0, remaining: 0 },
    allScheduled: { scheduled: manifest.schedule.length, recorded: runs.length, remaining: report.missingScheduledRuns },
    source: { hashes }, ledgerSnapshot: { sha256: 'a'.repeat(64) }, reportSha256: fileHash('report.json'),
    primaryQualitySha256: hashObject(quality), primaryQualityFileSha256: fileHash('primary-quality.json'),
    snapshotScriptSha256: sha256(readFileSync(new URL('../scripts/snapshot-halted-report.ts', import.meta.url))),
    qualityHelperSha256: sha256(readFileSync(new URL('../scripts/study-readout.ts', import.meta.url))) };
  const readout = { kind: 'measured-study-readout', experimentId: manifest.id, phase: manifest.phase,
    hashes: { report: fileHash('report.json'), datasets: fileHash('datasets.json'), manifest: fileHash('manifest.json'), ledgerSnapshot: stage.ledgerSnapshot.sha256 },
    protocol: { datasetHash: manifest.datasetHash, implementationHash: manifest.implementationHash },
    counts: { scheduled: manifest.schedule.length, recorded: runs.length, missing: report.missingScheduledRuns }, retentionPerQuery: retention };
  writeJson(join(dir, 'snapshot-stage.json'), stage); writeJson(join(dir, 'readout.json'), readout);
  return { dir, runs, questions, bundle, manifest, report, stage, readout, output: join(dir, 'cases.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('predeclared contrasts use exact sign and lexical ties; failures and later runs are ineligible', async () => {
  const f = await fixture();
  try {
    const result = selectContrasts(f.runs, f.questions);
    assert.deepEqual(result.selections.map(row => row.pair?.questionId), ['a-positive', 'b-negative']);
    assert.equal(result.eligible.length, 3);
    const failed = f.runs.map(run => run.questionId === 'a-positive' && run.method === 'jev-scan' ? { ...run, status: 'failed' as const } : run);
    assert.equal(selectContrasts([...failed, ...f.runs.map(run => ({ ...run, round: 1 }))], f.questions).selections[0].pair!.questionId, 'c-tie');
    const equal = f.runs.map(run => ({ ...run, metrics: { ...run.metrics!, coverage: 1 } }));
    assert.deepEqual(selectContrasts(equal, f.questions).selections.map(row => row.pair), [null, null]);
    assert.throws(() => selectContrasts([...f.runs, f.runs.find(row => row.method === 'jev-scan')!], f.questions), /Duplicate/);
  } finally { f.cleanup(); }
});

test('complete base quality allows genuinely missing later timing but never missing base or fabricated rows', async () => {
  const f = await fixture();
  try {
    assert.equal(validateBaseRuns(f.manifest, f.report).scheduled, 21);
    const absent = { ...f.report, perQuery: f.report.perQuery.slice(1), missingScheduledRuns: f.report.missingScheduledRuns + 1 };
    assert.throws(() => validateBaseRuns(f.manifest, absent), /base retrieval is incomplete/);
    const swapped = { ...f.report, perQuery: f.report.perQuery.map((run, i) => i ? run : { ...run, id: 'other' }) };
    assert.throws(() => validateBaseRuns(f.manifest, swapped), /unscheduled/);
  } finally { f.cleanup(); }
});

test('offline export preserves exact evidence/full text and semantic phases without reading a ledger', async () => {
  const f = await fixture(), fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('No API calls permitted'); }) as typeof fetch;
  try {
    const output = await qualitativeCases(f.dir, join(f.dir, 'readout.json'), f.output);
    assert.deepEqual(output.selectedQuestionIds, ['a-positive', 'b-negative']);
    const result = JSON.parse(readFileSync(f.output, 'utf8'));
    assert.equal(result.timingComplete, false); assert.equal(result.eligiblePairs, 3);
    assert.equal(result.cases[0].result.differenceJevMinusDense, 1);
    assert.equal(result.cases[1].result.differenceJevMinusDense, -1);
    for (const row of result.cases) {
      const q = f.questions.find(q => q.id === row.result.question.id)!;
      assert.deepEqual(row.result.question.evidenceSets, q.evidenceSets);
      assert.equal(row.result.question.question, q.question); assert.equal(row.result.question.answer, q.answer);
      for (const method of row.result.rankings) for (const passage of method.passages) {
        assert.equal(passage.text, canonicalText(f.bundle.freeze.documents[0]).slice(passage.start, passage.end));
        assert.equal(passage.textSha256, sha256(passage.text));
      }
      assert.equal(row.result.semanticRetention.phases.length, 4);
    }
    await assert.rejects(qualitativeCases(f.dir, join(f.dir, 'readout.json'), f.output), /Output must be new/);
  } finally { globalThis.fetch = fetchBefore; f.cleanup(); }
});

test('incomplete stage is rejected before trying to parse report data', async () => {
  const f = await fixture();
  try {
    writeJson(join(f.dir, 'snapshot-stage.json'), { ...f.stage, retrievalQualityComplete: false });
    writeFileSync(join(f.dir, 'report.json'), 'invalid report must not be read');
    await assert.rejects(qualitativeCases(f.dir, join(f.dir, 'readout.json'), f.output), /does not authorize/);
    assert.equal(existsSync(f.output), false);
  } finally { f.cleanup(); }
});

test('changed report, readout, quality artifact and semantic trace are rejected', async () => {
  for (const change of ['report', 'readout', 'quality', 'retention']) {
    const f = await fixture();
    try {
      if (change === 'report') writeJson(join(f.dir, 'report.json'), { ...f.report, experimentId: 'changed' });
      if (change === 'readout') writeJson(join(f.dir, 'readout.json'), { ...f.readout, hashes: { ...f.readout.hashes, report: 'b'.repeat(64) } });
      if (change === 'quality') writeJson(join(f.dir, 'primary-quality.json'), { altered: true });
      if (change === 'retention') {
        f.readout.retentionPerQuery[0].phases[0].coverage = 0;
        writeJson(join(f.dir, 'readout.json'), f.readout);
      }
      await assert.rejects(qualitativeCases(f.dir, join(f.dir, 'readout.json'), f.output), /hash mismatch|does not audit|artifact hash|Semantic retention differs/);
      assert.equal(existsSync(f.output), false);
    } finally { f.cleanup(); }
  }
});
