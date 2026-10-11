#!/usr/bin/env python3
"""Audit an explicitly stopped cohort without rewriting its original exit or plan.

No model loading, inference, paid calls, retries, or modifications to frozen code.
Every primary assignment must be terminal. Unfinished timing repeats stay separate.
"""
import argparse, datetime, hashlib, json
from pathlib import Path
from runtime import digest, identity, request_body, REVISION, MAX_TOKENS

def read(p): return json.loads(p.read_text())

def audit(inputs, out, amendment):
    source, manifest, stop = read(inputs/'manifest.json'), read(out/'manifest.json'), read(amendment)
    assert stop['kind']=='explicit-user-authorized-protocol-amendment'
    assert stop['authorization']=='Juan: detener las repeticiones y avanzar al cierre'
    assert stop['inputManifestSha256']==digest(inputs/'manifest.json')==manifest['inputManifestSha256']
    for name, sha in source['files'].items(): assert digest(inputs/name)==sha, 'Input changed: '+name
    snapshot=read(out/'source-snapshot.json')
    assert identity(snapshot['files'])==snapshot['hash']==manifest['implementationHash']
    assert manifest['environment']==read(out/'environment.json')
    assert manifest['environment']['revision']==REVISION
    assert manifest['environment']['cpuFallback'] is False and manifest['environment']['quantized'] is False
    assert read(out/'smoke-completion.json')['passed']
    assert read(out/'process.json')['pid']==stop['mainPid']
    assert not Path('/proc',str(stop['mainPid']),'cmdline').exists(), 'Inference still live'
    assert not Path('/proc',str(stop['supervisorPid']),'cmdline').exists(), 'Supervisor still live'
    assert not (out.parent/'inference.lock').exists() and not (out.parent/'continuation.lock').exists()
    assert read(out/'exit.json')['status']=='failed', 'Preserve original interrupted exit'
    assert read(out/'halt.json')['error'].startswith('KeyboardInterrupt'), 'Unexpected runner failure'
    assert read(out.parent/'continuation-exit.json')['status']=='failed'
    assert 'Test exited -2' in read(out.parent/'continuation-halt.json')['error']
    assert not (out/'completion.json').exists(), 'Do not fabricate full-cohort completion'
    schedule={r['id']:r for r in read(inputs/'schedule.json')}
    primary={k:r for k,r in schedule.items() if r['round']==0}
    assert len(primary)==stop['primaryAssignments']
    questions={q['id']:q for q in read(inputs/'questions.json')}
    docs={d['id']:read(inputs/d['path']) for d in source['documents']}
    candidates=read(inputs/'candidates.json')
    seen=set(); counts={}; calls=0; tokens=0; run_hashes={}; call_hashes={}; terminal_callnames=set()
    for path in sorted((out/'runs').glob('*.json')):
        row=read(path);ident=row['id'];assert ident in schedule and ident not in seen
        assert path.stem==hashlib.sha256(ident.encode()).hexdigest()
        seen.add(ident);run_hashes[path.name]=digest(path)
        for key,value in schedule[ident].items(): assert row[key]==value, 'Assignment changed: '+key
        counts[row['status']]=counts.get(row['status'],0)+1
        doc=docs[row['documentId']];lookup={c['id']:c for c in doc['chunks']}
        expected=candidates[ident] if row['method']=='hybrid-clef' else list(lookup)
        expected_set=set(expected);assert len(expected)==len(expected_set)
        callpath=out/'calls'/(path.stem+'.jsonl');assert callpath.exists()
        terminal_callnames.add(callpath.name);call_hashes[callpath.name]=digest(callpath)
        started={};finished={};first=[]
        for line in callpath.read_text().splitlines():
            event=json.loads(line);assert event['runId']==ident
            key=event['call']
            if event['event']=='start':
                assert key not in started;started[key]=event
                ids=[c['id'] for c in event['payload']['state']]
                assert len(ids)==len(set(ids)) and set(ids)<=expected_set
                assert event['payload']==request_body(questions[row['questionId']]['question'],[lookup[i] for i in ids]), 'Frozen payload differs or reference leaked'
                if event['level']==0:first.extend(ids)
            else:
                assert key in started and key not in finished;finished[key]=event
                if event['event']=='complete':
                    result=event['result'];assert result['payloadHash']==identity(started[key]['payload'])
                    assert 0<result['usage']['input_tokens']<=MAX_TOKENS and 0<result['commonTokens']<=MAX_TOKENS
                    assert result['apiCostUsd']=='0';tokens+=result['usage']['input_tokens']
                else:assert event['event']=='error'
        calls+=len(started);assert set(finished)<=set(started)
        if row['status']=='completed':
            assert len(first)==len(expected) and set(first)==expected_set, 'Initial coverage incomplete/duplicated'
            assert set(started)==set(finished) and all(e['event']=='complete' for e in finished.values())
            assert row['calls']==len(started)
            ranked=[r['chunkId'] for r in row['ranking']]
            assert len(ranked)==len(set(ranked))==min(5,len(expected)) and set(ranked)<=expected_set
            assert row['initialPassagesCovered']==row['initialPassages']==len(expected)
            assert row['latencyScope']==('reranking-only' if row['method']=='hybrid-clef' else 'full-scan')
            assert row['traces'][-1]['retainedIds']==ranked
    assert set(primary)<=seen, 'Primary cases missing'
    for name,sha in stop['terminalRunHashesAtStopRequest'].items(): assert run_hashes.get(name)==sha, 'Existing terminal outcome changed'
    assert {name:sha for name,sha in run_hashes.items() if read(out/'runs'/name)['round']==0}==stop['primaryRunHashes']
    assert read(out/'exit.json')['terminal']==len(seen)
    # The SIGINT can leave one active repeat without a terminal result. Preserve
    # every event and distinguish unresolved LOCAL compute from API consumption.
    interrupted=[]
    for path in sorted((out/'calls').glob('*.jsonl')):
        if path.name in terminal_callnames:continue
        events=[json.loads(line) for line in path.read_text().splitlines()];assert events
        ids={e['runId'] for e in events};assert len(ids)==1
        ident=next(iter(ids));assert ident in schedule and ident not in seen and schedule[ident]['round']>0
        assert path.stem==hashlib.sha256(ident.encode()).hexdigest()
        call_hashes[path.name]=digest(path)
        starts={};ends={}
        doc=docs[schedule[ident]['documentId']];lookup={c['id']:c for c in doc['chunks']}
        allowed=set(candidates[ident] if schedule[ident]['method']=='hybrid-clef' else lookup)
        for event in events:
            key=event['call']
            if event['event']=='start':
                assert key not in starts;starts[key]=event
                cs=[c['id'] for c in event['payload']['state']];assert len(cs)==len(set(cs)) and set(cs)<=allowed
                assert event['payload']==request_body(questions[schedule[ident]['questionId']]['question'],[lookup[i] for i in cs])
            else:
                assert key in starts and key not in ends;ends[key]=event
                if event['event']=='complete':
                    assert event['result']['payloadHash']==identity(starts[key]['payload'])
                    assert event['result']['apiCostUsd']=='0'
                else:assert event['event']=='error'
        interrupted.append({'assignment':schedule[ident],'callsStarted':len(starts),'callsFinished':len(ends),'unresolvedLocalCalls':len(starts)-len(ends),'sha256':digest(path),'status':'interrupted-by-authorized-amendment','apiCostUsd':'0','localComputeCost':'unpriced'})
    assert len(interrupted)<=1, 'Unexpected multiple active local runs'
    return {'kind':'amended-primary-cohort-integrity-audit','passed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'phase':source['phase'],'runs':len(seen),'statuses':counts,'calls':calls,'inputTokens':tokens,'apiCostUsd':'0',
            'primaryPlanned':len(primary),'primaryTerminal':len(primary),'primaryComplete':True,
            'completedTimingRepeats':len(seen-set(primary)),'omittedTimingRepeats':[schedule[k] for k in schedule if k not in seen],
            'interruptedTimingRepeats':interrupted,'timingPolicy':'Primary single-pass descriptive; planned three-round latency protocol incomplete after explicit user stop. Completed extra repeats retained, not pooled into the primary timing summary.',
            'inputManifestSha256':digest(inputs/'manifest.json'),'manifestSha256':digest(out/'manifest.json'),
            'implementationHash':manifest['implementationHash'],'environmentSha256':digest(out/'environment.json'),
            'amendmentSha256':digest(amendment),'originalExitSha256':digest(out/'exit.json'),
            'originalHaltSha256':digest(out/'halt.json'),'runHashes':run_hashes,'callHashes':call_hashes}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--inputs',type=Path,required=True);p.add_argument('--directory',type=Path,required=True);p.add_argument('--amendment',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    args=p.parse_args();result=audit(args.inputs,args.directory,args.amendment)
    with args.out.open('x') as f:json.dump(result,f,indent=2)
    print(json.dumps({k:v for k,v in result.items() if k not in ('runHashes','callHashes','omittedTimingRepeats','interruptedTimingRepeats')}))
