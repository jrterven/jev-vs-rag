#!/usr/bin/env python3
"""One operational export repair, then one initial judge launch. No gen rerun."""
from pathlib import Path
from datetime import datetime,timezone
import json,subprocess,sys,traceback
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'data/research/clef-extension-20261009-v1'
def now():return datetime.now(timezone.utc).isoformat()
def save(name,value):
    with (OUT/name).open('x') as f:json.dump(value,f,indent=2)
def supervise():
    status='failed'
    try:
        subprocess.run([sys.executable,'research/clef/prepare_judge_large.py'],cwd=ROOT,check=True)
        subprocess.run([sys.executable,'research/clef/judge_launch.py','check'],cwd=ROOT,check=True)
        subprocess.run([sys.executable,'research/clef/judge_launch.py','launch'],cwd=ROOT,check=True)
        status='judge-dispatched-once'
    except BaseException as e:
        save('judge-export-repair-halt.json',{'at':now(),'error':str(e),'traceback':traceback.format_exc()});raise
    finally:save('judge-export-repair-exit.json',{'at':now(),'status':status})
if sys.argv[1:]==['supervise']:supervise()
elif sys.argv[1:]==['launch']:
    assert not (OUT/'judge-export-repair-process.json').exists(),'Repair already dispatched; inspect rather than duplicate'
    assert not Path('/proc/4041554/cmdline').exists() and not Path('/proc/4041564/cmdline').exists()
    assert not (OUT/'judge/supervisor-process.json').exists(),'Judge already dispatched'
    with (OUT/'judge-export-repair.log').open('xb') as log:
        child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'supervise'],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    save('judge-export-repair-process.json',{'pid':child.pid,'at':now(),'basis':'Operational ledger hash limit only; no terminal scientific call is repeated.'})
    print(json.dumps({'repairPid':child.pid,'root':str(OUT)}))
else:raise SystemExit('Usage: continue_judge_export.py launch|supervise')
