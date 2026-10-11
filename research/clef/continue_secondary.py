#!/usr/bin/env python3
"""One generation dispatch, audited preservation, then one judge dispatch."""
from pathlib import Path
from datetime import datetime,timezone
import json,os,subprocess,sys,traceback
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'data/research/clef-extension-20261009-v1'
NODE=ROOT/'.runtime/node-v24.21.0-linux-arm64/bin/node'
def now():return datetime.now(timezone.utc).isoformat()
def exclusive(name,v):
    with (OUT/name).open('x') as f:json.dump(v,f,indent=2)
def supervise():
    lock=OUT/'secondary-supervisor.lock'
    with lock.open('x') as f:f.write(str(os.getpid()))
    child=None;status='failed'
    try:
        assert not (OUT/'generation-process.json').exists(),'Generation already dispatched; inspect, never duplicate'
        cmd=[str(NODE),'--import','tsx','research/clef/secondary.ts','--inputs',str(OUT/'inputs'),'--retrieval',str(OUT/'retrieval/main-v1'),'--audit',str(OUT/'retrieval/main-v1-amended-audit.json'),'--out',str(OUT/'experiment'),'--ledger',str(ROOT/'data/research/study-budget.sqlite'),'--allow-paid']
        with (OUT/'generation.log').open('xb') as log:
            child=subprocess.Popen(cmd,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
            exclusive('generation-process.json',{'pid':child.pid,'at':now(),'command':cmd,'supervisorPid':os.getpid()})
            code=child.wait()
        exclusive('generation-exit.json',{'pid':child.pid,'exitCode':code,'at':now()})
        assert code==0,'Generation halted; preserve terminal records and inspect'
        subprocess.run([sys.executable,'research/clef/prepare_judge.py'],cwd=ROOT,check=True)
        subprocess.run([sys.executable,'research/clef/judge_launch.py','check'],cwd=ROOT,check=True)
        subprocess.run([sys.executable,'research/clef/judge_launch.py','launch'],cwd=ROOT,check=True)
        status='judge-dispatched-once'
    except BaseException as e:
        exclusive('secondary-halt.json',{'at':now(),'error':str(e),'traceback':traceback.format_exc()});raise
    finally:
        exclusive('secondary-exit.json',{'at':now(),'status':status});lock.unlink(missing_ok=True)
if sys.argv[1:]==['supervise']:supervise()
elif sys.argv[1:]==['launch']:
    assert not (OUT/'secondary-process.json').exists(),'Continuation already dispatched; do not duplicate'
    with (OUT/'secondary.log').open('xb') as log:
        p=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'supervise'],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    exclusive('secondary-process.json',{'pid':p.pid,'at':now()});print(json.dumps({'supervisorPid':p.pid,'root':str(OUT)}))
else:raise SystemExit('Usage: continue_secondary.py launch|supervise')
