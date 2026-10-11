import test from 'node:test';
import assert from 'node:assert/strict';
import { timingRows } from './timing.js';
import { generationPlan } from './secondary.js';
import { generationBody } from '../ragas/export.js';
import type { ResearchConfig,PreparedDocument,FrozenQuestion } from '../types.js';
test('amended timing uses every primary execution and excludes available repeats',()=>{
 const rows=[{status:'completed',round:0,timingSample:false},{status:'completed',round:0,timingSample:true},{status:'completed',round:1,timingSample:true},{status:'failed',round:0,timingSample:true}];
 assert.deepEqual(timingRows(rows,'main',true),rows.slice(0,2));
 assert.deepEqual(timingRows(rows,'main',false),rows.slice(1,3));
});
test('Clef generation reuses the exact original generator body without hidden references',()=>{
 const config={models:{generation:'gpt-4.1-mini-2025-04-14'},generation:{maxOutputTokens:700}} as ResearchConfig;
 const doc={id:'d',text:'The door opens with the red key.',blocks:[{id:'b',start:0,end:31,text:'The door opens with the red key.'}],chunks:[{id:'c',start:0,end:31,text:'The door opens with the red key.'}]} as PreparedDocument;
 const q={id:'q',documentId:'d',question:'Which key opens the door?',answer:'HIDDEN-REFERENCE-MUST-NOT-LEAK'} as FrozenQuestion;
 const run={id:'r',method:'clef-scan',ranking:[{chunkId:'c',score:1}]} as any;
 const plan=generationPlan(config,q,doc,run);
 assert.deepEqual(plan.body,generationBody(q,plan.contexts,'jev-scan',config));
 assert.ok(!JSON.stringify(plan.body).includes(q.answer));
 assert.equal(plan.manifest.policy,'ranked-complete-deduplicated-v1');
});
