#!/usr/bin/env python3
"""One-shot local Clef retrieval cohort. Immutable outputs; never resume terminal calls."""
from __future__ import annotations
import argparse,datetime,hashlib,json,os,platform,signal,subprocess,sys,time,traceback
from pathlib import Path
from runtime import ClefRuntime,digest,identity,request_body,gpu_snapshot
from search import search
ROOT=Path(__file__).resolve().parents[2]

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def write(path,value,exclusive=False):
    path=Path(path);data=json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n'
    if exclusive:
        with path.open('x') as f:f.write(data);f.flush();os.fsync(f.fileno())
    else:
        tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(data);tmp.replace(path)

def smoke(runtime,out):
    # Technical fixtures only, not benchmark evidence or paper measurements.
    chunks=[{'id':'passage-a','ordinal':0,'path':[],'text':'The warehouse access code is LIMA-731. The access code opens the delivery door.'},
            {'id':'passage-b','ordinal':1,'path':[],'text':'The conference takes place on Tuesday. Coffee is served in the lobby.'}]
    short=runtime.evaluate(request_body('What code opens the delivery door?',chunks))
    write(out/'smoke-short.json',short,True)
    if short['answers']['where']['choice']!='passage-a':raise RuntimeError('Short technical probe did not recover explicit fact')
    # Build an input near the 12k preventive limit; the fact appears at the end.
    filler='This paragraph describes routine inventory checks, delivery schedules, and office supplies. '
    long=[{'id':f'p{i:03}','ordinal':i,'path':[],'text':filler*24} for i in range(40)]
    group=runtime.encoder.pack('What code opens the delivery door?',long)[0]
    group[-1]={**group[-1],'text':group[-1]['text']+' The warehouse access code is LIMA-731. The access code opens the delivery door.'}
    while not runtime.encoder.fits('What code opens the delivery door?',group):group.pop(0)
    result=runtime.evaluate(request_body('What code opens the delivery door?',group));write(out/'smoke-long.json',result,True)
    if result['answers']['where']['choice']!=group[-1]['id']:raise RuntimeError('Long technical probe did not recover the final explicit fact')
    receipt={'kind':'technical-fixtures-not-study-results','shortTokens':short['usage']['input_tokens'],'longTokens':result['usage']['input_tokens'],
             'shortCallMs':short['callMs'],'longCallMs':result['callMs'],'maxAllocatedBytes':max(short['maxAllocatedBytes'],result['maxAllocatedBytes']),
             'passed':True,'allParametersCUDA':True,'at':now()}
    write(out/'smoke-completion.json',receipt,True);print(json.dumps({'stage':'smoke',**receipt}),flush=True)

def run(args):
    inputdir=args.inputs.resolve();input_manifest=json.loads((inputdir/'manifest.json').read_text())
    for name,h in input_manifest['files'].items():
        if digest(inputdir/name)!=h:raise ValueError('Input hash changed: '+name)
    phase=input_manifest['phase']
    if phase=='main':
        if not args.pilot_gate:raise ValueError('Main cohort requires a reviewed technical pilot gate')
        gate=json.loads(args.pilot_gate.read_text())
        if not gate.get('accepted'):raise ValueError('Pilot gate not accepted')
    sources={p.name:p.read_text() for p in [Path(__file__),Path(__file__).with_name('runtime.py'),Path(__file__).with_name('search.py')]}
    codehash=identity(sources)
    if phase=='main' and gate['implementationHash']!=codehash:raise ValueError('Pilot implementation changed')
    out=args.out.resolve()
    if out.exists():raise FileExistsError('Run directory already exists. Audit rather than rerun or overwrite.')
    out.mkdir(parents=True);(out/'runs').mkdir();(out/'calls').mkdir()
    lock=ROOT/'output/clef-spark-20261007/inference.lock'
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,str(os.getpid()).encode());os.close(fd)
    write(out/'process.json',{'pid':os.getpid(),'startedAt':now(),'phase':phase},True)
    write(out/'source-snapshot.json',{'hash':codehash,'files':sources},True)
    started=now();status='failed';terminal=0;failures=0
    try:
        write(out/'progress.json',{'stage':'loading','updatedAt':now(),'terminal':0})
        runtime=ClefRuntime(args.model_root)
        environment=runtime.environment
        write(out/'environment.json',environment,True)
        schedule=json.loads((inputdir/'schedule.json').read_text());questions={q['id']:q for q in json.loads((inputdir/'questions.json').read_text())}
        candidates=json.loads((inputdir/'candidates.json').read_text());documents={d['id']:d for d in input_manifest['documents']}
        write(out/'manifest.json',{'kind':'measured-local-clef-retrieval','phase':phase,'inputManifestSha256':digest(inputdir/'manifest.json'),
             'datasetHash':input_manifest['datasetHash'],'sourceId':input_manifest['sourceId'],'implementationHash':codehash,'environment':environment,
             'schedule':schedule,'policy':{'topK':5,'retain':10,'windowNativeAndCommonTokens':12000,'noTruncation':True,'concurrency':1,'queryCache':False,
             'apiCostUsd':'0','localResources':'unpriced','candidatePool':'Frozen original shared50. Hybrid latency is reranker-only; candidate production is excluded.',
             'ranking':'Official SystemOne probabilities rounded to four decimals; stable source-order ties; raw probabilities diagnostic only.',
             'errors':'Preserve every terminal outcome; no automatic retries; stop on OOM, provenance error or three consecutive failures.',
             'hardware':'New DGX Spark host; record co-resident processes, never claim exclusive or contemporaneous timing unless observed.',
             'apiBudget':'No paid API calls in this runner. Later generation/judging must use the original shared ledger and remaining global/judge caps.'}},True)
        smoke(runtime,out)
        cached={};totalcalls=0
        for row in schedule:
            question=questions[row['questionId']]
            if row['documentId'] not in cached:
                doc=json.loads((inputdir/documents[row['documentId']]['path']).read_text());cached[row['documentId']]=doc
            doc=cached[row['documentId']];chunks=doc['chunks']
            if row['method']=='hybrid-clef':
                ids=candidates[row['id']];lookup={c['id']:c for c in chunks}
                if len(ids)!=len(set(ids)) or any(i not in lookup for i in ids):raise ValueError('PROVENANCE: wrong candidate pool')
                chunks=sorted([lookup[i] for i in ids],key=lambda c:c['ordinal'])
            runkey=hashlib.sha256(row['id'].encode()).hexdigest();call_index=0;pending={}
            callpath=out/'calls'/(runkey+'.jsonl')
            def save_call(event,value):
                nonlocal call_index,totalcalls
                if event=='start':
                    call_index+=1;totalcalls+=1;call=f'{runkey}:{call_index}';pending[call]=True;value={**value,'call':call}
                else:
                    call=value['call']
                    if call not in pending:raise ValueError('Unknown or duplicate completion')
                    del pending[call]
                record={'event':event,'at':now(),'runId':row['id'],**value}
                with callpath.open('a') as f:f.write(json.dumps(record,ensure_ascii=False,allow_nan=False)+'\n');f.flush();os.fsync(f.fileno())
                write(out/'progress.json',{'stage':'retrieval','updatedAt':now(),'terminal':terminal,'planned':len(schedule),'calls':totalcalls,'activeRun':row['id'],'activeMethod':row['method'],'activeCall':call_index})
                return call
            before=gpu_snapshot();t=time.perf_counter();runstarted=now()
            try:
                result=search(runtime,question['question'],chunks,save_call)
                result={**row,**result,'status':'completed','startedAt':runstarted,'finishedAt':now(),'elapsedMs':(time.perf_counter()-t)*1000,
                        'gpuBefore':before,'gpuAfter':gpu_snapshot(),'candidateSource':'frozen-shared50' if row['method']=='hybrid-clef' else 'complete-document',
                        'latencyScope':'reranking-only' if row['method']=='hybrid-clef' else 'full-scan','timingEnvironment':'shared-gpu-observed' if any(line.split(',')[0].strip()!=str(os.getpid()) for line in before['processes']) else 'no-other-compute-observed'}
                failures=0
            except Exception as e:
                result={**row,'status':'failed','startedAt':runstarted,'finishedAt':now(),'elapsedMs':(time.perf_counter()-t)*1000,'ranking':[],'error':type(e).__name__+': '+str(e),'traceback':traceback.format_exc(),'gpuBefore':before,'callsStarted':call_index,'pendingCalls':list(pending),'apiCostUsd':'0'}
                failures+=1
            write(out/'runs'/(runkey+'.json'),result,True);terminal+=1
            print(json.dumps({'stage':'retrieval','terminal':terminal,'planned':len(schedule),'status':result['status'],'method':row['method'],'ms':result['elapsedMs'],'error':result.get('error')}),flush=True)
            if failures>=3 or (result['status']=='failed' and ('out of memory' in result['error'].lower() or 'PROVENANCE' in result['error'])):raise RuntimeError('Terminal failure guard; no retries')
        status='completed'
        counts={}
        for path in (out/'runs').glob('*.json'):
            value=json.loads(path.read_text());counts[value['status']]=counts.get(value['status'],0)+1
        write(out/'completion.json',{'statuses':counts,'status':status,'finishedAt':now(),'terminal':terminal,'planned':len(schedule),'apiCostUsd':'0','allRetrievalTerminal':True},True)
        write(out/'progress.json',{'stage':'completed','updatedAt':now(),'terminal':terminal,'planned':len(schedule)})
    except BaseException as e:
        write(out/'halt.json',{'error':type(e).__name__+': '+str(e),'traceback':traceback.format_exc(),'at':now(),'terminal':terminal},True);raise
    finally:
        write(out/'exit.json',{'status':status,'startedAt':started,'finishedAt':now(),'terminal':terminal},True);lock.unlink(missing_ok=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--inputs',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--model-root',type=Path,default=ROOT/'data/clef');p.add_argument('--pilot-gate',type=Path);run(p.parse_args())
