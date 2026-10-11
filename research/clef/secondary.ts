/** Import audited local retrieval, then run the unchanged frozen generator.
 * Runs on asus-juan, in its EXISTING shared ledger. No inference or model keys
 * on the Spark; no retrieval reruns, no retries, and no edits to prior runs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import { Ledger, paidJson } from '../ledger.js';
import { combineBundles, type ExperimentManifest } from '../runner.js';
import { planRetrievalContext } from '../context.js';
import { generationBody } from '../ragas/export.js';
import { auditFileSha256 } from '../ragas/audit.js';
import { hashObject, sha256, readJson, writeJson } from '../util.js';
import type { DatasetBundle, FrozenQuestion, PreparedDocument, QueryRun, ResearchConfig } from '../types.js';

export const ID='clef-spark-20261007-v1:main', JUDGE_ID='clef-ragas-20261009-v1';
export type ClefRun=Omit<QueryRun,'method'> & {method:'hybrid-clef'|'clef-scan';generate:boolean};
const SCOPE={runPrefix:'clef-spark-20261007-v1:',maxBudgetUsd:'100'};
const FILES=['research/clef/secondary.ts','research/context.ts','research/ledger.ts','research/util.ts','research/ragas/export.ts','research/ragas/study-export.ts','research/ragas/audit.ts','research/types.ts','research/datasets.ts','research/runner.ts','research/metrics.ts','server/extraction.ts','package-lock.json'];
const need=(v:unknown,msg:string):void=>{if(!v)throw new Error('PROVENANCE: '+msg);};
function immutableBytes(path:string,bytes:Buffer) {
  if(existsSync(path))need(readFileSync(path).equals(bytes),'Immutable file changed: '+path);
  else writeFileSync(path,bytes,{flag:'wx',mode:0o600});
}

export function assertBudgets(ledger:Ledger) {
  const attempts=ledger.attempts();
  need(!attempts.some(a=>a.status==='pending'),'Unresolved API attempt; no continuation');
  need(!ledger.get('budget-halt'),'Budget halt requires inspection');
  const committed=(rows:typeof attempts)=>rows.reduce((n,a)=>n.add(a.costUsd??a.reservedUsd),new Decimal(0));
  need(committed(attempts).lte(200),'Global cap exceeded');
  need(committed(attempts.filter(a=>a.method==='ragas-judge')).lte(80),'Cumulative judge cap exceeded');
  return {global:ledger.totals(),judgesCommittedUsd:committed(attempts.filter(a=>a.method==='ragas-judge')).toFixed()};
}

export function generationPlan(config:ResearchConfig,q:FrozenQuestion,doc:PreparedDocument,run:ClefRun) {
  const plan=planRetrievalContext(doc,run.ranking);
  return {...plan,body:generationBody(q,plan.contexts,run.method,config)};
}

export async function generate(config:ResearchConfig,ledger:Ledger,q:FrozenQuestion,doc:PreparedDocument,run:ClefRun,signal:AbortSignal,fetcher?:typeof fetch) {
  const start=performance.now(),plan=generationPlan(config,q,doc,run),body=plan.body;
  ledger.freeze(`${run.id}:generation-context`,plan.manifest);
  const logicalKey=`${run.id}:generation:${hashObject(body)}`;
  if(ledger.db.prepare('SELECT id FROM attempts WHERE logical_key=?').get(logicalKey))throw new Error('Prior generation attempt exists; never retry.');
  const result=await paidJson({ledger,logicalKey,runId:run.id,documentId:doc.id,method:run.method,operation:'generation',model:config.models.generation,
    price:{input:config.rates.generationInput,output:config.rates.generationOutput,cachedInput:config.rates.generationCachedInput,date:config.rates.date,source:'https://developers.openai.com/api/docs/models/gpt-4.1-mini'},
    reservedUsd:new Decimal(1_047_576).mul(config.rates.generationInput).add(new Decimal(config.generation.maxOutputTokens).mul(config.rates.generationOutput)).div(1e6).toFixed(),
    budgetScope:SCOPE,url:'https://api.openai.com/v1/responses',apiKey:process.env.OPENAI_API_KEY??'',body,provider:'openai-generation',signal,timeoutMs:config.requestTimeoutMs,allowPaid:true,fetcher});
  if(result.status>=400||result.data.status!=='completed')throw new Error('Generation did not complete; no retry.');
  const attempt=ledger.attempts().find(a=>a.id===result.attemptId);
  if(attempt?.status!=='completed'||attempt.reportedModel!==config.models.generation)throw new Error('Generation usage/model unconfirmed; preserve error and reserve.');
  const outputs=result.data.output as Array<{content?:Array<{type?:string;text?:string}>}>;
  const answer=JSON.parse(outputs?.flatMap(o=>o.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join(''));
  if(typeof answer.answer!=='string'||typeof answer.abstained!=='boolean'||!Array.isArray(answer.citationLabels)||answer.citationLabels.some((l:string)=>!plan.contexts.some(c=>c.label===l)))throw new Error('Invalid generation/citations.');
  return {text:answer.answer,citations:[...new Set<string>(answer.citationLabels)].map(label=>({label,spans:plan.contexts.find(c=>c.label===label)!.spans})),abstained:answer.abstained,elapsedMs:performance.now()-start,contextManifest:plan.manifest};
}

function lineage(ledger:Ledger,prior:string) {
  need(auditFileSha256(prior)==='b7b391147049899a598862d59ccee0ce5848a03d8b046b256cef545528345f9b','Original closed ledger changed');
  ledger.db.prepare('ATTACH DATABASE ? AS prior').run(prior);
  try {for(const [table,key] of [['attempts','id'],['runs','id'],['immutable','key'],['responses','key']]) {
    const cols=(ledger.db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{name:string}>).map(r=>r.name);
    const predicate=cols.map(c=>`n.${c} IS NOT o.${c}`).join(' OR ');
    const row=ledger.db.prepare(`SELECT count(*) AS n FROM prior.${table} o LEFT JOIN main.${table} n ON n.${key}=o.${key} WHERE n.${key} IS NULL OR ${predicate}`).get() as {n:number};
    need(row.n===0,'Historical rows changed: '+table);
  }}finally {ledger.db.exec('DETACH DATABASE prior');}
}

export async function prepare(options:{inputs:string;retrieval:string;audit:string;out:string;ledger:string}) {
  need(existsSync(options.ledger),'Existing shared ledger required; never create another');
  const inputs=resolve(options.inputs),retrieval=resolve(options.retrieval),out=resolve(options.out);
  const input=readJson<any>(join(inputs,'manifest.json')),audit=readJson<any>(options.audit),base=readJson<ExperimentManifest>(join(inputs,'source-manifest.json'));
  need(sha256(readFileSync(join(inputs,'manifest.json')))==='e4e66b0f42360d4586362fcb47bd3074c2239ef87006539d29b55b27eb2ee3df','Clef input freeze differs');
  need(audit.passed&&audit.kind==='amended-primary-cohort-integrity-audit'&&audit.primaryComplete&&audit.primaryTerminal===952,'Primary audit incomplete');
  need(audit.inputManifestSha256===sha256(readFileSync(join(inputs,'manifest.json')))&&audit.manifestSha256===sha256(readFileSync(join(retrieval,'manifest.json'))),'Audit source binding mismatch');
  for(const [name,sha] of Object.entries(input.files))need(sha256(readFileSync(join(inputs,name)))===sha,'Frozen input changed: '+name);
  const runPaths=readdirSync(join(retrieval,'runs')).filter(p=>p.endsWith('.json'));need(runPaths.length===audit.runs,'Closed run inventory differs');
  const raw=runPaths.map(name=>{need(audit.runHashes[name]===sha256(readFileSync(join(retrieval,'runs',name))),'Closed run hash differs');return readJson<any>(join(retrieval,'runs',name));});
  const original=resolve('data/research/gb10-main-study-20261004-v1'),bytes=readFileSync(join(original,'datasets.json'));
  need(sha256(bytes)==='59d9dcfe479f9fe3ca30ed723da933609468e275bfd6f6d7ab09cd2ef38843e1','Original datasets changed');
  const bundles=JSON.parse(bytes.toString()) as DatasetBundle[],combined=combineBundles(bundles);
  need(combined.datasetHash===input.datasetHash&&combined.sources.every(s=>s.split==='test'),'Test lineage differs');
  const qmap=new Map(combined.questions.map(q=>[q.id,q]));
  const questions=readJson<FrozenQuestion[]>(join(inputs,'questions.json'));
  for(const q of questions)need(hashObject(q)===hashObject(qmap.get(q.id)),'Question/reference/authorship differs');
  const docs=new Map<string,PreparedDocument>(input.documents.map((d:any)=>[d.id,readJson<PreparedDocument>(join(inputs,d.path))]));
  const schedule=readJson<any[]>(join(inputs,'schedule.json')),planned=schedule.filter(r=>r.generate);
  need(planned.length===400&&new Set(planned.map(r=>r.questionId)).size===200&&planned.every(r=>r.round===0),'Frozen generation selection differs');
  const map={'hybrid-clef':'hybrid-jev','clef-scan':'jev-scan'} as const;
  for(const row of planned)need(base.schedule.some(b=>b.generate&&b.questionId===row.questionId&&b.method===map[row.method as keyof typeof map]&&b.round===row.round),'Generation assignment differs from original');
  need(base.config.models.generation==='gpt-4.1-mini-2025-04-14','Frozen generator differs');
  const source=readJson<any>(join(retrieval,'source-snapshot.json'));
  need(hashObject(source.files)===source.hash&&source.hash===audit.implementationHash,'Retrieval implementation differs');
  const manifest={...base,id:ID,kind:'measured',phase:'test',schedule,implementationHash:source.hash,
    extension:{kind:'post-original-study-local-clef',retrievalHost:'gpu-node-spark-01',generationHost:'asus-juan',retrievalAuditSha256:sha256(readFileSync(options.audit)),amendmentSha256:audit.amendmentSha256,
      timingPolicy:audit.timingPolicy,primaryComplete:true,fullLatencyScheduleComplete:false,originalAuthorship:input.bookAnnotation,globalCapUsd:'200',cumulativeJudgeCapUsd:'80'}};
  const config=base.config,ledger=new Ledger(resolve(options.ledger),'200');
  try {
    lineage(ledger,resolve('data/research/study-budget-decisions-final-20261007.sqlite'));assertBudgets(ledger);
    need(ledger.pendingRuns().length===0,'Running ledger rows require inspection');
    mkdirSync(out,{recursive:true,mode:0o700});
    writeJson(join(out,'manifest.json'),manifest,true);immutableBytes(join(out,'datasets.json'),bytes);
    // Source snapshot identifies retrieval. Generator provenance is separate.
    writeJson(join(out,'source-snapshot.json'),source,true);ledger.freeze(`experiment:${ID}`,manifest);
    const freeze={schemaVersion:1,files:Object.fromEntries(FILES.map(name=>[name,sha256(readFileSync(name))])),generator:config.models.generation,
      configHash:hashObject(config),inputManifestSha256:audit.inputManifestSha256,retrievalAuditSha256:sha256(readFileSync(options.audit)),retrievalImplementationHash:source.hash,
      selectionCount:400,questionCount:200,globalCapUsd:'200',cumulativeJudgeCapUsd:'80',providerRetries:0,generatorPolicy:'Original generationBody and ranked-complete-deduplicated-v1 context. No prompt, model, selection or reference changes.'};
    writeJson(join(out,'generation-source-freeze.json'),freeze,true);ledger.freeze(`${ID}:generation-source-freeze`,freeze);
    for(const name of FILES)immutableBytes(join(out,sha256(name)+'.source'),readFileSync(name));
    const runs=raw.map(r=>({...r,phases:{[r.method==='hybrid-clef'?'clefRerankMs':'clefSearchMs']:r.elapsedMs}})) as ClefRun[];
    ledger.db.exec('BEGIN IMMEDIATE');
    try {for(const r of runs) {
      ledger.freeze(`${r.id}:spark-retrieval`,raw.find(x=>x.id===r.id));
      const existing=ledger.db.prepare('SELECT value FROM runs WHERE id=?').get(r.id) as {value:string}|undefined;
      if(existing)need(hashObject(JSON.parse(existing.value))===hashObject(r),'Imported retrieval changed');
      else ledger.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(r.id,r.status,JSON.stringify(r));
    }ledger.db.exec('COMMIT');}catch(e){ledger.db.exec('ROLLBACK');throw e;}
    for(const row of planned) {
      const r=runs.find(r=>r.id===row.id);need(r?.status==='completed','Scheduled generation missing successful retrieval');
      const plan=generationPlan(config,qmap.get(row.questionId)!,docs.get(row.documentId)!,r!);
      ledger.freeze(`${row.id}:generation-plan`,{payloadHash:hashObject(plan.body),contextManifest:plan.manifest});
    }
    return {ledger,manifest,config,runs,planned,docs,qmap,out,freeze};
  }catch(e){ledger.close();throw e;}
}

async function main() {
  const {values}=parseArgs({options:{inputs:{type:'string'},retrieval:{type:'string'},audit:{type:'string'},out:{type:'string'},ledger:{type:'string'},prepare:{type:'boolean'},'allow-paid':{type:'boolean'}}});
  if(!values.inputs||!values.retrieval||!values.audit||!values.out||!values.ledger||Boolean(values.prepare)===Boolean(values['allow-paid']))throw new Error('Required paths and exactly --prepare or --allow-paid');
  const lock=join(resolve(values.out),'generation.lock');
  if(values['allow-paid']) {need(!existsSync(join(resolve(values.out),'completion.json')),'Execution already terminal; do not relaunch');mkdirSync(resolve(values.out),{recursive:true});writeFileSync(lock,String(process.pid),{flag:'wx'});}
  let setup:Awaited<ReturnType<typeof prepare>>;
  try {setup=await prepare(values as Required<typeof values>);}catch(e){if(values['allow-paid'])unlinkSync(lock);throw e;}
  const {ledger,manifest,config,runs,planned,docs,qmap,out}=setup;
  if(values.prepare){ledger.close();console.log(JSON.stringify({ready:true,planned:planned.length,originalQuestions:200,paidCalls:0}));return;}
  const controller=new AbortController();let error:string|null=null,terminal=0,failures=0;
  const abort=()=>controller.abort(new Error('Generation interrupted; keep uncertain usage'));process.on('SIGINT',abort);process.on('SIGTERM',abort);
  try {
    const {config:dotenv}=await import('dotenv');dotenv({path:'data/research/api.env',quiet:true});
    need(Boolean(process.env.OPENAI_API_KEY),'Existing server-side key missing');
    for(const row of planned) {
      if(ledger.get(`${row.id}:generation-result`)){terminal++;continue;}
      controller.signal.throwIfAborted();assertBudgets(ledger);
      let result:Record<string,unknown>;
      try {const value=await generate(config,ledger,qmap.get(row.questionId)!,docs.get(row.documentId)!,runs.find(r=>r.id===row.id)!,controller.signal);result={generation:value};failures=0;}
      catch(e){result={generationError:e instanceof Error?e.message:String(e)};failures++;}
      ledger.freeze(`${row.id}:generation-result`,result);terminal++;
      writeJson(join(out,'progress.json'),{at:new Date().toISOString(),stage:'generation',terminal,planned:planned.length,budget:ledger.totals(SCOPE.runPrefix)});
      console.log(JSON.stringify({terminal,planned:planned.length,status:result.generation?'completed':'failed'}));
      if(failures>=3||controller.signal.aborted||/PROVENANCE|budget|401|402|403/i.test(String(result.generationError??'')))throw new Error('Generation halt; retain all terminal cases, no retries.');
    }
  }catch(e){error=e instanceof Error?e.message:String(e);throw e;}
  finally {
    const rows=runs.map(r=>({...r,...ledger.get<Record<string,unknown>>(`${r.id}:generation-result`)}));
    writeJson(join(out,'report.json'),{schemaVersion:1,kind:'measured',datasetHash:manifest.datasetHash,configHash:manifest.configHash,implementationHash:manifest.implementationHash,extension:manifest.extension,perQuery:rows},true);
    writeJson(join(out,'completion.json'),{at:new Date().toISOString(),allPrimaryRetrievalTerminal:true,fullTimingScheduleComplete:false,retrievalRuns:rows.length,
      generationPlanned:planned.length,generationTerminal:terminal,generationComplete:rows.filter(r=>r.generation).length,exitError:error,global:ledger.totals()},true);
    ledger.close();unlinkSync(lock);process.off('SIGINT',abort);process.off('SIGTERM',abort);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
