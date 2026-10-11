import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type { Block, Chunk, Comparison, DocumentRecord, Engine, EngineRun, Job, RunMetrics, Status } from '../shared/types.js';
import type { EngineAdapter, RuntimeConfig, WorkContext } from './contracts.js';
import { extractInWorker } from './extraction-client.js';
import { Store } from './store.js';
import { summarizeCost } from './costs.js';

const engines: Engine[] = ['jev', 'rag'];
const terminal = (s: Status) => !['queued','running'].includes(s);
export const emptyMetrics = (concurrency: number): RunMetrics => ({ calls:0,inputTokens:0,windowsTotal:0,windowsCompleted:0,chunksTotal:0,chunksCovered:0,reductionLevels:0,concurrency });
export function safeError(error: unknown, config: RuntimeConfig): string {
  let message = error instanceof Error ? error.message : 'No se pudo completar la operación.';
  for (const secret of [config.openaiApiKey,config.typesafeApiKey]) if(secret) message=message.split(secret).join('[clave]');
  return message.slice(0,600);
}
export class Jobs {
  private pending: string[]=[];
  private controllers=new Map<string,AbortController>();
  private busy=false;
  private closing=false;
  constructor(private store: Store, private config: RuntimeConfig, private adapters: Record<Engine,EngineAdapter>) {}
  isActive(docId: string): boolean { return this.store.jobs(docId).some(j=>!terminal(j.status)||this.controllers.has(j.id)); }
  createPreparation(documentId: string): Job { return this.enqueue({documentId,kind:'prepare'}); }
  createSearch(documentId: string, query: string, rounds: number): {job:Job;comparison:Comparison} {
    const comp:Comparison={id:randomUUID(),documentId,query,rounds,createdAt:new Date().toISOString(),status:'queued',runs:[]};
    for(let round=1;round<=rounds;round++) for(const engine of engines) comp.runs.push({
      id:randomUUID(),engine,round,status:'queued',model:engine==='jev'?this.config.jevModel:this.config.embeddingModel,
      progress:{phase:'En cola',current:0,total:0},hits:[],metrics:emptyMetrics(this.config.concurrency),cost:summarizeCost([]),
    });
    this.store.saveComparison(comp);
    return {job:this.enqueue({documentId,kind:rounds===5?'benchmark':'search',comparisonId:comp.id}),comparison:comp};
  }
  private enqueue(input: Pick<Job,'documentId'|'kind'|'comparisonId'>): Job {
    if(this.closing) throw new Error('Servidor detenido.');
    if(this.isActive(input.documentId)) throw new Error('Ya hay una operación activa para este documento.');
    const now=new Date().toISOString();
    const job:Job={...input,id:randomUUID(),status:'queued',createdAt:now,updatedAt:now,progress:{phase:'En cola',current:0,total:0}};
    this.store.saveJob(job); this.pending.push(job.id);
    setImmediate(()=>void this.pump());
    return job;
  }
  private scope(engine: Engine): string {
    return createHash('sha256').update(JSON.stringify({v:1,engine,model:engine==='jev'?this.config.jevModel:this.config.embeddingModel,
      chunk:this.config.chunkTokens,overlap:this.config.overlapTokens,window:engine==='jev'?this.config.jevWindowTokens:0})).digest('hex').slice(0,20);
  }
  private context(job: Job, engine: Engine, controller: AbortController, run?: EngineRun): WorkContext {
    const prefix=this.scope(engine)+':';
    return {documentId:job.documentId,jobId:job.id,runId:run?.id,config:this.config,signal:controller.signal,
      attempts:{ start:a=>this.store.startAttempt(a), finish:(id,p)=>this.store.finishAttempt(id,p) },
      checkpoint:(key,value)=>this.store.checkpoint(job.documentId,prefix+key,value),
      getCheckpoint:<T>(key:string)=>this.store.getCheckpoint<T>(job.documentId,prefix+key),
      progress:progress=>{
        if(controller.signal.aborted) return;
        if(run&&job.comparisonId) this.store.updateComparison(job.comparisonId,c=>{
          const r=c.runs.find(r=>r.id===run.id)!; r.progress=progress;
          r.cost=summarizeCost(this.store.attempts(job.documentId).filter(a=>a.runId===r.id));
        });
        else this.store.updateDocument(job.documentId,d=>{d.engines[engine].progress=progress;});
      },
    };
  }
  private async pump(): Promise<void> {
    if(this.busy||this.closing) return;
    const id=this.pending.shift(); if(!id)return;
    const job=this.store.job(id); if(!job||terminal(job.status)){setImmediate(()=>void this.pump());return;}
    this.busy=true;const controller=new AbortController();this.controllers.set(id,controller);
    this.store.updateJob(id,j=>{j.status='running';});
    try {
      const status=job.kind==='prepare'?await this.prepare(job,controller):await this.search(job,controller);
      this.store.updateJob(id,j=>{j.status=controller.signal.aborted?'cancelled':status;});
    } catch(error) {
      const status=controller.signal.aborted?'cancelled':'failed';const message=safeError(error,this.config);
      this.store.updateJob(id,j=>{j.status=status;j.error=message;});
      if(job.kind==='prepare') this.store.updateDocument(job.documentId,d=>{d.status=status;d.error=message;for(const p of Object.values(d.engines))if(!terminal(p.status)){p.status=status;p.error=message;}});
      if(job.comparisonId) this.store.updateComparison(job.comparisonId,c=>{c.status=status;for(const r of c.runs) if(!terminal(r.status)){r.status=status;r.error=message;}});
    } finally {this.controllers.delete(id);this.busy=false;setImmediate(()=>void this.pump());}
  }
  private async prepare(job: Job,controller: AbortController): Promise<Status> {
    const id=job.documentId;
    this.store.updateDocument(id,d=>{d.status='running';delete d.error;});
    let doc=this.store.document(id)!;
    const extractionKey=JSON.stringify([this.config.chunkTokens,this.config.overlapTokens]);
    if(!doc.extractionComplete||this.store.getCheckpoint(id,'extractionConfig')!==extractionKey) {
      this.store.clearExtraction(id);
      this.store.updateDocument(id,d=>{d.extractionComplete=false;for(const e of engines)d.engines[e].status='queued';});
      const start=performance.now();
      try {
        const result=await extractInWorker(path.join(this.config.dataDir,'uploads',`${id}.${doc.format}`),doc.format,id,this.config,{
          signal:controller.signal,
          onProgress:progress=>this.store.updateJob(job.id,j=>{j.progress=progress;}),
          onBlocks:blocks=>this.store.saveBlocks(id,blocks),
        });
        controller.signal.throwIfAborted();
        this.store.saveBlocks(id,result.blocks);this.store.saveChunks(id,result.chunks);
        this.store.checkpoint(id,'extractionConfig',extractionKey);
        this.store.updateDocument(id,d=>{d.extractionComplete=true;d.blockCount=result.blocks.length;d.chunkCount=result.chunks.length;d.pageCount=result.pageCount;d.tokenCount=result.tokenCount;d.extractionMs=performance.now()-start;d.warnings=result.warnings;});
      }catch(e){this.store.clearExtraction(id);throw e;}
    }
    doc=this.store.document(id)!;
    const blocks=this.store.blocks(id),chunks=this.store.chunks(id);
    this.store.updateJob(job.id,j=>{j.progress={phase:'Preparando',current:0,total:2};});
    await Promise.all(engines.map(async engine=>{
      const model=engine==='jev'?this.config.jevModel:this.config.embeddingModel;
      const previous=this.store.getCheckpoint<string>(id,`ready:${engine}`);
      const signature=this.scope(engine);
      if(doc.engines[engine].status==='completed'&&previous===signature)return;
      const context=this.context(job,engine,controller);
      const start=performance.now();
      this.store.updateDocument(id,d=>{d.engines[engine]={status:'running',model,progress:{phase:'Preparando',current:0,total:chunks.length}};});
      try {
        if(previous&&previous!==signature) await this.adapters[engine].delete(id);
        const result=await this.adapters[engine].prepare(blocks,chunks,context);
        controller.signal.throwIfAborted();
        if(result.blocks)this.store.saveBlocks(id,result.blocks);
        if(result.chunks)this.store.saveChunks(id,result.chunks);
        this.store.checkpoint(id,`ready:${engine}`,signature);
        this.store.updateDocument(id,d=>{d.engines[engine]={status:'completed',model,elapsedMs:performance.now()-start,progress:{phase:'Listo',current:chunks.length,total:chunks.length}};});
      }catch(error){
        this.store.updateDocument(id,d=>{d.engines[engine]={...d.engines[engine],status:controller.signal.aborted?'cancelled':'failed',elapsedMs:performance.now()-start,error:safeError(error,this.config)};});
      }
      const done=Object.values(this.store.document(id)!.engines).filter(p=>terminal(p.status)).length;
      this.store.updateJob(job.id,j=>{j.progress={phase:'Preparando',current:done,total:2};});
    }));
    const states=Object.values(this.store.document(id)!.engines).map(p=>p.status);
    const status:Status=controller.signal.aborted?'cancelled':states.every(s=>s==='completed')?'completed':'failed';
    this.store.updateDocument(id,d=>{d.status=status;});return status;
  }
  private async search(job:Job,controller:AbortController):Promise<Status> {
    const comp=this.store.comparison(job.comparisonId!)!;
    this.store.updateComparison(comp.id,c=>{c.status='running';});
    const chunks=this.store.chunks(job.documentId);
    for(let round=1;round<=comp.rounds;round++) {
      if(controller.signal.aborted)break;
      this.store.updateJob(job.id,j=>{j.progress={phase:comp.rounds===5?'Repitiendo':'Buscando',current:round-1,total:comp.rounds};});
      await Promise.all(comp.runs.filter(r=>r.round===round).map(async run=>{
        const start=performance.now();
        this.store.updateComparison(comp.id,c=>{const r=c.runs.find(r=>r.id===run.id)!;r.status='running';r.startedAt=new Date().toISOString();});
        try {
          const doc=this.store.document(job.documentId)!;
          if(doc.engines[run.engine].status!=='completed')throw new Error('La preparación de este motor no está completa.');
          if(this.store.getCheckpoint(job.documentId,`ready:${run.engine}`)!==this.scope(run.engine))throw new Error('La configuración cambió. Reprocesa el documento.');
          const output=await this.adapters[run.engine].search(comp.query,chunks,this.context(job,run.engine,controller,run));
          controller.signal.throwIfAborted();
          this.store.updateComparison(comp.id,c=>{const r=c.runs.find(r=>r.id===run.id)!;Object.assign(r,output);r.status='completed';r.progress={phase:'Listo',current:output.metrics.chunksCovered,total:chunks.length};});
        }catch(error){
          this.store.updateComparison(comp.id,c=>{const r=c.runs.find(r=>r.id===run.id)!;r.status=controller.signal.aborted?'cancelled':'failed';r.error=safeError(error,this.config);
            if(error&&typeof error==='object'&&'metrics'in error)r.metrics=(error as {metrics:RunMetrics}).metrics;
          });
        }finally{
          this.store.updateComparison(comp.id,c=>{const r=c.runs.find(r=>r.id===run.id)!;r.elapsedMs=performance.now()-start;r.finishedAt=new Date().toISOString();r.cost=summarizeCost(this.store.attempts(job.documentId).filter(a=>a.runId===run.id));r.metrics.calls=r.cost.calls;r.metrics.inputTokens=r.cost.inputTokens;});
        }
      }));
      this.store.updateJob(job.id,j=>{j.progress.current=round;});
    }
    const current=this.store.comparison(comp.id)!;
    const status:Status=controller.signal.aborted?'cancelled':current.runs.every(r=>r.status==='completed')?'completed':'failed';
    this.store.updateComparison(comp.id,c=>{c.status=status;for(const r of c.runs)if(r.status==='queued'){r.status='cancelled';r.error='Cancelado.';}});
    return status;
  }
  cancel(id:string):Job {
    const j=this.store.job(id);if(!j)throw new Error('Trabajo no encontrado.');
    if(terminal(j.status))return j;
    const controller=this.controllers.get(id);
    if(controller){controller.abort(new Error('Cancelado.'));return this.store.updateJob(id,j=>{j.progress={...j.progress,phase:'Cancelando'};});}
    const result=this.store.updateJob(id,j=>{j.status='cancelled';});
    if(j.status==='queued') {
      if(j.comparisonId)this.store.updateComparison(j.comparisonId,c=>{c.status='cancelled';for(const r of c.runs)r.status='cancelled';});
      else this.store.updateDocument(j.documentId,d=>{d.status='cancelled';for(const p of Object.values(d.engines))if(!terminal(p.status))p.status='cancelled';});
    }
    return result;
  }
  async shutdown():Promise<void> {
    this.closing=true;
    for(const c of this.controllers.values())c.abort(new Error('Servidor detenido.'));
    while(this.busy)await new Promise(r=>setTimeout(r,30));
  }
}
