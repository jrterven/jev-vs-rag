import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildJudgeBridge, JUDGE_MODEL, JUDGE_PRICE, type JudgeRequest } from '../ragas/bridge.js';
import { buildCohortJudgeBridge, type BridgeOptions } from '../ragas/cohort-bridge.js';
import { ACKNOWLEDGED_UNKNOWNS, CONTINUATION_RUN_ID, hashFile, type CohortAcknowledgment } from '../ragas/cohort-policy.js';
import { hashObject, sha256 } from '../util.js';
import type { PaidAttempt } from '../ledger.js';

const token = 'b'.repeat(64), runId = CONTINUATION_RUN_ID;
const ACKNOWLEDGED_ATTEMPT_ID = ACKNOWLEDGED_UNKNOWNS[0].attemptId, ACKNOWLEDGED_PAYLOAD_HASH = ACKNOWLEDGED_UNKNOWNS[0].payloadHash;
const request = (sampleId = 'missing', metric: JudgeRequest['metric'] = 'faithfulness', ordinal = 1): JudgeRequest => ({ requestId: `ragas:${hashObject([runId, sampleId, metric, ordinal])}`, sampleId, metric, messages: [{ role: 'user', content: 'Pregunta α 📚: evidencia íntegra.' }], schemaName: 'Verdict', schema: { type: 'object', properties: { verdict: { type: 'boolean' } }, required: ['verdict'], additionalProperties: false } });
const response = () => Response.json({ id: 'offline-response', model: JUDGE_MODEL, status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: '{"verdict":true}' }] }] });
const call = (app: ReturnType<typeof buildJudgeBridge>['app'], payload = request()) => app.inject({ method: 'POST', url: '/judge', headers: { authorization: `Bearer ${token}` }, payload });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'judge-continuation-')), directory = join(root, 'bridge'), ledgerPath = join(root, 'ledger.sqlite'), inputPath = join(root, 'input.jsonl'), resultPath = join(root, 'results.jsonl');
  const terminal = Array.from({ length: 2545 }, (_, i) => ({ sampleId: `terminal-${i}`, metric: 'faithfulness', status: i < 2540 ? 'completed' : 'error' }));
  const samples = [...terminal.map(row => ({ id: row.sampleId, metrics: ['faithfulness'] })), { id: 'missing', metrics: ['faithfulness', 'answer_accuracy'] }, { id: 'other', metrics: ['faithfulness'] }, ...Array.from({ length: 326 }, (_, i) => ({ id: `missing-${i}`, metrics: ['faithfulness'] }))];
  writeFileSync(inputPath, samples.map(x => JSON.stringify(x)).join('\n') + '\n'); writeFileSync(resultPath, terminal.map(x => JSON.stringify(x)).join('\n') + '\n');
  const originalOptions = { runId, directory, ledgerPath, apiKey: 'offline-test-key', token, allowPaid: true, inputHash: hashFile(inputPath), maxEvalUsd: '80', maxOutputTokens: 8192 as const, concurrency: 2, fetcher: async () => response() };
  const original = buildJudgeBridge(originalOptions);
  // A partial metric already has its first subcall; recovery must not call again.
  assert.equal((await call(original.app, request('other'))).statusCode, 200);
  const unknown: PaidAttempt = { id: ACKNOWLEDGED_ATTEMPT_ID, logicalKey: `${runId}:judge:fixture-unknown`, runId: `${runId}:fixture-unknown`, documentId: 'terminal-2540', method: 'ragas-judge', operation: 'ragas_faithfulness', model: JUDGE_MODEL, payloadHash: ACKNOWLEDGED_PAYLOAD_HASH, price: JUDGE_PRICE, reservedUsd: '0.76192', status: 'unknown', costUsd: null, startedAt: '2026-10-05T22:11:00.000Z', finishedAt: '2026-10-05T22:11:01.096Z', elapsedMs: 1096, error: 'fetch failed' };
  const raw = JSON.stringify(unknown); original.ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(unknown.id, unknown.logicalKey, raw);
  const second: PaidAttempt = { ...unknown, id: ACKNOWLEDGED_UNKNOWNS[1].attemptId, logicalKey: `${runId}:judge:fixture-unknown2`, runId: `${runId}:fixture-unknown2`, documentId: 'terminal-2505', payloadHash: ACKNOWLEDGED_UNKNOWNS[1].payloadHash, error: 'Unexpected HTML; JSON parse failed', elapsedMs: 35492.768764 };
  const raw2 = JSON.stringify(second); original.ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(second.id, second.logicalKey, raw2);
  const third: PaidAttempt = { ...second, id: ACKNOWLEDGED_UNKNOWNS[2].attemptId, logicalKey: `${runId}:judge:fixture-unknown3`, runId: `${runId}:fixture-unknown3`, documentId: 'terminal-2544', payloadHash: ACKNOWLEDGED_UNKNOWNS[2].payloadHash };
  const raw3=JSON.stringify(third); original.ledger.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(third.id, third.logicalKey, raw3);
  const originalConfigBytes = readFileSync(join(directory, 'bridge-config.json'));
  const ref = (path: string) => ({ path, sha256: hashFile(path) });
  const originalSources = ['research/ragas/bridge.ts', 'research/ragas/runtime.py', 'research/ledger.ts', 'research/util.ts', 'server/engines/common.ts', 'server/costs.ts'].map(p => ref(resolve(p)));
  const priorSources = ['research/ragas/continuation-bridge.ts', 'research/ragas/continuation-policy.ts', 'output/study-runbook-20261005/resume-ragas-test.py'].map(p => ref(resolve(p)));
  const prior2Sources = ['research/ragas/continuation2-bridge.ts','research/ragas/continuation2-policy.ts','output/study-runbook-20261005/resume-ragas-test-second.py'].map(p=>ref(resolve(p)));
  const allowedUnknowns = [unknown, second, third].map((attempt, i) => ({ attemptId: attempt.id, valueSha256: sha256([raw,raw2,raw3][i]), canonicalHash: hashObject(attempt), payloadHash: attempt.payloadHash, reservedUsd: '0.76192' as const }));
  const priorAckPath = join(root, 'prior-ack.json'), priorLineagePath = join(directory, 'continuation.json'), priorBudgetPath = join(directory, 'continuation-budget.json');
  const priorAck = { schemaVersion: 1, kind: 'ragas-judge-continuation2', runId, baseline: { configHash: hashObject(original.config) }, allowedUnknowns: allowedUnknowns.slice(0,2), sources: { original: originalSources, priorContinuation: priorSources, continuation: prior2Sources } };
  writeFileSync(priorAckPath, JSON.stringify(priorAck, null, 2) + '\n');
  const priorLineage = { schemaVersion: 1, kind: 'ragas-judge-continuation2-lineage', acknowledgment: priorAck, acknowledgmentHash: hashObject(priorAck), acknowledgmentFileHash: hashFile(priorAckPath), originalConfigHash: hashObject(original.config), continuationSourceHash: prior2Sources[0].sha256, policySourceHash: prior2Sources[1].sha256 };
  writeFileSync(priorLineagePath, JSON.stringify(priorLineage, null, 2) + '\n'); original.ledger.freeze(`ragas:${runId}:continuation2`, priorLineage);
  await original.app.close();
  copyFileSync(join(directory, 'budget.json'), priorBudgetPath);
  const backup = join(root, 'baseline.sqlite'); copyFileSync(ledgerPath, backup);
  const archive = join(root, 'phase.tar'); writeFileSync(archive, 'offline-fixture-archive');
  const ack: CohortAcknowledgment = { schemaVersion: 1, kind: 'ragas-judge-cohort', runId, authorization: { literal: 'autorizo terminar los 329 missing sample/metric pairs', authorizedBy: 'Juan Terven', authorizedAt: '2026-10-06T12:48:10.567150+00:00' }, baseline: { configHash: hashObject(original.config), configFileSha256: sha256(originalConfigBytes), ledgerBackup: ref(backup), phaseArchive: ref(archive), results: { path: resultPath, prefixBytes: readFileSync(resultPath).length, prefixSha256: hashFile(resultPath), terminalRows: 2545 }, input: ref(inputPath) }, allowedUnknowns, priorContinuation: { acknowledgment: ref(priorAckPath), lineage: ref(priorLineagePath), lineageHash: hashObject(priorLineage), budget: ref(priorBudgetPath) }, sources: { original: originalSources, priorContinuation: [...priorSources,...prior2Sources], continuation: ['research/ragas/cohort-bridge.ts', 'research/ragas/cohort-policy.ts', 'output/study-runbook-20261005/resume-ragas-test-cohort.py'].map(p => ref(resolve(p))) } };
  const acknowledgmentPath = join(root, 'ack2.json'); writeFileSync(acknowledgmentPath, JSON.stringify(ack, null, 2) + '\n');
  const preserved = [priorAckPath, priorLineagePath, priorBudgetPath, join(directory, 'budget.json')].map(path => ({ path, bytes: readFileSync(path) }));
  const options: BridgeOptions = { ...originalOptions, acknowledgmentPath };
  return { root, options, originalOptions, ack, raw, raw2, preserved, originalConfigBytes, resultPath, writeAck() { writeFileSync(acknowledgmentPath, JSON.stringify(ack, null, 2) + '\n'); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}


test('cohort keeps historical unknowns, scientific payload, no paid request retry and terminal exclusions', async()=>{
 const s=await setup(); let calls=0;
 const b=buildCohortJudgeBridge({...s.options,fetcher:async()=>{calls++;return response()}});
 try {
  assert.equal((await call(b.app)).statusCode,200);
  assert.equal((await call(b.app)).statusCode,200);assert.equal(calls,1);
  assert.equal((await call(b.app,request('terminal-2544'))).statusCode,409);
  const current=JSON.parse(readFileSync(join(s.options.directory,'requests',`${sha256(request().requestId)}.json`),'utf8'));
  assert.equal(current.providerBody.model,JUDGE_MODEL);assert.equal(current.providerBody.max_output_tokens,8192);
  assert.deepEqual(current.providerBody.reasoning,{effort:'medium'});
  assert.equal(readFileSync(join(s.options.directory,'bridge-config.json')).equals(s.originalConfigBytes),true);
  assert.equal(b.ledger.totals(`${runId}:`).reservedUsd,'2.28576');
  for(const f of s.preserved) assert.equal(readFileSync(f.path).equals(f.bytes),true);
 }finally{await b.app.close();s.cleanup()}
});
test('isolated failures retain full reserves and next unattempted metrics proceed; third consecutive failure stops',async()=>{
 const s=await setup();let calls=0;
 const b=buildCohortJudgeBridge({...s.options,fetcher:async()=>{calls++;return Response.json({error:{code:'server_is_overloaded'}},{status:503})}});
 try{
  for(let i=0;i<3;i++)assert.equal((await call(b.app,request(`missing-${i}`))).statusCode,502);
  assert.equal(calls,3);
  assert.equal((await call(b.app,request('missing-3'))).statusCode,409);assert.equal(calls,3);
  assert.equal((await call(b.app,request('missing-0'))).statusCode,409);assert.equal(calls,3);
  assert.equal(b.ledger.totals(`${runId}:`).reservedUsd,'4.57152');
 }finally{await b.app.close();s.cleanup()}
});
test('success resets consecutive failure counter; auth failures stop immediately',async()=>{
 for(const auth of [false,true]){
 const s=await setup();let calls=0;
 const b=buildCohortJudgeBridge({...s.options,fetcher:async()=>{calls++;return auth?Response.json({error:{}},{status:401}): calls%2?Response.json({error:{}},{status:503}):response()}});
 try{
  assert.equal((await call(b.app,request('missing-0'))).statusCode,502);
  if(auth){assert.equal((await call(b.app,request('missing-1'))).statusCode,409);assert.equal(calls,1)}
  else{for(let i=1;i<7;i++)await call(b.app,request(`missing-${i}`));assert.equal(calls,7)}
 }finally{await b.app.close();s.cleanup()}
 }
});
test('each new historical terminal result is excluded on later runtime invocation',async()=>{
 const s=await setup();let calls=0;const b=buildCohortJudgeBridge({...s.options,fetcher:async()=>{calls++;return response()}});
 try{const text=readFileSync(s.resultPath,'utf8');writeFileSync(s.resultPath,text+JSON.stringify({sampleId:'missing',metric:'faithfulness',status:'error'})+'\n');assert.equal((await call(b.app)).statusCode,409);assert.equal(calls,0)}finally{await b.app.close();s.cleanup()}
});
test('tampering authorization, unknown, prior lineage, source or terminal prefix fails closed',async()=>{
 for(const field of ['auth','unknown','source','prior','prefix']){const s=await setup();try{
 if(field==='auth')s.ack.authorization.literal='wrong' as never;
 if(field==='unknown')s.ack.allowedUnknowns[2].valueSha256='0'.repeat(64);
 if(field==='source')s.ack.sources.original[0].sha256='0'.repeat(64);
 if(field==='prior')s.ack.priorContinuation.lineageHash='0'.repeat(64);
 if(field==='prefix')s.ack.baseline.results.prefixSha256='0'.repeat(64);
 s.writeAck();assert.throws(()=>buildCohortJudgeBridge(s.options));
 }finally{s.cleanup()}}
});
test('global and scoped caps include all historical and newly unknown reserves',async()=>{
 for(const global of [true,false]){const s=await setup();let calls=0;const b=buildCohortJudgeBridge({...s.options,fetcher:async()=>{calls++;return response()}});try{
 const prefix=global?'other:':`${runId}:`;b.ledger.reserve({logicalKey:prefix+'guard',runId:prefix+'guard',documentId:'x',method:'x',operation:'x',model:'x',payloadHash:'x',price:JUDGE_PRICE,reservedUsd:global?'197':'77'});
 assert.equal((await call(b.app)).statusCode,402);assert.equal(calls,0);
 }finally{await b.app.close();s.cleanup()}}
});
