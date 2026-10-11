/** Offline comparison against the unchanged original report. Never sends API calls. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import { combineBundles } from '../runner.js';
import { prepareDocument } from '../datasets.js';
import { CanonicalTokens, evaluateRetrieval, clusterBootstrap, intersectionSize } from '../metrics.js';
import { hashObject, readJson, sha256, writeJson, mean, quantile } from '../util.js';
import type { DatasetBundle, PreparedDocument } from '../types.js';
import { auditAttemptCost } from '../scripts/study-readout.js';
import type { PaidAttempt } from '../ledger.js';

const { values } = parseArgs({ options: { directory: { type:'string' }, ledger:{ type:'string' }, baseline:{type:'string'}, out:{type:'string'} } });
if (!values.directory || !values.ledger || !values.baseline || !values.out) throw new Error('Required --directory --ledger --baseline --out.');
const directory=resolve(values.directory), baselinePath=resolve(values.baseline);
const report=readJson<any>(join(directory,'report.json')), manifest=readJson<any>(join(directory,'manifest.json'));
const completion=readJson<any>(join(directory,'completion.json'));
if (completion.exitError || !completion.allRetrievalTerminal || completion.generationTerminal!==completion.generationPlanned || report.perQuery.length!==manifest.schedule.length) throw new Error('Cohort not terminal; do not present an interim report as final.');
if (sha256(readFileSync(baselinePath))!=='f102690b610c8fc7c14f924ede944d470a4ddcaa3fb3a0d6a0e63bfaecff3e59') throw new Error('Original baseline report changed.');
const baseline=readJson<any>(baselinePath), bundle=readJson<DatasetBundle[]>(join(directory,'datasets.json')), combined=combineBundles(bundle);
if (combined.datasetHash!==manifest.datasetHash || combined.datasetHash!==baseline.datasetHash || report.implementationHash!==manifest.implementationHash || report.configHash!==manifest.configHash) throw new Error('Dataset/implementation/config mismatch.');
const db=new DatabaseSync(resolve(values.ledger),{readOnly:true});db.exec('PRAGMA query_only=ON');
function frozen(key:string) {const row=db.prepare('SELECT value,hash FROM immutable WHERE key=?').get(key) as {value:string;hash:string}|undefined;if(!row)throw new Error('Missing '+key);const value=JSON.parse(row.value);if(hashObject(value)!==row.hash)throw new Error('Checkpoint checksum '+key);return value;}
if(hashObject(frozen('experiment:'+manifest.id))!==hashObject(manifest))throw new Error('Manifest differs from ledger.');
const operational=report.operationalContinuation??null;
if(operational&&hashObject(frozen(manifest.id+':shared-gpu-continuation'))!==hashObject(operational))throw new Error('Operational continuation differs from ledger.');
const attempts=(db.prepare('SELECT value FROM attempts').all() as Array<{value:string}>).map(r=>JSON.parse(r.value) as PaidAttempt);
if(attempts.some(a=>a.status==='pending'))throw new Error('Pending paid attempts in snapshot.');
const own=attempts.filter(a=>a.runId.startsWith(manifest.id+':'));own.forEach(auditAttemptCost);
const qmap=new Map(combined.questions.map(q=>[q.id,q]));
const compact:any[]=[], retention:any[]=[];
for(const frozenDoc of combined.documents){
 const runs=report.perQuery.filter((r:any)=>r.documentId===frozenDoc.id); if(!runs.length)continue;
 const doc=await prepareDocument(frozenDoc,manifest.config.chunkTokens,manifest.config.overlapTokens,manifest.config.maxDocumentTokens), tokens=new CanonicalTokens(doc.text), byId=new Map(doc.chunks.map(c=>[c.id,c]));
 const mapped=(ids:string[])=>ids.map(id=>{const c=byId.get(id);if(!c)throw new Error('Unknown source chunk '+id);return c;});
 for(const run of runs){
  const row=db.prepare('SELECT value,status FROM runs WHERE id=?').get(run.id) as {value:string;status:string}|undefined;if(!row)throw new Error('Unpersisted run');
  const saved=JSON.parse(row.value);for(const k of ['status','ranking','traces','phases','elapsedMs','questionId','method','round','timingValid','timingEnvironment','operationalContinuationId'])if(hashObject(saved[k]??null)!==hashObject(run[k]??null))throw new Error('Report/ledger drift '+k);
  const q=qmap.get(run.questionId)!;if(!q || q.documentId!==doc.id)throw new Error('Unknown source question.');
  const initial=run.traces.filter((t:any)=>t.stage==='window'&&t.level===0).flatMap((t:any)=>t.candidateIds);
  if(run.status==='completed'){
   const expected=run.method==='decisions-scan'?doc.chunks.map(c=>c.id):run.traces.find((t:any)=>t.stage==='hybrid50').retainedIds;
   if(new Set(initial).size!==expected.length||expected.some((id:string)=>!initial.includes(id)))throw new Error('Completed query lacks full initial coverage');
   if(run.ranking.length!==Math.min(5,expected.length)||new Set(run.ranking.map((x:any)=>x.chunkId)).size!==run.ranking.length)throw new Error('Invalid final top five');
  }
  const retrieved=run.status==='completed'?mapped(run.ranking.map((x:any)=>x.chunkId)):[];
  const metrics=run.round===0&&!q.unanswerable?evaluateRetrieval(tokens,doc.chunks,retrieved,q.evidenceSets,5):null;
  const paid=own.filter(a=>a.runId===run.id&&a.operation!=='generation');
  compact.push({id:run.id,questionId:run.questionId,documentId:run.documentId,corpus:run.corpus,method:run.method,round:run.round,status:run.status,error:run.error??null,timingSample:run.timingSample,timingValid:run.timingValid,timingEnvironment:run.timingEnvironment??'original-isolated-block',operationalContinuationId:run.operationalContinuationId??null,elapsedMs:run.elapsedMs,metrics,queryKnownUsd:paid.reduce((n,a)=>n.add(a.costUsd??0),new Decimal(0)).toFixed(),queryUnknown:paid.filter(a=>a.costUsd===null).length,apiCalls:paid.length,inputTokens:paid.reduce((n,a)=>n+(a.inputTokens??0),0),successfulGeneration:Boolean(run.generation),generationError:run.generationError??null});
  if(run.round===0&&!q.unanswerable&&run.status==='completed'){
   const final=run.traces.find((t:any)=>t.stage==='final');const retained=run.traces.filter((t:any)=>t.stage==='retained');const first=retained.find((t:any)=>t.level===0)??final;
   for(const [stage,ids] of [['initial',initial],['first-selection',first.retainedIds],['final-input',final.candidateIds],['final-five',final.retainedIds]] as Array<[string,string[]]>){
    const spans=mapped(ids).map(c=>tokens.span(c));const coverage=Math.max(...q.evidenceSets.map(set=>mean(set.map(s=>{const g=tokens.span(s);return intersectionSize([g],spans)/(g.end-g.start);}))))
    retention.push({questionId:q.id,documentId:doc.id,corpus:run.corpus,method:run.method,stage,coverage});
   }
  }
 }
}
const methods:any[]=[];
for(const corpus of [...new Set(compact.map(r=>r.corpus))])for(const method of ['hybrid-decisions','decisions-scan']){
 const all=compact.filter(r=>r.corpus===corpus&&r.method===method),base=all.filter(r=>r.round===0),positive=base.filter(r=>r.metrics),time=all.filter(r=>r.timingSample&&r.status==='completed'&&r.timingValid!==false);
 const sharedTime=all.filter(r=>r.timingSample&&r.status==='completed'&&r.timingEnvironment==='shared-gpu');
 const docs=[...new Set(base.map(r=>r.documentId))];
 const queryMean=docs.reduce((n,id)=>{const rr=base.filter(r=>r.documentId===id);return n.add(rr.reduce((s,r)=>s.add(r.queryKnownUsd),new Decimal(0)).div(rr.length));},new Decimal(0)).div(docs.length);
 const ci=clusterBootstrap(positive.map(r=>({documentId:r.documentId,value:r.metrics.coverage})),10000,42);
 const unknown=all.reduce((n,r)=>n+r.queryUnknown,0);
 methods.push({id:method,corpus,coverage:ci.mean,coverageLow:ci.low,coverageHigh:ci.high,latencyP50Ms:time.length?quantile(time.map(r=>r.elapsedMs),.5):null,latencyP95Ms:time.length?quantile(time.map(r=>r.elapsedMs),.95):null,nTimingRuns:time.length,nSharedTimingRuns:sharedTime.length,sharedLatencyP50Ms:sharedTime.length?quantile(sharedTime.map(r=>r.elapsedMs),.5):null,sharedLatencyP95Ms:sharedTime.length?quantile(sharedTime.map(r=>r.elapsedMs),.95):null,timingFailures:all.filter(r=>r.timingSample&&r.status!=='completed').length,completedInvalidTiming:all.filter(r=>r.timingSample&&r.status==='completed'&&r.timingValid===false).length,nQueries:base.length,nAnswerable:positive.length,failures:base.filter(r=>r.status!=='completed').length,preparationUsd:'0',preparationScope:'Reuse existing local BGE index; no paid preparation, cold local indexing time not remeasured.',queryMeanUsd:queryMean.toFixed(),unknownCostAttempts:unknown,projections:[1,5,10,50,100,1000].map(n=>({queries:n,totalUsd:queryMean.mul(n).toFixed(),amortizedUsd:queryMean.toFixed(),lowerBound:unknown>0}))});
}
const paired:any[]=[];
for(const corpus of [...new Set(compact.map(r=>r.corpus))])for(const method of ['hybrid-decisions','decisions-scan'])for(const old of ['openai-dense','hybrid-bge','hybrid-jev','jev-scan']){
 const rows=compact.filter(r=>r.corpus===corpus&&r.method===method&&r.round===0&&r.metrics).map(r=>{const b=baseline.perQuery.find((b:any)=>b.questionId===r.questionId&&b.method===old&&b.round===0);if(!b?.metrics)throw new Error('Missing paired baseline');return {questionId:r.questionId,documentId:r.documentId,value:r.metrics.coverage-b.metrics.coverage};});
 paired.push({corpus,method,baseline:old,metric:'evidence_coverage_at_5',questions:rows.length,...clusterBootstrap(rows,10000,42)});
}
writeJson(values.out,{schemaVersion:1,kind:'measured',scope:'post-original-study Decisions extension',datasetHash:combined.datasetHash,implementationHash:manifest.implementationHash,baselineReportSha256:sha256(readFileSync(baselinePath)),manifestSha256:sha256(readFileSync(join(directory,'manifest.json'))),aggregation:'document_macro; failed assigned retrieval queries have zero retrieved evidence; negative questions do not get an evidence coverage score',operationalContinuation:operational,timing:'Completed isolated-block runs and user-authorized shared-GPU continuation are summarized separately. All shared-block timings have timingValid=false for isolated comparisons, while retaining measured elapsed time. Same assigned 100 questions and three rounds; different measurement dates from original baseline. Terminal failures are retained and never retried.',methods:[...baseline.methods,...methods],paired,retention,perQuery:compact,completion,resources:'CPU, RAM, disk and electricity unpriced; generator and judge spending excluded from retrieval projections'});
db.close();console.log(JSON.stringify({out:values.out,methods:methods.length,paired:paired.length,runs:compact.length}));
