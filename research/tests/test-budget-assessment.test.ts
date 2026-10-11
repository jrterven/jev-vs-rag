import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import { countTokens } from '../../server/extraction.js';
import { makeFreeze, textBlocks } from '../datasets.js';
import { forecastStudy } from '../forecast.js';
import { createManifest, loadConfig } from '../runner.js';
import { Ledger, type PaidAttempt } from '../ledger.js';
import { hashObject, sha256 } from '../util.js';
import type { DatasetBundle, QueryRun } from '../types.js';
import { assessForecast, KNOWN_EXCEPTION, ReadonlyStudyLedger, type Amendment } from '../scripts/assess-test-budget.js';

// Synthetic unit fixtures only. No APIs, retrieved text, or quality scores are used.
function bundle(id: string, questionId: string, corpus: string, split: 'development' | 'test'): DatasetBundle {
  const text = 'alpha beta gamma '.repeat(30), blocks = textBlocks(id, [{ text }]);
  const document = { id, projectId: id, title: id, hash: sha256(text + id), version: 1, blockCount: 1, sections: [], blocks };
  // The content itself must differ across development/test to satisfy frozen-source checks.
  blocks[0]!.text += id; blocks[0]!.end += id.length; document.hash = sha256(blocks[0]!.text);
  const question = { id: questionId, documentId: id, question: `Unit fixture ${questionId}`, answer: 'alpha', evidenceSets: [[{ blockId: blocks[0]!.id, start: 0, end: 5, quote: 'alpha' }]] };
  return { schemaVersion: 1, freeze: makeFreeze(id, [document], [question]), sources: [{ documentId: id, corpus, split, url: `https://example.test/${id}`, license: 'fixture', licenseUrl: 'https://example.test/license', acquiredAt: '2026-10-05', rawSha256: document.hash, textSha256: document.hash }], provenance: { fixture: true } };
}

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'supplemental-budget-')), ledgerPath = path.join(dir, 'budget.sqlite');
  const ledger = new Ledger(ledgerPath);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = loadConfig(); config.timing = { questions: 0, rounds: 1 }; config.generation.questions = 3;
  const pilotBundles = [bundle(KNOWN_EXCEPTION.documentId, KNOWN_EXCEPTION.questionId, 'qasper-development', 'development'), bundle('qasper:other-dev', 'other-dev-q', 'qasper-development', 'development'), bundle('pilot-book', 'pilot-book-q', 'books-development', 'development')];
  const pilot = createManifest(pilotBundles, config, { id: KNOWN_EXCEPTION.pilotExperimentId, mock: false, phase: 'pilot', budgetPath: ledgerPath });
  ledger.freeze(`experiment:${pilot.id}`, pilot);
  function paid(runId: string, documentId: string, method: string, operation: string, cost = '0.001') {
    const model = operation === 'generation' ? config.models.generation : operation.includes('embedding') ? config.models.openaiEmbedding : config.models.jev;
    const row = ledger.reserve({ logicalKey: `${runId}:${operation}`, runId, documentId, method, operation, model, payloadHash: 'unit-fixture', reservedUsd: cost, price: { input: '0.02', output: '0', source: 'fixture', date: '2026-10-05' } });
    ledger.finish(row.id, { status: 'completed', costUsd: cost });
  }
  for (const b of pilotBundles) {
    const document = b.freeze.documents[0]!;
    ledger.freeze(`${pilot.id}:preparation:${document.id}`, { tokens: countTokens(document.blocks.map(block => block.text).join('\n\n')) });
    paid(`${pilot.id}:prepare:${document.id}`, document.id, 'openai-dense', 'document_embedding');
  }
  assert(pilot.schedule.some(row => row.id === KNOWN_EXCEPTION.runId), 'The fixed failed run matches the schedule hashing contract');
  for (const scheduled of pilot.schedule) {
    const failure = scheduled.id === KNOWN_EXCEPTION.runId;
    const run: QueryRun & { generate: boolean } = { ...scheduled, status: failure ? 'failed' : 'completed', startedAt: '2026-10-05T00:00:00Z', finishedAt: '2026-10-05T00:00:01Z', elapsedMs: 1, ranking: [], phases: {}, traces: [], ...(failure ? { error: KNOWN_EXCEPTION.runError } : {}) };
    ledger.saveRun(run);
    if (failure) {
      const attempt: PaidAttempt = { id: KNOWN_EXCEPTION.attemptId, runId: run.id, documentId: run.documentId, method: KNOWN_EXCEPTION.method, operation: KNOWN_EXCEPTION.operation, model: KNOWN_EXCEPTION.model, logicalKey: run.id + ':window', payloadHash: KNOWN_EXCEPTION.payloadHash, reservedUsd: '0.042', status: 'unknown', costUsd: null, error: KNOWN_EXCEPTION.attemptError, startedAt: run.startedAt, finishedAt: run.finishedAt, price: { input: '.042', output: '0', date: '2026-10-05', source: 'fixture' } };
      ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(attempt.id, attempt.logicalKey, JSON.stringify(attempt));
      continue;
    }
    if (scheduled.method === 'openai-dense') paid(run.id, run.documentId, run.method, 'query_embedding');
    if (['jev-scan', 'hybrid-jev'].includes(scheduled.method)) paid(run.id, run.documentId, run.method, 'window');
    if (scheduled.generate) {
      paid(run.id, run.documentId, run.method, 'generation');
      ledger.freeze(`${run.id}:generation-result`, { generation: { text: 'Unit fixture', citations: [], abstained: false, elapsedMs: 1 } });
    }
  }
  const targetConfig = structuredClone(config); targetConfig.generation.questions = 2;
  const targetBundles = [bundle('qasper:test', 'qasper-test-q', 'qasper-test', 'test'), bundle('test-book', 'test-book-q', 'books-test', 'test')];
  const manifest = createManifest(targetBundles, targetConfig, { id: 'unit-main-target', mock: false, phase: 'test', budgetPath: ledgerPath }), targets = [{ manifest, bundles: targetBundles }];
  const amendment: Amendment = { id: 'unit-fixture-only', optionalAblations: { status: 'not-in-main-study' }, budget: { sharedApiCapUsd: '200', judgeReserveUsd: '80' }, primaryEvaluation: { qasper: { answerable: 1, unanswerable: 0 }, books: { questions: 1 } }, operationalEvaluation: { methods: config.methods, timingQuestions: 0, timingRounds: 1 }, secondaryEvaluation: { generationQuestions: 2, arms: 9, generator: config.models.generation, maxOutputTokens: 512 } };
  const strict = await forecastStudy(pilot, pilotBundles, ledger, targets);
  return { dir, ledger, ledgerPath, pilot, pilotBundles, targets, amendment, strict, paid };
}

test('supplement preserves the incomplete strict forecast and adds all conservative reserves', async t => {
  const f = await fixture(t), before = hashObject(f.strict);
  const result = assessForecast(f.strict, f.pilot, f.targets, f.ledger, f.amendment);
  assert.equal(result.status, 'fits-with-disclosed-exception', result.blockers.join('\n'));
  assert.equal(hashObject(f.strict), before);
  assert.equal(result.strictForecast.status, 'incomplete'); assert.equal(result.strictForecast.fitsBudget, null);
  assert.equal(result.strictForecast.estimate.totalUsd, null); assert.equal(result.strictForecast.missing.length, 4);
  assert.equal(result.arithmetic.globalReservedUsd, '0.042');
  const expected = new Decimal(f.strict.estimate.knownComponentSubtotalUsd).mul('1.25').add(f.ledger.totals().committedUsd).add(80).add(5);
  assert.equal(result.arithmetic.conservativeProjectedCommitmentUsd, expected.toFixed());
  assert.equal(result.authorizationToSpend, false); assert.equal(result.guarantee, false);
  assert.equal(result.calibration.length, 34);
  assert.match(result.exception.generationConsequence, /unavailable because its base retrieval failed/);
});

test('rejects any additional unknown reservation, including one outside the pilot', async t => {
  const f = await fixture(t);
  f.ledger.reserve({ logicalKey: 'unrelated:pending', runId: 'unrelated:pending', documentId: 'other', method: 'other', operation: 'generation', model: 'other', payloadHash: 'other', reservedUsd: '.1', price: { input: '0', output: '0', source: 'fixture', date: 'fixture' } });
  const strict = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, f.targets);
  const result = assessForecast(strict, f.pilot, f.targets, f.ledger, f.amendment);
  assert.equal(result.status, 'blocked'); assert(result.blockers.some(reason => reason.includes('one identified unknown')));
});

test('rejects a still-running pilot and incomplete generation beyond the disclosed consequence', async t => {
  const f = await fixture(t), other = f.pilot.schedule.find(row => row.generate && row.id !== KNOWN_EXCEPTION.runId)!;
  f.ledger.db.prepare('DELETE FROM immutable WHERE key=?').run(other.id + ':generation-result');
  const strict = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, f.targets);
  assert.equal(assessForecast(strict, f.pilot, f.targets, f.ledger, f.amendment).status, 'blocked');
  f.ledger.startRun('another-run:running', { id: 'another-run:running' });
  const result = assessForecast(strict, f.pilot, f.targets, f.ledger, f.amendment);
  assert(result.blockers.some(reason => reason.includes('still running')));
});

test('rejects missing calibration components, observations, model changes, and narrowed workload', async t => {
  for (const mutation of ['missing', 'null', 'no-samples', 'model', 'workload']) await t.test(mutation, async child => {
    const f = await fixture(child);
    if (mutation === 'missing') f.strict.components.pop();
    if (mutation === 'null') f.strict.components[0]!.estimatedUsd = null;
    if (mutation === 'no-samples') f.strict.components[0]!.pilotSamples = 0;
    if (mutation === 'model') f.targets[0]!.manifest.config.models.jev = 'unmeasured';
    if (mutation === 'workload') f.targets[0]!.manifest.config.generation.questions = 1;
    assert.equal(assessForecast(f.strict, f.pilot, f.targets, f.ledger, f.amendment).status, 'blocked');
  });
});

test('rejects a changed exception identity or reservation rather than generalizing the exception', async t => {
  const f = await fixture(t), attempt = f.ledger.attempts().find(row => row.id === KNOWN_EXCEPTION.attemptId)!;
  attempt.reservedUsd = '.041';
  f.ledger.db.prepare('UPDATE attempts SET value=? WHERE id=?').run(JSON.stringify(attempt), attempt.id);
  const strict = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, f.targets);
  const result = assessForecast(strict, f.pilot, f.targets, f.ledger, f.amendment);
  assert.equal(result.status, 'blocked'); assert(result.blockers.some(reason => reason.includes('exact USD 0.042')));
});

test('global prior spending is fully included; judge reserve and failure allowance cannot be silently spent', async t => {
  const f = await fixture(t);
  f.paid('unrelated:old-experiment', 'old-doc', 'old-method', 'generation', '120');
  const strict = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, f.targets);
  const result = assessForecast(strict, f.pilot, f.targets, f.ledger, f.amendment);
  assert.equal(result.status, 'blocked'); assert(new Decimal(result.arithmetic.globalCommittedUsd).gte(120));
  assert(new Decimal(result.arithmetic.headroomUsd).lt(0));
  assert.equal(assessForecast(strict, f.pilot, f.targets, f.ledger, f.amendment, '0').status, 'blocked');
});

test('read-only adapter works with the official forecaster and cannot write the live ledger', async t => {
  const f = await fixture(t), reader = new ReadonlyStudyLedger(f.ledgerPath);
  try {
    assert.throws(() => reader.db.exec('CREATE TABLE forbidden(value TEXT)'), /readonly|read-only/i);
    const strict = await forecastStudy(f.pilot, f.pilotBundles, reader as unknown as Ledger, f.targets);
    assert.equal(hashObject(strict), hashObject(f.strict));
    assert.equal(assessForecast(strict, f.pilot, f.targets, reader, f.amendment).status, 'fits-with-disclosed-exception');
  } finally { reader.close(); }
  assert.equal(f.ledger.db.prepare("SELECT name FROM sqlite_master WHERE name='forbidden'").get(), undefined);
});

test('global budget halt and stale forecast commitments block supplementation', async t => {
  const f = await fixture(t);
  f.ledger.freeze('budget-halt', { reason: 'Unit fixture' });
  const result = assessForecast(f.strict, f.pilot, f.targets, f.ledger, f.amendment);
  assert.equal(result.status, 'blocked'); assert(result.blockers.some(reason => reason.includes('budget-halt')));
  f.strict.commitments.committedUsd = '0';
  assert(assessForecast(f.strict, f.pilot, f.targets, f.ledger, f.amendment).blockers.some(reason => reason.includes('commitments differ')));
});
