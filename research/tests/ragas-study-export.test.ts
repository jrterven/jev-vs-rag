import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleModelGeneratedBooks, canonicalText, makeFreeze, prepareDocument, textBlocks } from '../datasets.js';
import { combineBundles, loadConfig } from '../runner.js';
import { planRetrievalContext } from '../context.js';
import { generationBody } from '../ragas/export.js';
import { exportStudyGenerations, referenceProvenance, studyMetricApplicability } from '../ragas/study-export.js';
import { hashObject, sha256, writeJson } from '../util.js';
import type { DatasetBundle, FrozenQuestion } from '../types.js';

async function fixture(scope: 'development' | 'test' = 'test') {
  const root = mkdtempSync(join(tmpdir(), 'ragas-study-export-')), directory = join(root, 'experiment'), ledger = join(root, 'backup.sqlite'), output = join(root, 'export');
  const config = loadConfig(), projectId = `project-${scope}`, experimentId = `experiment-${scope}`;
  const types = ['qasper', 'human', 'ai'] as const;
  const documents = types.map(kind => {
    const id = `${kind}-${scope}`, blocks = textBlocks(id, [{ text: `📚 Canonical support for ${kind} in Mexico.`, heading: 'Evidence' }]);
    return { id, projectId, title: id, hash: sha256(canonicalText({ blocks })), version: 1, blockCount: 1, sections: [{ blockIndex: 0, title: 'Evidence' }], blocks };
  });
  const questions: FrozenQuestion[] = documents.map((doc, i) => ({ id: `${doc.id}:q`, documentId: doc.id, question: 'Where?', answer: 'Mexico', unanswerable: false, evidenceSets: [[{ blockId: doc.blocks[0]!.id, start: 0, end: doc.blocks[0]!.end, quote: doc.blocks[0]!.text }]], ...(i === 1 ? { annotation: { mode: 'single_annotator' as const, annotatorIds: ['a'.repeat(20)], reviewedAt: '2026-10-05T01:00:00.000Z' } } : i === 2 ? { annotation: { mode: 'model_generated' as const, model: 'gpt-6-astra', reasoningEffort: 'ultra', authoringRunId: 'author', promptHash: sha256('protocol'), documentHash: doc.hash, sourceLockHash: sha256('lock'), generatedAt: '2026-10-05T01:00:00.000Z', humanReviewed: false as const, validation: { mode: 'model_self_check' as const, model: 'gpt-6-astra', reasoningEffort: 'ultra', promptHash: sha256('verify'), reportHash: sha256('report'), validatedAt: '2026-10-05T01:01:00.000Z', status: 'passed' as const } } } : {}) }));
  const bundle: DatasetBundle = { schemaVersion: 1, freeze: makeFreeze(projectId, documents, questions), sources: documents.map((doc, i) => ({ documentId: doc.id, corpus: i === 0 ? `qasper-${scope}` : scope === 'test' ? 'openstax-books' : 'openstax-development', split: scope, url: `https://example.test/${doc.id}`, license: 'Fixture', licenseUrl: 'https://example.test/license', acquiredAt: '2026-10-05T00:00:00.000Z', textSha256: doc.hash, rawSha256: sha256(doc.id), sourceLockHash: sha256('lock') })), provenance: {} };
  const combined = combineBundles([bundle]), sourceFiles = { 'frozen-generation-source.ts': 'Fixture historical source' }, implementationHash = hashObject(sourceFiles);
  const schedule = questions.map((q, i) => ({ id: `${experimentId}:${i}`, questionId: q.id, documentId: q.documentId, corpus: bundle.sources[i]!.corpus, method: 'bm25', round: 0, timingSample: false, generate: true }));
  const manifest = { schemaVersion: 1, id: experimentId, kind: 'measured', phase: scope === 'test' ? 'test' : 'pilot', datasetHash: combined.datasetHash, datasetHashes: [bundle.freeze.hash], config, configHash: hashObject(config), implementationHash, budgetPath: ledger, schedule, hardware: {} };
  const db = new DatabaseSync(ledger);
  db.exec('CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT,value TEXT); CREATE TABLE attempts(id TEXT PRIMARY KEY,logical_key TEXT,value TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,value TEXT)');
  const freeze = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO immutable VALUES(?,?,?)').run(key, hashObject(value), JSON.stringify(value));
  freeze(`experiment:${experimentId}`, manifest);
  const perQuery: any[] = [];
  for (const [i, scheduled] of schedule.entries()) {
    const doc = await prepareDocument(documents[i]!), q = questions[i]!, ranking = [{ chunkId: doc.chunks[0]!.id, score: 1 }], plan = planRetrievalContext(doc, ranking);
    const generation = { text: 'Mexico', abstained: false, citations: [{ label: 'C1', spans: plan.contexts[0]!.spans }], elapsedMs: 1, contextManifest: plan.manifest };
    const run = { ...scheduled, status: 'completed', startedAt: '2026-10-05T02:00:00.000Z', finishedAt: '2026-10-05T02:00:01.000Z', elapsedMs: 1, ranking, phases: { bm25: 1 }, traces: [] };
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run));
    const payloadHash = hashObject(generationBody(q, plan.contexts, 'bm25', config)), attempt = { id: `attempt-${i}`, logicalKey: `${run.id}:generation:${payloadHash}`, runId: run.id, documentId: doc.id, method: run.method, operation: 'generation', status: 'completed', model: config.models.generation, reportedModel: config.models.generation, payloadHash, costUsd: '.001' };
    db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, attempt.logicalKey, JSON.stringify(attempt));
    freeze(`${run.id}:generation-context`, plan.manifest); freeze(`${run.id}:generation-result`, { generation });
    perQuery.push({ ...run, generation });
  }
  db.close();
  const report = { datasetHash: manifest.datasetHash, configHash: manifest.configHash, implementationHash, perQuery };
  writeJson(join(directory, 'manifest.json'), manifest); writeJson(join(directory, 'datasets.json'), [bundle]); writeJson(join(directory, 'report.json'), report); writeJson(join(directory, 'source-snapshot.json'), { hash: implementationHash, files: sourceFiles });
  const options = { ledger, output, cohorts: [{ name: 'main', directory }], scope };
  const mutate = (fn: (db: DatabaseSync) => void) => { const writable = new DatabaseSync(ledger); try { fn(writable); } finally { writable.close(); } };
  return { root, ledger, output, directory, options, bundle, manifest, report, mutate, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('held-out export requires explicit test scope and retains unchanged human/model references separately', async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportStudyGenerations({ ...f.options, scope: undefined }), /development experiments/);
    const hash = sha256(readFileSync(f.ledger)), result = await exportStudyGenerations(f.options);
    assert.equal(result.samples, 3); assert.equal(result.metricRequests, 6); assert.deepEqual(result.byReferenceKind, { human_qasper: 1, human_book: 1, model_generated_book: 1 });
    const rows = readFileSync(join(f.output, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.every(row => row.metadata.split === 'test' && row.metrics.join(',') === 'faithfulness,answer_accuracy' && row.reference === 'Mexico'));
    const ai = rows.find(row => row.metadata.referenceKind === 'model_generated_book');
    assert.equal(ai.metadata.referencePolicy, 'frozen-model-generated-book-answer'); assert.equal(ai.metadata.referenceAnnotation.humanReviewed, false);
    assert.equal(ai.metadata.referenceAnnotation.model, 'gpt-6-astra'); assert.ok(ai.contexts[0].includes('📚'));
    assert.equal(new Set(rows.map(row => row.metadata.cohort)).size, 2, 'QASPER and books cannot be pooled by the default analyzer cohort');
    assert.deepEqual(await exportStudyGenerations(f.options), result); assert.equal(sha256(readFileSync(f.ledger)), hash);
  } finally { f.cleanup(); }
});

test('combined development scope is the default and rejects test sources even in a pilot-labeled manifest', async () => {
  const f = await fixture('development');
  try {
    assert.equal((await exportStudyGenerations({ ...f.options, scope: undefined })).samples, 3);
    f.bundle.sources[0]!.split = 'test'; writeJson(join(f.directory, 'datasets.json'), [f.bundle]);
    await assert.rejects(exportStudyGenerations({ ...f.options, output: join(f.root, 'other') }), /Corpus\/split mismatch/);
  } finally { f.cleanup(); }
});

test('retrieval snapshots are rejected by either stage guard before any ledger access or export', async () => {
  const f = await fixture(), before = sha256(readFileSync(f.ledger));
  try {
    for (const marker of [
      { ragasEligible: false },
      { stage: 'retrieval-complete-generation-incomplete' },
      { ragasEligible: true, stage: 'retrieval-complete-generation-incomplete' },
    ]) {
      writeJson(join(f.directory, 'snapshot-stage.json'), marker);
      // Even a later cohort must fail in preflight, before an earlier cohort or
      // the deliberately absent ledger can be read or any output is published.
      const absentLedger = join(f.root, 'must-not-open.sqlite');
      await assert.rejects(exportStudyGenerations({ ...f.options, ledger: absentLedger,
        cohorts: [{ name: 'earlier', directory: join(f.root, 'earlier') }, ...f.options.cohorts] }), /Snapshot is not eligible for RAGAS/);
      assert.equal(existsSync(absentLedger), false);
      assert.equal(existsSync(f.output), false);
    }
    assert.equal(sha256(readFileSync(f.ledger)), before);
  } finally { f.cleanup(); }
});

test('Faithfulness/AnswerAccuracy record NA explicitly without turning abstentions, negatives or closed-book into zeros', () => {
  const q: FrozenQuestion = { id: 'q', documentId: 'd', question: 'Where?', answer: 'Mexico', evidenceSets: [], unanswerable: false };
  const generation = { text: 'I cannot answer.', abstained: true, citations: [], elapsedMs: 1 }, contexts = [{ label: 'C1', text: 'Evidence', spans: [] }];
  assert.deepEqual(studyMetricApplicability(q, generation, contexts, 'bm25'), { metrics: ['answer_accuracy'], notApplicable: { faithfulness: 'explicit_abstention' } });
  assert.deepEqual(studyMetricApplicability({ ...q, unanswerable: true }, generation, [], 'oracle').metrics, []);
  assert.equal(studyMetricApplicability(q, { ...generation, abstained: false }, [], 'closed-book').notApplicable.faithfulness, 'closed_book_no_supplied_evidence');
  assert.equal(studyMetricApplicability(q, { ...generation, text: '' }, contexts, 'bm25').notApplicable.answer_accuracy, 'empty_response');
});

test('modified historical context, attempt hash, source snapshot and immutable response are rejected before export', async () => {
  for (const mode of ['context', 'payload', 'snapshot', 'immutable'] as const) {
    const f = await fixture();
    try {
      if (mode === 'context') { f.report.perQuery[0].ranking = []; writeJson(join(f.directory, 'report.json'), f.report); }
      if (mode === 'payload') f.mutate(db => { const row = db.prepare('SELECT value FROM attempts WHERE id=?').get('attempt-0')!; const value = JSON.parse(String(row.value)); value.payloadHash = '0'.repeat(64); db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(value), 'attempt-0'); });
      if (mode === 'snapshot') writeJson(join(f.directory, 'source-snapshot.json'), { hash: f.manifest.implementationHash, files: { changed: 'not historical' } });
      if (mode === 'immutable') f.mutate(db => db.prepare('UPDATE immutable SET hash=? WHERE key=?').run('0'.repeat(64), `${f.manifest.schedule[0]!.id}:generation-result`));
      await assert.rejects(exportStudyGenerations(f.options), /Historical retrieval|historical generation attempt|snapshot hash|record hash/);
    } finally { f.cleanup(); }
  }
});

test('missing scheduled generations remain explicit, while model references cannot masquerade as QASPER human answers', async () => {
  const f = await fixture();
  try {
    const q = f.bundle.freeze.questions[2]!;
    assert.throws(() => referenceProvenance(q, f.bundle.sources[0]!), /cannot be labeled as human QASPER/);
    assert.throws(() => referenceProvenance(q, { ...f.bundle.sources[2]!, corpus: 'synthetic-development-stress' }), /synthetic stress/);
    delete f.report.perQuery[0].generation; f.report.perQuery[0].generationError = 'Provider unavailable';
    f.mutate(db => db.prepare('DELETE FROM immutable WHERE key=?').run(`${f.manifest.schedule[0]!.id}:generation-result`));
    writeJson(join(f.directory, 'report.json'), f.report);
    const result = await exportStudyGenerations(f.options); assert.equal(result.missing, 1); assert.equal(result.samples, 2);
    const exported = JSON.parse(readFileSync(join(f.output, 'export-manifest.json'), 'utf8')); assert.equal(exported.missing[0].reason, 'Provider unavailable');
    assert.equal(exported.missing[0].questionId, f.bundle.freeze.questions[0]!.id);
    assert.equal(exported.missing[0].unanswerable, false); assert.equal(exported.missing[0].split, 'test');
  } finally { f.cleanup(); }
});

test('offline Python study analysis accepts exact TS exporter hashes and preserves corpus and mixed reference provenance', async () => {
  const f = await fixture();
  try {
    await exportStudyGenerations(f.options);
    const samplePath = join(f.output, 'samples.jsonl'), resultPath = join(f.output, 'fixture-results.jsonl'), runtimePath = join(f.output, 'fixture-runtime.json'), analysisPath = join(f.output, 'fixture-analysis.json');
    const samples = readFileSync(samplePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const results = samples.flatMap(row => row.metrics.map((metric: string) => ({ sampleId: row.id, metric, status: 'completed', score: 1, metadata: row.metadata, calls: [{ requestId: `ragas:${sha256(JSON.stringify(['fixture-judge', row.id, metric, 1]))}`, attemptId: `${row.id}:${metric}`, model: 'gpt-6.1-sol', status: 'completed' }] })));
    writeFileSync(resultPath, results.map(result => JSON.stringify(result)).join('\n') + '\n');
    writeJson(runtimePath, { runId: 'fixture-judge', judgeModel: 'gpt-6.1-sol', ragasVersion: '0.4.3', retries: 0, metricConfig: { faithfulness: {}, answer_accuracy: { max_retries: 1 } }, inputSha256: sha256(readFileSync(samplePath)), runtimeSha256: sha256('fixture runtime') });
    const process = spawnSync('python3', ['research/ragas/study-analysis.py', '--samples', samplePath, '--results', resultPath, '--export-manifest', join(f.output, 'export-manifest.json'), '--runtime-manifest', runtimePath, '--scope', 'test', '--out', analysisPath], { encoding: 'utf8' });
    assert.equal(process.status, 0, process.stderr);
    const analysis = JSON.parse(readFileSync(analysisPath, 'utf8'));
    assert.equal(analysis.accounting.completed, 6); assert.equal(analysis.groups.length, 4);
    assert.equal(analysis.provenance.retrievalReportSha256, sha256(readFileSync(join(f.directory, 'report.json'))));
    assert.deepEqual(analysis.referenceCounts.map((row: any) => row.referenceKind).sort(), ['human_book', 'human_qasper', 'model_generated_book']);
    assert.equal(analysis.integrity.runtimeInputHashVerified, true); assert.equal(analysis.integrity.runtimeSourceVerified, false);
  } finally { f.cleanup(); }
});
