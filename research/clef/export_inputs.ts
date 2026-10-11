/** Read-only export of frozen source passages and shared candidate IDs; no providers. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { combineBundles, type ExperimentManifest } from '../runner.js';
import { prepareDocument } from '../datasets.js';
import { hashObject, sha256, shuffled } from '../util.js';
import type { DatasetBundle, RankedChunk } from '../types.js';
const phase=process.argv[2]; if(phase!=='pilot'&&phase!=='main')throw new Error('pilot or main required');
const sourceId=phase==='pilot'?'gb10-book-combined-pilot-20261004-v1':'gb10-main-study-20261004-v1';
const source=resolve('data/research',sourceId),out=resolve('data/research/clef-spark-inputs-20261007',phase);
if(existsSync(out))throw new Error('Export already exists; do not overwrite');
const sourceManifest=readFileSync(join(source,'manifest.json')),datasetsBytes=readFileSync(join(source,'datasets.json'));
const pins=phase==='pilot'?['f62e0803b7e558049bd75c1715aad1d0ab8b1fdff4e706b3f61e9411b425b974','7328dfcf4f9bd57bf9efbbe6f7486af7b41f65e6634830062ad597d92ab5f24e']:['c23046281d0464ec072e5cec7ea477c8fa7c0b5d4e860a135f4bb3a26352f9f7','59d9dcfe479f9fe3ca30ed723da933609468e275bfd6f6d7ab09cd2ef38843e1'];
if(sha256(sourceManifest)!==pins[0]||sha256(datasetsBytes)!==pins[1])throw new Error('Frozen source changed');
const base=JSON.parse(sourceManifest.toString()) as ExperimentManifest,bundles=JSON.parse(datasetsBytes.toString()) as DatasetBundle[];
const combined=combineBundles(bundles),{questions,sources,documents}=combined;
if(sources.some(s=>s.split!==(phase==='pilot'?'development':'test')))throw new Error('Split leakage');
const map={'hybrid-jev':'hybrid-clef','jev-scan':'clef-scan'} as const;
const sourceByDoc=new Map(sources.map(s=>[s.documentId,s]));
const selected=phase==='main'?questions:[...shuffled(questions.filter(q=>sourceByDoc.get(q.documentId)!.corpus==='qasper-development'),42).slice(0,6),...[...new Set(sources.filter(s=>s.corpus==='openstax-development').map(s=>s.documentId))].sort().flatMap(id=>shuffled(questions.filter(q=>q.documentId===id),42).slice(0,2))];
const selectedIds=new Set(selected.map(q=>q.id));
const schedule=phase==='main'?base.schedule.filter(r=>r.method in map).map(r=>({...r,method:map[r.method as keyof typeof map]})):shuffled(selected,42).flatMap((q,i)=>shuffled(Object.values(map),42+i).map(method=>({id:'',questionId:q.id,documentId:q.documentId,corpus:sourceByDoc.get(q.documentId)!.corpus,method,round:0,timingSample:false,generate:true})));
const db=new DatabaseSync(resolve('data/research/study-budget-decisions-final-20261007.sqlite'),{readOnly:true});
mkdirSync(join(out,'documents'),{recursive:true});const files:Record<string,string>={};
const save=(name:string,value:unknown)=>{const body=JSON.stringify(value)+'\n';writeFileSync(join(out,name),body,{flag:'wx',mode:0o600});files[name]=sha256(body);};
const candidateMap:Record<string,string[]>={};
for(const row of schedule){
 row.id=`clef-spark-20261007-v1:${phase}:${hashObject([row.questionId,row.method,row.round]).slice(0,24)}`;
 if(row.method!=='hybrid-clef')continue;
 const key=`${sourceId}:shared50:${row.questionId}:${row.round}`,value=db.prepare('SELECT value,hash FROM immutable WHERE key=?').get(key) as {value:string;hash:string}|undefined;
 if(!value)throw new Error('Missing original candidate checkpoint '+key);
 const parsed=JSON.parse(value.value) as RankedChunk[];if(hashObject(parsed)!==value.hash)throw new Error('Candidate hash differs');
 candidateMap[row.id]=parsed.map(c=>c.chunkId);
}
const needed=new Set(selected.map(q=>q.documentId)),docRecords=[];
for(const d of documents.filter(d=>needed.has(d.id))){
 const prepared=await prepareDocument(d,base.config.chunkTokens,base.config.overlapTokens,base.config.maxDocumentTokens);
 const ids=new Set(prepared.chunks.map(c=>c.id));
 for(const row of schedule.filter(r=>r.documentId===d.id&&r.method==='hybrid-clef'))if(candidateMap[row.id].some(id=>!ids.has(id)))throw new Error('Recomputed chunk IDs differ');
 const filename='documents/'+sha256(d.id)+'.json';save(filename,prepared);docRecords.push({id:d.id,title:d.title,path:filename,sourceHash:d.hash,preparedHash:files[filename],chunks:prepared.chunks.length,tokenCount:prepared.tokenCount});
 console.log(JSON.stringify({document:docRecords.length,total:needed.size,chunks:prepared.chunks.length}));
}
save('questions.json',selected);save('candidates.json',candidateMap);save('schedule.json',schedule);
save('source-manifest.json',base);
save('manifest.json',{schemaVersion:1,kind:'frozen-clef-input-export',phase,sourceId,sourceManifestSha256:pins[0],datasetsSha256:pins[1],datasetHash:combined.datasetHash,sourceSnapshotSha256:sha256(readFileSync('research/clef/export_inputs.ts')),bookAnnotation:base.bookAnnotation,files:{...files},documents:docRecords,questions:selectedIds.size,scheduled:schedule.length,hybridCandidatePolicy:'Exact ordered original shared50 checkpoint; supplied to reranker in document order. Candidate generation latency is excluded and must not be called full hybrid latency.'});
db.close();console.log(JSON.stringify({out,questions:selectedIds.size,scheduled:schedule.length,manifestSha256:files['manifest.json']}));
