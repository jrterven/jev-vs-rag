/** Offline analysis with the original canonical evidence metric; no paid calls. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CanonicalTokens, evaluateRetrieval, clusterBootstrap, intersectionSize } from '../metrics.js';
import { sha256, mean, quantile } from '../util.js';
import type { PreparedDocument, FrozenQuestion } from '../types.js';
import { timingRows } from './timing.js';

const { values }=parseArgs({ options:{ inputs:{type:'string'},directory:{type:'string'},audit:{type:'string'},out:{type:'string'} } });
if(!values.inputs||!values.directory||!values.audit||!values.out)throw new Error('Required --inputs --directory --audit --out');
const inputs=resolve(values.inputs),directory=resolve(values.directory);
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const source=read(join(inputs,'manifest.json')),manifest=read(join(directory,'manifest.json')),audit=read(values.audit);
const amended=audit.kind==='amended-primary-cohort-integrity-audit';
if(amended&&(!audit.primaryComplete||audit.primaryTerminal!==952))throw new Error('Amended primary cohort is incomplete');
if(!audit.passed||audit.manifestSha256!==sha256(readFileSync(join(directory,'manifest.json')))||audit.inputManifestSha256!==sha256(readFileSync(join(inputs,'manifest.json'))))throw new Error('Audit does not match the completed cohort');
for(const [name,hash] of Object.entries(source.files))if(sha256(readFileSync(join(inputs,name)))!==hash)throw new Error('Input changed: '+name);
for(const [name,hash] of Object.entries(audit.runHashes))if(sha256(readFileSync(join(directory,'runs',name)))!==hash)throw new Error('Run changed: '+name);
const questions=new Map<string,FrozenQuestion>(read(join(inputs,'questions.json')).map((q:FrozenQuestion)=>[q.id,q]));
const rows:any[]=[],retention:any[]=[];
const runs=readdirSync(join(directory,'runs')).filter(n=>n.endsWith('.json')).map(n=>read(join(directory,'runs',n)));
if(runs.length!==audit.runs)throw new Error('Run count changed');
for(const entry of source.documents){
 const doc=read(join(inputs,entry.path)) as PreparedDocument,tokens=new CanonicalTokens(doc.text),lookup=new Map(doc.chunks.map(c=>[c.id,c]));
 const mapped=(ids:string[])=>ids.map(id=>{const c=lookup.get(id);if(!c)throw new Error('Unknown chunk '+id);return c;});
 for(const run of runs.filter(r=>r.documentId===doc.id)){
  const q=questions.get(run.questionId);if(!q||q.documentId!==doc.id)throw new Error('Question lineage mismatch');
  const retrieved=run.status==='completed'?mapped(run.ranking.map((r:any)=>r.chunkId)):[];
  const metrics=run.round===0&&!q.unanswerable?evaluateRetrieval(tokens,doc.chunks,retrieved,q.evidenceSets,5):null;
  rows.push({id:run.id,questionId:q.id,documentId:doc.id,corpus:run.corpus,method:run.method,round:run.round,status:run.status,error:run.error??null,metrics,
    elapsedMs:run.elapsedMs,latencyScope:run.latencyScope??(run.method==='hybrid-clef'?'reranking-only':'full-scan'),timingSample:run.timingSample,
    timingEnvironment:run.timingEnvironment??'failed-run',calls:run.calls??run.callsStarted,inputTokens:run.inputTokens??null,apiCostUsd:'0'});
  if(run.round!==0||q.unanswerable||run.status!=='completed')continue;
  const initial=run.traces.filter((t:any)=>t.stage==='window'&&t.level===0).flatMap((t:any)=>t.candidateIds);
  const final=run.traces.find((t:any)=>t.stage==='final'),first=run.traces.find((t:any)=>t.stage==='retained'&&t.level===0)??final;
  for(const [stage,ids] of [['initial',initial],['first-selection',first.retainedIds],['final-input',final.candidateIds],['final-five',final.retainedIds]] as Array<[string,string[]]>){
   const spans=mapped(ids).map(c=>tokens.span(c));
   const coverage=Math.max(...q.evidenceSets.map(set=>mean(set.map(s=>{const g=tokens.span(s);return intersectionSize([g],spans)/(g.end-g.start);}))))
   retention.push({questionId:q.id,documentId:doc.id,corpus:run.corpus,method:run.method,stage,coverage});
  }
 }
}
const methods:any[]=[];
for(const corpus of [...new Set(rows.map(r=>r.corpus))])for(const method of ['hybrid-clef','clef-scan']){
 const all=rows.filter(r=>r.corpus===corpus&&r.method===method),base=all.filter(r=>r.round===0),answerable=base.filter(r=>r.metrics);
 const times=timingRows(all,source.phase,amended);
 const timingGroups=[...new Set(times.map(r=>r.timingEnvironment))].map(environment=>{
  const values=times.filter(r=>r.timingEnvironment===environment).map(r=>r.elapsedMs);
  return {environment,runs:values.length,p50Ms:quantile(values,.5),p95Ms:quantile(values,.95)};
 });
 methods.push({corpus,method,nQueries:base.length,nAnswerable:answerable.length,failures:base.filter(r=>r.status!=='completed').length,
  coverage:answerable.length?clusterBootstrap(answerable.map(r=>({documentId:r.documentId,value:r.metrics.coverage})),10000,42):null,
  completeEvidence:answerable.length?clusterBootstrap(answerable.map(r=>({documentId:r.documentId,value:Number(r.metrics.completeGold)})),10000,42):null,
  latencyScope:method==='hybrid-clef'?'reranking-only':'full-scan',timingGroups,apiCostUsd:'0'});
}
const result={schemaVersion:1,kind:'measured-local-clef-retrieval',phase:source.phase,implementationHash:manifest.implementationHash,datasetHash:manifest.datasetHash,
 inputManifestSha256:audit.inputManifestSha256,auditSha256:sha256(readFileSync(values.audit)),environment:manifest.environment,bookAnnotation:source.bookAnnotation,
 aggregation:'Document macro; failed assigned retrievals have zero retrieved evidence; negative questions have no evidence coverage score.',
 timing:amended?'Explicit user amendment stopped extra timing repeats after primary retrieval completed. Summaries use round0 only and are descriptive single-pass measurements, not the original three-round protocol. Separate host/date/concurrency; hybrid excludes candidate generation; recording overhead included.':'Separate hardware/date/concurrency from original study. Hybrid timing excludes frozen candidate generation. Recording overhead is included. Pilot timing is descriptive, not the scheduled repeated test measurement.',
 timingProtocolComplete:!amended,amendment:amended?{sha256:audit.amendmentSha256,completedExtraRepeats:audit.completedTimingRepeats,omittedTimingRepeats:audit.omittedTimingRepeats.length,interruptedTimingRepeats:audit.interruptedTimingRepeats.length,primaryComplete:true}:null,
 cost:'No API charges for local Clef inference. CPU, GPU, RAM, disk and electricity are unpriced. Do not interpret API zero as zero total cost.',
 methods,retention,perQuery:rows};
writeFileSync(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out:values.out,phase:source.phase,runs:rows.length,methods:methods.length}));
