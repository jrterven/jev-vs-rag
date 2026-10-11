"""Document-order hierarchical reduction; no query cache, probability mixing or retry."""
import time
from runtime import request_body,identity

def search(runtime,query,chunks,save_call):
    if not chunks or len({c['id'] for c in chunks})!=len(chunks):raise ValueError('Empty/duplicate passage input')
    traces=[];covered=set();calls=0;tokens=0;start=time.perf_counter()
    groups=runtime.encoder.pack(query,chunks);previous=len(chunks)
    for level in range(64):
        evaluations=[]
        for group in groups:
            body=request_body(query,group);ids=[c['id'] for c in group]
            trace={'stage':'request','level':level,'candidateIds':ids,'retainedIds':[],'payloadHash':identity(body)};traces.append(trace)
            # Persist the request before dispatch and the outcome after it; failures
            # preserve both records. One synchronous local forward pass per window.
            call=save_call('start',{'level':level,'payload':body})
            try:result=runtime.evaluate(body)
            except Exception as e:
                save_call('error',{'call':call,'error':type(e).__name__+': '+str(e)});raise
            save_call('complete',{'call':call,'result':result})
            calls+=1;tokens+=result['usage']['input_tokens']
            probabilities=result['answers']['where']['probabilities'];noul=result['answers']['exists']['noul']
            if set(probabilities)!=set(ids):raise ValueError('Choice output IDs differ')
            # Primary ranking is the official API-compatible four-decimal output.
            # Full-precision values remain diagnostic only, never hidden tie breaks.
            ranked=sorted(group,key=lambda c:(-probabilities[c['id']],c['ordinal']))
            traces.append({'stage':'window' if level==0 else 'reduction','level':level,'candidateIds':ids,
                           'retainedIds':[c['id'] for c in ranked[:10]],'scores':[{'chunkId':c['id'],'score':probabilities[c['id']]} for c in ranked],
                           'existence':noul,'payloadHash':result['payloadHash']})
            evaluations.append((ranked,probabilities,noul))
            if level==0:covered.update(ids)
        if len(evaluations)==1:
            if covered!={c['id'] for c in chunks}:raise ValueError('Incomplete first-pass coverage')
            ranked,scores,noul=evaluations[0];ranking=[{'chunkId':c['id'],'score':scores[c['id']]} for c in ranked[:5]]
            traces.append({'stage':'final','level':level,'candidateIds':[c['id'] for c in ranked],'retainedIds':[r['chunkId'] for r in ranking],'existence':noul})
            return {'ranking':ranking,'traces':traces,'existence':noul,'initialPassagesCovered':len(covered),'initialPassages':len(chunks),'calls':calls,'inputTokens':tokens,'elapsedMs':(time.perf_counter()-start)*1000,'apiCostUsd':'0'}
        standard=sum(min(10,len(r)) for r,_,_ in evaluations);stalled=level>0 and standard>=previous
        cutoffs=[min(10,max(1,len(r)//2) if stalled else len(r)) for r,_,_ in evaluations]
        remaining=min(5,len(chunks))-sum(cutoffs)
        while remaining>0:
            changed=False
            for i,(r,_,_) in enumerate(evaluations):
                if remaining>0 and cutoffs[i]<min(10,len(r)):cutoffs[i]+=1;remaining-=1;changed=True
            if not changed:raise ValueError('Cannot retain five finalists')
        retained={c['id']:c for i,(r,_,_) in enumerate(evaluations) for c in r[:cutoffs[i]]}
        selected=sorted(retained.values(),key=lambda c:c['ordinal'])
        traces.append({'stage':'retained','level':level,'candidateIds':[c['id'] for r,_,_ in evaluations for c in r],'retainedIds':[c['id'] for c in selected]})
        if level>0 and len(selected)>=previous:raise ValueError('Reduction did not progress')
        previous=len(selected);groups=runtime.encoder.pack(query,selected)
    raise ValueError('Too many reduction levels')
