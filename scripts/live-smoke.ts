import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../server/config.js';
import { createEngines } from '../server/engines/index.js';
import { extractInWorker } from '../server/extraction-client.js';
import { summarizeCost } from '../server/costs.js';
import { Store } from '../server/store.js';
import type { Engine } from '../shared/types.js';
import type { WorkContext } from '../server/contracts.js';

// Opt-in integration test: calls real provider APIs and incurs a small API cost.
const dir=await mkdtemp(path.join(tmpdir(),'jev-live-'));
const config={...readConfig(),dataDir:dir};
const store=new Store(dir);
const adapters=createEngines(config);
const id=randomUUID();
try{
  const file=path.join(dir,'document.txt');
  await writeFile(file,'Observatorio\n\nEl Observatorio del Valle abrió sus puertas en 1987. Su telescopio principal tiene un espejo de dos metros.\n\nVisitas\n\nLas visitas guiadas se realizan los sábados.');
  const extraction=await extractInWorker(file,'txt',id,config,{signal:new AbortController().signal,onProgress:()=>{}});
  for(const engine of ['jev','rag'] as Engine[]){
    if(!(engine==='jev'?config.typesafeApiKey:config.openaiApiKey)){console.log(`${engine}: omitido, falta la clave.`);continue;}
    const context:WorkContext={documentId:id,jobId:randomUUID(),config,signal:new AbortController().signal,progress:()=>{},
      attempts:{start:a=>store.startAttempt(a),finish:(id,p)=>store.finishAttempt(id,p)},
      checkpoint:(key,value)=>store.checkpoint(id,engine+':'+key,value),getCheckpoint:<T>(key:string)=>store.getCheckpoint<T>(id,engine+':'+key)};
    const prepared=await adapters[engine].prepare(extraction.blocks,extraction.chunks,context);
    const result=await adapters[engine].search('¿En qué año abrió el observatorio?',prepared.chunks??extraction.chunks,{...context,runId:randomUUID()});
    assert.ok(result.hits.length>0);assert.ok(result.hits.some(hit=>hit.text.includes('1987')));assert.equal(result.metrics.chunksCovered,extraction.chunks.length);
    const costs=summarizeCost(store.attempts(id).filter(a=>a.engine===engine));
    console.log(`${engine}: OK · ${result.hits.length} resultados · ${costs.calls} llamadas · USD ${costs.knownUsd}${costs.unknownAttempts?' + consumo desconocido':''}`);
    await adapters[engine].delete(id);
  }
}finally{store.close();await rm(dir,{recursive:true,force:true});}
