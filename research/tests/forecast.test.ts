import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import { countTokens } from '../../server/extraction.js';
import { forecastStudy } from '../forecast.js';
import { makeFreeze, textBlocks } from '../datasets.js';
import { createManifest, type ExperimentManifest } from '../runner.js';
import { Ledger } from '../ledger.js';
import { sha256 } from '../util.js';
import type { DatasetBundle, QueryRun, ResearchConfig } from '../types.js';

function bundle(id: string, split: 'development' | 'test', repetitions: number, questions: number): DatasetBundle {
  const text = 'alpha beta gamma '.repeat(repetitions), blocks = textBlocks(id, [{ text }]);
  const document = { id, projectId: id, title: id, hash: sha256(text), version: 1, blockCount: 1, sections: [], blocks };
  const gold = Array.from({ length: questions }, (_, index) => ({ id: `${id}:question:${index}`, documentId: id, question: `Question ${index}`, answer: 'alpha', evidenceSets: [[{ blockId: blocks[0]!.id, start: 0, end: 5, quote: 'alpha' }]] }));
  return { schemaVersion: 1, freeze: makeFreeze(id, [document], gold), sources: [{ documentId: id, corpus: split === 'test' ? 'qasper-test' : 'qasper-development', split, url: `https://example.test/${id}`, license: 'fixture', licenseUrl: 'https://example.test/license', acquiredAt: new Date().toISOString(), rawSha256: sha256(text), textSha256: document.hash }], provenance: { fixture: true } };
}
function config(): ResearchConfig {
  const value: ResearchConfig = JSON.parse(readFileSync(new URL('../config/protocol.json', import.meta.url), 'utf8'));
  value.methods = ['jev-scan', 'openai-dense', 'hybrid-jev', 'bm25']; value.timing = { questions: 1, rounds: 2 }; value.generation.questions = 1;
  return value;
}
async function fixture(t: test.TestContext, options: { unknown?: boolean; missingRun?: boolean; missingPreparation?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-forecast-')), ledger = new Ledger(path.join(dir, 'study.sqlite'));
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const pilotBundles = [bundle('pilot-doc', 'development', 20, 1)], targetBundles = [bundle('test-doc', 'test', 40, 2)];
  const base = config(), pilot = createManifest(pilotBundles, base, { id: 'measured-pilot-fixture', mock: false, phase: 'pilot', budgetPath: path.join(dir, 'study.sqlite') });
  ledger.freeze(`experiment:${pilot.id}`, pilot);
  const pilotTokens = countTokens(pilotBundles[0]!.freeze.documents[0]!.blocks.map(block => block.text).join('\n\n'));
  const targetTokens = countTokens(targetBundles[0]!.freeze.documents[0]!.blocks.map(block => block.text).join('\n\n'));
  if (!options.missingPreparation) ledger.freeze(`${pilot.id}:preparation:pilot-doc`, { tokens: pilotTokens, chunks: 1, phases: {} });
  let first = true;
  function attempt(runId: string, method: string, operation: string, cost: string, documentId = 'pilot-doc') {
    const row = ledger.reserve({ logicalKey: `${runId}:${operation}`, runId, documentId, method, operation, model: 'fixture', payloadHash: 'fixture', price: { input: '1', output: '0', date: 'fixture', source: 'fixture' }, reservedUsd: cost });
    if (!(options.unknown && first)) ledger.finish(row.id, { status: 'completed', costUsd: cost, inputTokens: 100, outputTokens: 0 });
    first = false;
  }
  attempt(`${pilot.id}:prepare:pilot-doc`, 'openai-dense', 'document_embedding', '0.004');
  for (const [index, scheduled] of pilot.schedule.entries()) {
    const run: QueryRun = { ...scheduled, status: 'completed', startedAt: '2026-10-03T00:00:00Z', finishedAt: '2026-10-03T00:00:01Z', elapsedMs: 1000, ranking: [], phases: {}, traces: [] };
    if (!options.missingRun || index !== pilot.schedule.length - 1) ledger.saveRun(run);
    if (scheduled.method === 'jev-scan') { attempt(scheduled.id, scheduled.method, 'window', '0.006'); attempt(scheduled.id, scheduled.method, 'reduction', '0.004'); }
    if (scheduled.method === 'hybrid-jev') attempt(scheduled.id, scheduled.method, 'window', '0.005');
    if (scheduled.method === 'openai-dense') attempt(scheduled.id, scheduled.method, 'query_embedding', '0.001');
    if (scheduled.generate) {
      attempt(scheduled.id, scheduled.method, 'generation', scheduled.method === 'closed-book' ? '0.001' : scheduled.method === 'oracle' ? '0.003' : '0.002');
      ledger.freeze(`${scheduled.id}:generation-result`, { generation: { text: 'Synthetic fixture; no model called.', citations: [], abstained: false, elapsedMs: 1 } });
    }
  }
  const targetConfig = { ...structuredClone(base), timing: { questions: 2, rounds: 3 }, generation: { ...base.generation, questions: 2 } };
  const target = createManifest(targetBundles, targetConfig, { id: 'planned-target-fixture', mock: false, phase: 'test', budgetPath: pilot.budgetPath });
  return { ledger, pilot, pilotBundles, target, targetBundles, pilotTokens, targetTokens, attempt };
}

test('forecast uses measured preparation, all repeated retrieval calls, generation and both controls', async t => {
  const f = await fixture(t), forecast = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ manifest: f.target, bundles: f.targetBundles }]);
  assert.equal(forecast.status, 'complete', forecast.missing.join('\n')); assert.equal(forecast.fitsBudget, true); assert.equal(forecast.guarantee, false);
  const ratio = new Decimal(f.targetTokens).div(f.pilotTokens), prep = ratio.mul('0.004'), scan = ratio.mul('0.01').mul(6);
  const retrieval = scan.add('0.03').add('0.006'), generation = new Decimal('0.024'), total = prep.add(retrieval).add(generation);
  assert(new Decimal(forecast.estimate.preparationUsd!).minus(prep).abs().lt('1e-15'));
  assert(new Decimal(forecast.estimate.retrievalUsd!).minus(retrieval).abs().lt('1e-15'));
  assert.equal(forecast.estimate.generationUsd, generation.toFixed());
  assert(new Decimal(forecast.estimate.totalUsd!).minus(total).abs().lt('1e-15'));
  assert(new Decimal(forecast.estimate.withMarginUsd!).minus(total.mul('1.25')).abs().lt('1e-15'));
  assert.equal(forecast.components.find(item => item.phase === 'retrieval' && item.method === 'jev-scan')!.targetUnits, 6);
  assert.equal(forecast.components.find(item => item.phase === 'generation' && item.method === 'oracle')!.targetUnits, 2);
  assert.equal(forecast.components.find(item => item.phase === 'generation' && item.method === 'closed-book')!.targetUnits, 2);
  assert.equal(forecast.commitments.committedUsd, '0.048');
});

test('multiple future experiments add independently while previous global spending reduces available budget', async t => {
  const f = await fixture(t);
  const other: ExperimentManifest = { ...f.target, id: 'optional-variant', schedule: f.target.schedule.map(run => ({ ...run, id: run.id.replace(f.target.id, 'optional-variant') })) };
  const single = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ manifest: f.target, bundles: f.targetBundles }], 0);
  const both = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ manifest: f.target, bundles: f.targetBundles }, { manifest: other, bundles: f.targetBundles }], 0);
  assert(new Decimal(both.estimate.totalUsd!).eq(new Decimal(single.estimate.totalUsd!).mul(2)));
  f.attempt('another-experiment:run', 'other', 'generation', '199.9');
  const overBudget = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ manifest: f.target, bundles: f.targetBundles }]);
  assert.equal(overBudget.availableBudgetUsd, '0.052'); assert.equal(overBudget.fitsBudget, false);
});

test('unknown cost, missing run and missing preparation prevent a complete budget claim', async t => {
  for (const options of [{ unknown: true }, { missingRun: true }, { missingPreparation: true }]) await t.test(JSON.stringify(options), async child => {
    const f = await fixture(child, options), result = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ manifest: f.target, bundles: f.targetBundles }]);
    assert.equal(result.status, 'incomplete'); assert.equal(result.fitsBudget, null); assert.equal(result.estimate.totalUsd, null); assert(result.missing.length > 0);
  });
});

test('forecast rejects mocks, overlapping sources, started targets and changed calibration conditions', async t => {
  const f = await fixture(t), target = { manifest: f.target, bundles: f.targetBundles };
  await assert.rejects(forecastStudy({ ...f.pilot, kind: 'mock' }, f.pilotBundles, f.ledger, [target]), /never mock/);
  const different = structuredClone(f.target); different.config.models.jev = 'unmeasured-model';
  const flagged = await forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ ...target, manifest: different }]);
  assert.equal(flagged.status, 'incomplete'); assert(flagged.missing.some(message => message.includes('models or prices')));
  const overlap = structuredClone(f.targetBundles); overlap[0]!.sources[0]!.url = f.pilotBundles[0]!.sources[0]!.url;
  await assert.rejects(forecastStudy(f.pilot, f.pilotBundles, f.ledger, [{ ...target, bundles: overlap }]), /overlap/);
  f.ledger.freeze(`experiment:${f.target.id}`, f.target);
  await assert.rejects(forecastStudy(f.pilot, f.pilotBundles, f.ledger, [target]), /unstarted/);
});
