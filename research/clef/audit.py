#!/usr/bin/env python3
"""Offline technical audit. No model inference, providers, or retries."""
import argparse,json,datetime
from pathlib import Path
from runtime import digest,identity,request_body,REVISION,MAX_TOKENS

def read(path):return json.loads(Path(path).read_text())
def audit(inputs,out):
    source=read(inputs/'manifest.json');manifest=read(out/'manifest.json')
    for name,sha in source['files'].items():
        assert digest(inputs/name)==sha, f'Input changed: {name}'
    assert digest(inputs/'manifest.json')==manifest['inputManifestSha256']
    snapshot=read(out/'source-snapshot.json')
    assert identity(snapshot['files'])==snapshot['hash']==manifest['implementationHash']
    assert manifest['environment']['revision']==REVISION
    assert manifest['environment']['cpuFallback'] is False
    assert manifest['environment']['quantized'] is False
    assert read(out/'exit.json')['status']=='completed', 'Cohort not closed'
    completion=read(out/'completion.json');assert completion['allRetrievalTerminal']
    assert completion['terminal']==completion['planned']==source['scheduled']
    assert read(out/'smoke-completion.json')['passed']
    schedule={r['id']:r for r in read(inputs/'schedule.json')}
    questions={q['id']:q for q in read(inputs/'questions.json')}
    docs={d['id']:read(inputs/d['path']) for d in source['documents']}
    candidates=read(inputs/'candidates.json');seen=set();counts={};calls=0;tokens=0;run_hashes={};call_hashes={}
    for path in sorted((out/'runs').glob('*.json')):
        row=read(path);assert row['id'] in schedule and row['id'] not in seen
        seen.add(row['id']);run_hashes[path.name]=digest(path)
        for k,v in schedule[row['id']].items():assert row[k]==v, f'Assignment changed: {k}'
        counts[row['status']]=counts.get(row['status'],0)+1
        doc=docs[row['documentId']];lookup={c['id']:c for c in doc['chunks']}
        expected=candidates[row['id']] if row['method']=='hybrid-clef' else list(lookup)
        expected_set=set(expected);assert len(expected)==len(expected_set)
        callpath=out/'calls'/(path.stem+'.jsonl');events=[json.loads(l) for l in callpath.read_text().splitlines()] if callpath.exists() else []
        if callpath.exists():call_hashes[callpath.name]=digest(callpath)
        started={};finished={};first=[]
        for event in events:
            assert event['runId']==row['id']
            key=event['call']
            if event['event']=='start':
                assert key not in started;started[key]=event
                ids=[c['id'] for c in event['payload']['state']]
                assert len(ids)==len(set(ids)) and set(ids)<=expected_set
                assert event['payload']==request_body(questions[row['questionId']]['question'],[lookup[i] for i in ids]), 'Request differs from frozen source'
                if event['level']==0:first.extend(ids)
            else:
                assert key in started and key not in finished;finished[key]=event
                if event['event']=='complete':
                    result=event['result'];assert result['payloadHash']==identity(started[key]['payload'])
                    assert 0<result['usage']['input_tokens']<=MAX_TOKENS
                    assert 0<result['commonTokens']<=MAX_TOKENS
                    assert result['apiCostUsd']=='0'
                    tokens+=result['usage']['input_tokens']
                else:assert event['event']=='error'
        calls+=len(started)
        assert set(finished)<=set(started)
        if row['status']=='completed':
            assert len(first)==len(expected) and set(first)==expected_set, 'Incomplete or duplicated first pass'
            assert set(started)==set(finished) and all(e['event']=='complete' for e in finished.values())
            assert row['calls']==len(started)
            ranked=[r['chunkId'] for r in row['ranking']]
            assert len(ranked)==len(set(ranked))==min(5,len(expected)) and set(ranked)<=expected_set
            assert row['initialPassagesCovered']==row['initialPassages']==len(expected)
            assert row['latencyScope']==('reranking-only' if row['method']=='hybrid-clef' else 'full-scan')
            assert row['traces'][-1]['retainedIds']==ranked
    assert seen==set(schedule) and counts==completion['statuses']
    return {'kind':'technical-integrity-audit-not-quality-selection','passed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'phase':source['phase'],'runs':len(seen),'statuses':counts,'calls':calls,'inputTokens':tokens,'apiCostUsd':'0',
            'inputManifestSha256':digest(inputs/'manifest.json'),'manifestSha256':digest(out/'manifest.json'),
            'implementationHash':manifest['implementationHash'],'environmentSha256':digest(out/'environment.json'),
            'completionSha256':digest(out/'completion.json'),'runHashes':run_hashes,'callHashes':call_hashes}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--inputs',type=Path,required=True);p.add_argument('--directory',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--pilot-gate',type=Path)
    args=p.parse_args();result=audit(args.inputs,args.directory)
    with args.out.open('x') as f:json.dump(result,f,indent=2)
    if args.pilot_gate:
        assert result['phase']=='pilot' and result['statuses']=={'completed':20}, 'Pilot must have twenty terminal successful searches'
        gate={'accepted':True,'basis':'Technical integrity only; no retrieval-quality threshold or test-informed tuning.',
              'at':result['at'],'implementationHash':result['implementationHash'],'auditSha256':digest(args.out),
              'inputManifestSha256':result['inputManifestSha256'],'environmentSha256':result['environmentSha256']}
        with args.pilot_gate.open('x') as f:json.dump(gate,f,indent=2)
    print(json.dumps({k:v for k,v in result.items() if k not in ('runHashes','callHashes')}))
