#!/usr/bin/env python3
"""Read-only export of earlier primary latency components for fair phase plots.

No inference, provider requests, queries to the live ledger, or modifications.
Whole hybrid times remain distinct from the reranking-only Clef measurement.
"""
import argparse,datetime,hashlib,json,math,sqlite3
from pathlib import Path

PIN='b7b391147049899a598862d59ccee0ce5848a03d8b046b256cef545528345f9b'
ORIGINAL='gb10-main-study-20261004-v1:'
DECISIONS='decisions-extension-20261007-v1:v2:main:'
METHODS=('openai-dense','hybrid-bge','hybrid-jev','jev-scan','hybrid-decisions','decisions-scan')
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def export(ledger,out):
    assert digest(ledger)==PIN,'Closed earlier ledger changed'
    assert not out.exists(),'Immutable export exists; never overwrite'
    rows=[];seen=set()
    with sqlite3.connect(f'file:{ledger.resolve()}?mode=ro',uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        for ident,value in db.execute("SELECT id,value FROM runs WHERE id LIKE ? OR id LIKE ?",(ORIGINAL+'%',DECISIONS+'%')):
            run=json.loads(value)
            if run['round']!=0 or run['method'] not in METHODS:continue
            assert run['id']==ident and ident not in seen;seen.add(ident)
            assert run['method'] in (METHODS[:4] if ident.startswith(ORIGINAL) else METHODS[4:])
            phases=run.get('phases',{})
            assert all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and v>=0 for v in phases.values())
            rows.append({k:run.get(k) for k in ['id','questionId','documentId','corpus','method','round','status','elapsedMs','timingValid','timingEnvironment','operationalContinuationId','startedAt','finishedAt']}|
                        {'phases':phases,'sourceRowSha256':hashlib.sha256(value.encode()).hexdigest()})
    for method in METHODS:
        group=[r for r in rows if r['method']==method]
        assert len(group)==476 and len({r['questionId'] for r in group})==476
        assert sum(r['corpus']=='qasper-test' for r in group)==396 and sum(r['corpus']=='openstax-books' for r in group)==80
        key='jevSearchMs' if method in ('hybrid-jev','jev-scan') else 'decisionsSearchMs' if method in METHODS[4:] else None
        if key:assert all(key in r['phases'] for r in group if r['status']=='completed')
    result={'schemaVersion':1,'kind':'closed-earlier-primary-latency-components','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sourceLedgerSha256':PIN,'exporterSha256':digest(Path(__file__)),'originalPrefix':ORIGINAL,'decisionsPrefix':DECISIONS,
            'rows':rows,'policy':'Round0 only. Preserve failures, validity and hardware-sharing blocks. Hybrid reranking uses jevSearchMs or decisionsSearchMs, excluding candidate generation; whole elapsedMs is separate. Clef uses a different host/date/concurrency and a descriptive single pass. Never pool incomplete extra repeats or infer causal speed ratios.'}
    out.parent.mkdir(parents=True,exist_ok=True)
    with out.open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    print(json.dumps({'out':str(out),'rows':len(rows),'sourceLedgerSha256':PIN,'paidCalls':0}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--ledger',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();export(a.ledger,a.out)
