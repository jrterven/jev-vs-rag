import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../ledger.js';
import { readJson } from '../util.js';
import type { ExperimentManifest } from '../runner.js';
import type { Chunk } from '../../shared/types.js';
import { tokenCount } from '../../server/engines/common.js';
import { requestBody, parseAnswer, searchDecisions, EXTENSION, DECISIONS_MODEL, NONE } from './adapter-v2.js';
const config = readJson<ExperimentManifest>(process.env.DECISIONS_BASE_MANIFEST ?? 'output/gb10-main-study-20261004-v1/manifest.json').config;
const chunk = (n: number): Chunk => ({ id: 'c' + n, ordinal: n, text: `Topic ${n}. ` + 'document "quotation" '.repeat(150), start: n * 4000, end: n * 4000 + 3000, path: [], references: [] });
function fixture() { const path = mkdtempSync(join(tmpdir(), 'decisions-v2-test-')); const ledger = new Ledger(join(path, 'ledger.sqlite')); return { ledger, close: () => { ledger.close(); rmSync(path, { recursive: true, force: true }); } }; }
function data(ids: string[]) { return { model: DECISIONS_MODEL, answers: [{ name: 'where', type: 'choice', choice: ids.at(-1), probabilities: [...ids.map((value, i) => ({ value, probability: i === ids.length - 1 ? 0.6 : 0 })), { value: NONE, probability: 0.4 }] }, { name: 'exists', type: 'predicate', probability: 0.7 }], usage: { input_tokens: 100, output_tokens: 0, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 } } }; }
test('singleton uses two legal options; fallback excluded without renormalizing', () => {
  assert.equal((requestBody('q',[chunk(0)]).questions[0] as any).choices.length, 2);
  assert.equal(parseAnswer(data(['c0']),['c0']).scores.get('c0'),0.6);
  assert.throws(() => parseAnswer({ ...data(['c0']), answers: [{ type:'refusal' }, { type:'predicate' }] },['c0']), /DECISIONS_REFUSAL/);
  assert.throws(() => parseAnswer(data(['c0','c0']),['c0','c1']));
});
test('native packing preserves every quoted source passage across multilevel reductions', async () => {
  const f=fixture();process.env.OPENAI_API_KEY='test'; let calls=0;
  try {
    const chunks=Array.from({length:200},(_,i)=>chunk(i));
    const r=await searchDecisions({config,ledger:f.ledger,runId:`${EXTENSION}:v2:test:packing`,documentId:'doc',method:'decisions-scan',chunks,query:'topic?',signal:new AbortController().signal,allowPaid:true,fetcher:async(url,init)=>{
      assert.equal(url,'https://api.openai.com/v1/decisions');const body=JSON.parse(String(init?.body));assert.ok(tokenCount(JSON.stringify(body))<=12000);const items=JSON.parse(body.input);assert.ok(body.questions[0].choices.length>=2);for(const item of items)assert.equal(item.text,chunks.find(c=>c.id===item.id)!.text);calls++;return Response.json(data(items.map((i:any)=>i.id)));
    }});
    const initial=r.traces.filter(t=>t.stage==='window').flatMap(t=>t.candidateIds);assert.equal(initial.length,200);assert.equal(new Set(initial).size,200);assert.equal(r.ranking.length,5);assert.equal(r.ranking[0].chunkId,'c199');assert.ok(r.traces.some(t=>t.stage==='final'&&t.level!>=2));assert.ok(r.ranking.every(r=>r.chunkId!==NONE));assert.equal(f.ledger.attempts().length,calls);assert.ok(f.ledger.attempts().every(a=>a.costUsd==='0.00001'));
  }finally{f.close();}
});
test('provider refusal is a paid terminal outcome, not zero relevance or a retry',async()=>{
 const f=fixture();process.env.OPENAI_API_KEY='test';let calls=0;
 const opts={config,ledger:f.ledger,runId:`${EXTENSION}:v2:test:refusal`,documentId:'doc',method:'decisions-scan' as const,chunks:[chunk(0)],query:'q',signal:new AbortController().signal,allowPaid:true,fetcher:async()=>{calls++;return Response.json({...data(['c0']),answers:[{type:'refusal',name:'where'},{type:'predicate',name:'exists',probability:0}]});}};
 try{await assert.rejects(searchDecisions(opts),/DECISIONS_REFUSAL/);await assert.rejects(searchDecisions(opts),/no automatic retry/);assert.equal(calls,1);assert.equal(f.ledger.attempts()[0].costUsd,'0.00001');}finally{f.close();}
});
