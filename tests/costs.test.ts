import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { costForTokens, summarizeCost, documentCosts } from '../server/costs.js';
import { Store } from '../server/store.js';
import type { Attempt } from '../shared/types.js';
function attempt(id:string,tokens?:number):Attempt{return {id,documentId:'d',jobId:'j',engine:'jev',operation:'structure',model:'jev-1.13.0',startedAt:'2026-10-02',status:tokens===undefined?'pending':'completed',inputTokens:tokens,rateUsdPerMillion:'0.042',rateDate:'2026-10-02',rateSource:'test',costUsd:tokens===undefined?null:costForTokens(tokens,'0.042')};}
test('costs preserve tiny amounts, repeated input and unknown consumption',()=>{
  assert.equal(costForTokens(1,'0.02'),'0.00000002');assert.equal(costForTokens(1,'0.042'),'0.000000042');
  assert.equal(costForTokens(100,null),null);
  const summary=summarizeCost([attempt('a',1234),attempt('b',1234),attempt('c')]);
  assert.equal(summary.knownUsd,'0.000103656');assert.equal(summary.inputTokens,2468);assert.equal(summary.unknownAttempts,1);assert.equal(summary.calls,3);
  assert.deepEqual(documentCosts([attempt('c')],[]).jev.projections,[]);
});
test('store recovery retains unknown attempts and immutable historical prices',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'jev-costs-'));const store=new Store(dir);
  try{store.startAttempt(attempt('a',100));store.startAttempt(attempt('b'));store.recoverInterrupted();
    assert.equal(store.attempts()[1].status,'unknown');assert.equal(store.attempts()[1].costUsd,null);
    assert.equal(store.attempts()[0].rateUsdPerMillion,'0.042');
    assert.throws(()=>store.startAttempt(attempt('a',100)));assert.equal(store.attempts().length,2);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
