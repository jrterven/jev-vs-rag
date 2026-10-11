import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { costForTokens } from '../server/costs.js';
import { emptyMetrics } from '../server/jobs.js';
import type { EngineAdapter, RuntimeConfig, WorkContext } from '../server/contracts.js';
import type { Attempt, DocumentRecord, Engine, Overview } from '../shared/types.js';

function mocks(config:RuntimeConfig):Record<Engine,EngineAdapter> {
  function record(engine:Engine,ctx:WorkContext,operation:Attempt['operation']) {
    const id=randomUUID(),rate=engine==='jev'?config.jevRate:config.embeddingRate;
    ctx.attempts.start({id,documentId:ctx.documentId,jobId:ctx.jobId,runId:ctx.runId,engine,operation,model:engine==='jev'?config.jevModel:config.embeddingModel,startedAt:new Date().toISOString(),status:'pending',rateUsdPerMillion:rate,rateDate:config.rateDate,rateSource:'test',costUsd:null});
    ctx.attempts.finish(id,{status:'completed',inputTokens:100,costUsd:costForTokens(100,rate)});
  }
  const make=(engine:Engine):EngineAdapter=>({engine,
    async prepare(_blocks,_chunks,ctx){ctx.signal.throwIfAborted();if(!ctx.getCheckpoint('done')){record(engine,ctx,engine==='jev'?'structure':'document_embedding');ctx.checkpoint('done',true);}return {};},
    async search(_query,chunks,ctx){await delay(engine==='jev'?30:5,undefined,{signal:ctx.signal});record(engine,ctx,engine==='jev'?'window':'query_embedding');return {hits:chunks.slice(0,5).map(c=>({chunkId:c.id,text:c.text,path:c.path,references:c.references,score:0.8,scoreKind:engine==='jev'?'choice_probability':'cosine_similarity'})),metrics:{...emptyMetrics(2),windowsTotal:1,windowsCompleted:1,chunksTotal:chunks.length,chunksCovered:chunks.length}};},
    async delete(){},
  });
  return {jev:make('jev'),rag:make('rag')};
}
function multipart(name:string,text:string){const boundary='test-boundary';return {headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--\r\n`)};}
async function fixture(t:test.TestContext){
  const dataDir=await mkdtemp(path.join(tmpdir(),'jev-app-test-'));
  const config=readConfig({DATA_DIR:dataDir,TYPESAFE_API_KEY:'test-only-jev-secret',OPENAI_API_KEY:'test-only-openai-secret'});
  const built=await buildApp(config,mocks(config));await built.app.ready();
  t.after(async()=>{await built.app.close();await rm(dataDir,{recursive:true,force:true});});
  return {...built,config};
}
async function waitFor<T>(get:()=>Promise<T>,finished:(value:T)=>boolean):Promise<T>{for(let i=0;i<300;i++){const result=await get();if(finished(result))return result;await delay(20);}throw new Error('Timed out');}
async function upload(f:Awaited<ReturnType<typeof fixture>>){
  const response=await f.app.inject({method:'POST',url:'/api/documents',...multipart('libro.txt','CAPÍTULO UNO\n\nEl observatorio se inauguró en 1987.\n\nCAPÍTULO DOS\n\nEl telescopio utiliza espejos de plata.')});
  assert.equal(response.statusCode,202,response.body);const doc=response.json<DocumentRecord>();
  await waitFor(async()=> (await f.app.inject(`/api/documents/${doc.id}`)).json<Overview>(),o=>o.document.status==='completed');return doc;
}
test('API: upload, independent searches, benchmark, ratings, cost export and deletion',async t=>{
  const f=await fixture(t);const doc=await upload(f);
  assert.equal(f.store.attempts(doc.id).length,2);
  const response=await f.app.inject({method:'POST',url:`/api/documents/${doc.id}/search`,payload:{query:'¿Cuándo se inauguró el observatorio?',rounds:5}});
  assert.equal(response.statusCode,202,response.body);const comparisonId=response.json().comparison.id;
  const result=await waitFor(async()=> (await f.app.inject(`/api/documents/${doc.id}`)).json<Overview>(),o=>o.comparisons[0]?.status==='completed');
  assert.equal(result.comparisons[0].runs.length,10);assert.equal(f.store.attempts(doc.id).length,12);
  assert.equal(result.costs.jev.preparation.calls,1);assert.equal(result.costs.jev.searches.calls,5);assert.equal(result.costs.jev.sampleSize,5);
  assert.equal(result.costs.jev.projections[0].totalUsd,'0.0004242');
  const run=result.comparisons[0].runs[0];assert.ok(run.elapsedMs!>=25);assert.equal(run.metrics.chunksCovered,doc.chunkCount||result.document.chunkCount);
  const rating=await f.app.inject({method:'PUT',url:'/api/ratings',payload:{comparisonId,runId:run.id,chunkId:run.hits[0].chunkId,value:'useful'}});assert.equal(rating.statusCode,200);
  const context=await f.app.inject(`/api/documents/${doc.id}/chunks/${encodeURIComponent(run.hits[0].chunkId)}`);assert.equal(context.statusCode,200);assert.ok(context.json().blocks.length>0);
  const exported=await f.app.inject(`/api/documents/${doc.id}/export`);assert.equal(exported.statusCode,200);assert.equal(exported.json().attempts.length,12);assert.equal(exported.json().ratings.length,1);
  assert.ok(!exported.body.includes('test-only-'));assert.match(exported.headers['content-disposition']!,/attachment/);
  const del=await f.app.inject({method:'DELETE',url:`/api/documents/${doc.id}`});assert.equal(del.statusCode,200);assert.equal(f.store.attempts(doc.id).length,0);
  assert.equal((await f.app.inject(`/api/documents/${doc.id}`)).statusCode,404);
});
test('API: validates files, query, origins and secret-free configuration',async t=>{
  const f=await fixture(t);
  assert.equal((await f.app.inject({method:'POST',url:'/api/documents',...multipart('bad.exe','binary')})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:'/api/documents',...multipart('bad.pdf','not a PDF')})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:'/api/documents',...multipart('empty.txt','')})).statusCode,400);
  assert.equal((await f.app.inject({method:'GET',url:'/api/config',headers:{origin:'https://untrusted.example'}})).statusCode,403);
  const config=await f.app.inject('/api/config');assert.equal(config.statusCode,200);assert.ok(!config.body.includes('test-only-'));
  const doc=await upload(f);
  assert.equal((await f.app.inject({method:'POST',url:`/api/documents/${doc.id}/search`,payload:{query:' ',rounds:1}})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:`/api/documents/${doc.id}/search`,payload:{query:'test',rounds:50}})).statusCode,400);
  assert.equal((await f.app.inject({method:'PUT',url:'/api/ratings',payload:{comparisonId:'no',runId:'no',chunkId:'no',value:'useful'}})).statusCode,404);
});
test('API: resume reuses completed preparation, changed chunk configuration invalidates it',async t=>{
  const f=await fixture(t);const doc=await upload(f);
  const response=await f.app.inject({method:'POST',url:`/api/documents/${doc.id}/resume`});assert.equal(response.statusCode,202);
  await waitFor(async()=>f.store.job(response.json().id)!,j=>j.status==='completed');assert.equal(f.store.attempts(doc.id).length,2);
  f.config.chunkTokens=300;
  const retry=await f.app.inject({method:'POST',url:`/api/documents/${doc.id}/resume`});
  await waitFor(async()=>f.store.job(retry.json().id)!,j=>j.status==='completed');assert.equal(f.store.attempts(doc.id).length,4);
});
test('API: cancellation does not allow deletion while provider work is active',async t=>{
  const f=await fixture(t);const doc=await upload(f);
  const response=await f.app.inject({method:'POST',url:`/api/documents/${doc.id}/search`,payload:{query:'fecha',rounds:5}});const job=response.json().job;
  await waitFor(async()=>f.store.job(job.id)!,j=>j.status==='running');
  assert.equal((await f.app.inject({method:'DELETE',url:`/api/documents/${doc.id}`})).statusCode,409);
  assert.equal((await f.app.inject({method:'POST',url:`/api/jobs/${job.id}/cancel`})).statusCode,200);
  await waitFor(async()=>f.jobs.isActive(doc.id),active=>!active);
  assert.equal(f.store.comparison(job.comparisonId)!.status,'cancelled');
  assert.equal((await f.app.inject({method:'DELETE',url:`/api/documents/${doc.id}`})).statusCode,200);
});
