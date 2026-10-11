#!/usr/bin/env python3
"""Read-only Clef status; never imports the model or calls providers."""
import json,os,datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'output/clef-spark-20261007'
def load(path):return json.loads(path.read_text()) if path.exists() else None
def process(data):
    if not data:return None
    pid=data.get('pid');cmd=Path(f'/proc/{pid}/cmdline')
    try:
        argv=cmd.read_bytes()
        own_cwd=Path(f'/proc/{pid}/cwd').resolve()==ROOT
        live=bool(pid and b'research/clef/' in argv and (str(ROOT).encode() in argv or own_cwd))
    except (FileNotFoundError,PermissionError,ProcessLookupError):live=False
    return {'pid':pid,'live':live}
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(ROOT),
        'bootstrap':{'process':process(load(OUT/'bootstrap-process.json')),'progress':load(OUT/'bootstrap-progress.json'),'exit':load(OUT/'bootstrap-exit.json')},
        'continuation':{'process':process(load(OUT/'continuation-process.json')),'progress':load(OUT/'continuation-progress.json'),'exit':load(OUT/'continuation-exit.json'),'halt':load(OUT/'continuation-halt.json')},
        'modelVerified':(ROOT/'data/clef/model-verification.json').exists(),'runs':[]}
for p in sorted(OUT.glob('pilot*'))+sorted(OUT.glob('main*')):
    if not p.is_dir():continue
    counts={}
    for f in (p/'runs').glob('*.json'):
        r=load(f);counts[r['status']]=counts.get(r['status'],0)+1
    result['runs'].append({'directory':str(p),'process':process(load(p/'process.json')),'progress':load(p/'progress.json'),
                           'smoke':load(p/'smoke-completion.json'),'counts':counts,'completion':load(p/'completion.json'),'exit':load(p/'exit.json'),
                           'halt':(load(p/'halt.json') or {}).get('error')})
print(json.dumps(result,indent=2))
