import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DocumentRecord, Engine, Overview, Rating } from '../shared/types.js';
import type { EngineAdapter, RuntimeConfig } from './contracts.js';
import { publicConfig } from './config.js';
import { documentCosts, summarizeCost } from './costs.js';
import { Jobs, safeError } from './jobs.js';
import { Store } from './store.js';

const idSchema={type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[0-9a-f-]{36}$'}}} as const;
export async function buildApp(config:RuntimeConfig,adapters:Record<Engine,EngineAdapter>,providedStore?:Store) {
  const store=providedStore??new Store(config.dataDir);store.recoverInterrupted();
  const jobs=new Jobs(store,config,adapters);
  const app=Fastify({logger:false,bodyLimit:1024*1024,requestTimeout:0});
  await app.register(multipart,{limits:{fileSize:config.maxFileMb*1024*1024,files:1,fields:1}});
  await mkdir(path.join(config.dataDir,'uploads'),{recursive:true});
  app.addHook('onRequest',async(req,reply)=>{
    if(!['127.0.0.1','localhost','::1','[::1]'].includes(req.hostname))return reply.code(403).send({error:'Host no permitido.'});
    const origin=req.headers.origin;
    if(origin){let url:URL;try{url=new URL(origin);}catch{return reply.code(403).send({error:'Origen no permitido.'});}
      if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||![String(config.webPort??5174),String(config.port)].includes(url.port)||url.protocol!=='http:')return reply.code(403).send({error:'Origen no permitido.'});}
  });
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');return payload;});
  app.setErrorHandler((error,req,reply)=>{
    const err=error as Error&{code?:string;statusCode?:number};
    const status=err.statusCode??(err.code==='FST_REQ_FILE_TOO_LARGE'?413:500);
    reply.code(status).send({error:err.code==='FST_REQ_FILE_TOO_LARGE'?`Máximo ${config.maxFileMb} MB por archivo.`:safeError(err,config)});
  });
  const requireDoc=(id:string):DocumentRecord=>{const doc=store.document(id);if(!doc)throw Object.assign(new Error('Documento no encontrado.'),{statusCode:404});return doc;};
  const overview=(id:string):Overview=>{
    const document=requireDoc(id), attempts=store.attempts(id), comparisons=store.comparisons(id);
    for(const c of comparisons)for(const r of c.runs)r.cost=summarizeCost(attempts.filter(a=>a.runId===r.id));
    return {document,jobs:store.jobs(id).slice(0,20),comparisons:comparisons.slice(0,20),costs:documentCosts(attempts,comparisons),ratings:store.ratings(id)};
  };
  app.get('/api/config',async()=>publicConfig(config));
  app.get('/api/documents',async()=>store.documents());
  app.post('/api/documents',async(req,reply)=>{
    const part=await req.file();if(!part)return reply.code(400).send({error:'Selecciona un archivo.'});
    const format=path.extname(part.filename).slice(1).toLowerCase();
    if(!['pdf','docx','txt'].includes(format)){part.file.resume();return reply.code(400).send({error:'Formatos admitidos: PDF, DOCX y TXT.'});}
    const id=randomUUID();const dest=path.join(config.dataDir,'uploads',`${id}.${format}`),temp=dest+'.upload';
    try {
      await pipeline(part.file,createWriteStream(temp,{flags:'wx',mode:0o600}));
      if(part.file.truncated)throw Object.assign(new Error(`Máximo ${config.maxFileMb} MB por archivo.`),{statusCode:413});
      const file=await open(temp,'r');let size:number;const prefix=Buffer.alloc(5);
      try{size=(await file.stat()).size;await file.read(prefix,0,5,0);}finally{await file.close();}
      if(size===0)throw Object.assign(new Error('El archivo está vacío.'),{statusCode:400});
      if(format==='pdf'&&prefix.toString()!=='%PDF-')throw Object.assign(new Error('El archivo no es un PDF válido.'),{statusCode:400});
      if(format==='docx'&&prefix.subarray(0,2).toString()!=='PK')throw Object.assign(new Error('El archivo no es un DOCX válido.'),{statusCode:400});
      await rename(temp,dest);
      const document:DocumentRecord={id,name:path.basename(part.filename).slice(0,240),size,format:format as DocumentRecord['format'],createdAt:new Date().toISOString(),status:'queued',
        pageCount:0,blockCount:0,chunkCount:0,tokenCount:0,extractionComplete:false,
        engines:{jev:{status:'queued',model:config.jevModel,progress:{phase:'En cola',current:0,total:0}},rag:{status:'queued',model:config.embeddingModel,progress:{phase:'En cola',current:0,total:0}}}};
      store.saveDocument(document);jobs.createPreparation(id);return reply.code(202).send(document);
    }catch(e){await rm(temp,{force:true});if(!store.document(id))await rm(dest,{force:true});throw e;}
  });
  app.get<{Params:{id:string}}>('/api/documents/:id',{schema:{params:idSchema}},async req=>overview(req.params.id));
  app.post<{Params:{id:string}}>('/api/documents/:id/resume',{schema:{params:idSchema}},async(req,reply)=>{
    requireDoc(req.params.id);if(jobs.isActive(req.params.id))return reply.code(409).send({error:'Hay un trabajo activo.'});
    return reply.code(202).send(jobs.createPreparation(req.params.id));
  });
  app.post<{Params:{id:string};Body:{query:string;rounds?:number}}>('/api/documents/:id/search',{
    schema:{params:idSchema,body:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string',minLength:1,maxLength:2000},rounds:{type:'integer',enum:[1,5],default:1}}}},
  },async(req,reply)=>{
    const doc=requireDoc(req.params.id);const query=req.body.query.trim();
    if(!query)return reply.code(400).send({error:'Escribe una consulta.'});
    if(jobs.isActive(doc.id))return reply.code(409).send({error:'Hay un trabajo activo.'});
    if(!doc.extractionComplete||!Object.values(doc.engines).some(e=>e.status==='completed'))return reply.code(409).send({error:'Prepara al menos un motor antes de buscar.'});
    return reply.code(202).send(jobs.createSearch(doc.id,query,req.body.rounds??1));
  });
  app.post<{Params:{id:string}}>('/api/jobs/:id/cancel',{schema:{params:idSchema}},async(req,reply)=>{
    if(!store.job(req.params.id))return reply.code(404).send({error:'Trabajo no encontrado.'});return jobs.cancel(req.params.id);
  });
  app.get<{Params:{id:string}}>('/api/jobs/:id',{schema:{params:idSchema}},async(req,reply)=>store.job(req.params.id)??reply.code(404).send({error:'Trabajo no encontrado.'}));
  app.get<{Params:{id:string}}>('/api/comparisons/:id',{schema:{params:idSchema}},async(req,reply)=>store.comparison(req.params.id)??reply.code(404).send({error:'Consulta no encontrada.'}));
  app.get<{Params:{id:string};Querystring:{offset?:number;limit?:number}}>('/api/documents/:id/structure',{
    schema:{params:idSchema,querystring:{type:'object',properties:{offset:{type:'integer',minimum:0,default:0},limit:{type:'integer',minimum:1,maximum:100,default:100}}}},
  },async req=>{const doc=requireDoc(req.params.id);return {blocks:store.blocks(doc.id,req.query.offset,req.query.limit),total:doc.blockCount};});
  app.get<{Params:{id:string;chunkId:string}}>('/api/documents/:id/chunks/:chunkId',async(req,reply)=>{
    requireDoc(req.params.id);const chunk=store.chunk(req.params.chunkId);
    if(!chunk||!store.chunks(req.params.id).some(c=>c.id===chunk.id))return reply.code(404).send({error:'Fragmento no encontrado.'});
    const blocks=store.blocks(req.params.id).filter(b=>chunk.references.some(r=>r.blockId===b.id));return {chunk,blocks};
  });
  app.put<{Body:Rating}>('/api/ratings',{schema:{body:{type:'object',additionalProperties:false,required:['comparisonId','runId','chunkId','value'],properties:{comparisonId:{type:'string'},runId:{type:'string'},chunkId:{type:'string'},value:{type:'string',enum:['useful','partial','irrelevant']}}}}},async(req,reply)=>{
    const comp=store.comparison(req.body.comparisonId),run=comp?.runs.find(r=>r.id===req.body.runId);
    if(!comp||!run?.hits.some(h=>h.chunkId===req.body.chunkId))return reply.code(404).send({error:'Resultado no encontrado.'});
    store.saveRating(comp.documentId,req.body);return req.body;
  });
  app.get<{Params:{id:string}}>('/api/documents/:id/export',{schema:{params:idSchema}},async(req,reply)=>{
    const doc=requireDoc(req.params.id);
    return reply.header('Content-Disposition',`attachment; filename="comparacion-${doc.id}.json"`).send({version:1,exportedAt:new Date().toISOString(),...overview(doc.id),comparisons:store.comparisons(doc.id),attempts:store.attempts(doc.id),configuration:publicConfig(config),localResources:'Sin valorar',currency:'USD',billing:'Estimación según consumo reportado; no es una factura.'});
  });
  app.delete<{Params:{id:string}}>('/api/documents/:id',{schema:{params:idSchema}},async(req,reply)=>{
    const doc=requireDoc(req.params.id);if(jobs.isActive(doc.id))return reply.code(409).send({error:'Cancela el trabajo y espera a que termine.'});
    await Promise.all(Object.values(adapters).map(a=>a.delete(doc.id)));
    await rm(path.join(config.dataDir,'uploads',`${doc.id}.${doc.format}`),{force:true});
    store.removeDocument(doc.id);return {ok:true};
  });
  const dist=path.resolve('dist');
  if(existsSync(path.join(dist,'index.html'))){
    await app.register(fastifyStatic,{root:dist,index:'index.html',list:false});
    app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'Ruta no encontrada.'}):reply.sendFile('index.html'));
  }
  app.addHook('onClose',async()=>{await jobs.shutdown();if(!providedStore)store.close();});
  return {app,store,jobs};
}
