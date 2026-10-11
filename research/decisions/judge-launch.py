"""Bounded sequential supervision of the unchanged scientific RAGAS runtime."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
from datetime import datetime,timezone
from decimal import Decimal as D
ROOT=Path(__file__).resolve().parents[2]
JUDGE=ROOT/'data/research/decisions-extension-20261007-v1/v2/judge'
RUN='decisions-ragas-20261007-v1'
NODE=ROOT/'.runtime/node-v24.21.0-linux-arm64/bin/node'
PYTHON=ROOT/'research/.venv-ragas/bin/python'
LEDGER=ROOT/'data/research/study-budget.sqlite'
def now():return datetime.now(timezone.utc).isoformat()
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(s) for s in p.read_text().splitlines() if s.strip()] if p.exists() else []
def digest(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def exclusive(p,value):
 with p.open('x') as f:json.dump(value,f,indent=2)
def state():
 c=sqlite3.connect(f'file:{LEDGER}?mode=ro',uri=True);a=[json.loads(v) for v, in c.execute('SELECT value FROM attempts')]
 halt=c.execute('SELECT value FROM immutable WHERE key=?',(f'ragas:{RUN}:extension-halt',)).fetchone();c.close()
 if halt:raise RuntimeError('Access/budget halt; inspect before continuing.')
 if any(x['status']=='pending' for x in a):raise RuntimeError('Unresolved provider calls; do not duplicate.')
 recent=sorted([x for x in a if x['runId'].startswith(RUN+':')],key=lambda x:x.get('finishedAt',''))[-3:]
 if len(recent)==3 and all(x['status']!='completed' for x in recent):raise RuntimeError('Three consecutive provider failures; inspect.')
 def committed(rows):return sum((D(x['costUsd'] if x['costUsd'] is not None else x['reservedUsd']) for x in rows),D(0))
 totals={'global':committed(a),'judge':committed([x for x in a if x['method']=='ragas-judge']),'extension':committed([x for x in a if x['runId'].startswith('decisions-extension-20261007-v1:') or x['runId'].startswith(RUN+':')]),'thisJudge':committed([x for x in a if x['runId'].startswith(RUN+':')])}
 for k,cap in [('global',200),('judge',80),('extension',100),('thisJudge',20)]:
  if totals[k]+D('1.52384')>cap:raise RuntimeError('Insufficient reserved budget: '+k)
 return {k:str(v) for k,v in totals.items()}
def preflight():
 frozen=read(JUDGE/'extension-judge-freeze.json')
 for name,expected in frozen['files'].items():
  if digest(ROOT/name)!=expected:raise RuntimeError('Frozen source changed: '+name)
 if digest(JUDGE/'samples.jsonl')!=frozen['sampleSha256']:raise RuntimeError('Judge samples changed')
 if (JUDGE/'study.results.jsonl.lock').exists():raise RuntimeError('Runtime still locked')
 return state()
def supervise():
 bridge=None;result=JUDGE/'study.results.jsonl';expected={(s['id'],m) for s in lines(JUDGE/'samples.jsonl') for m in s['metrics']}
 start=now();rounds=[]
 try:
  preflight()
  with (JUDGE/'bridge.log').open('xb') as log:
   bridge=subprocess.Popen([str(NODE),'--import','tsx','research/decisions/bridge.ts','--run-id',RUN,'--out',str(JUDGE/'bridge'),'--ledger',str(LEDGER),'--max-eval-usd','20','--max-output-tokens','8192','--concurrency','2','--input',str(JUDGE/'samples.jsonl'),'--allow-paid'],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
  exclusive(JUDGE/'bridge-process.json',{'pid':bridge.pid,'startedAt':now()})
  for _ in range(120):
   if (JUDGE/'bridge/bridge-info.json').exists():break
   if bridge.poll() is not None:raise RuntimeError('Bridge exited before ready')
   time.sleep(.25)
  else:raise RuntimeError('Bridge startup timed out')
  for ordinal in range(1,101):
   preflight();previous=lines(result);previous_bytes=result.read_bytes() if result.exists() else b''
   terminal={(r['sampleId'],r['metric']) for r in previous}
   if len(terminal)!=len(previous) or not terminal<=expected:raise RuntimeError('Duplicate/foreign result rows')
   if terminal==expected:break
   logpath=JUDGE/f'runtime-{ordinal:03d}.log'
   with logpath.open('xb') as log:
    child=subprocess.Popen([str(PYTHON),'research/ragas/runtime.py','--input',str(JUDGE/'samples.jsonl'),'--output',str(result),'--bridge-info',str(JUDGE/'bridge/bridge-info.json'),'--run-id',RUN,'--timeout','600','--concurrency','2'],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
    (JUDGE/'runtime-process.json').write_text(json.dumps({'pid':child.pid,'round':ordinal,'startedAt':now()}));code=child.wait()
   if not result.read_bytes().startswith(previous_bytes):raise RuntimeError('Historical terminal results changed')
   current=lines(result);summaries=[json.loads(s)['summary'] for s in logpath.read_text().splitlines() if s.startswith('{"summary":')]
   receipt={'round':ordinal,'pid':child.pid,'exitCode':code,'finishedAt':now(),'previous':len(previous),'terminal':len(current),'summary':summaries[-1] if summaries else None}
   exclusive(JUDGE/f'runtime-{ordinal:03d}-exit.json',receipt);rounds.append(receipt)
   if not summaries or len(current)<=len(previous):raise RuntimeError('Runtime made no progress or failed outside metric loop')
   terminal={(r['sampleId'],r['metric']) for r in current}
   if len(terminal)!=len(current) or not terminal<=expected:raise RuntimeError('Invalid terminal metric rows')
   if terminal==expected:break
   # Failures are preserved; the frozen runtime skips all terminal metric pairs on restart.
   preflight()
  else:raise RuntimeError('Supervisor round limit reached')
  exclusive(JUDGE/'completion.json',{'startedAt':start,'finishedAt':now(),'expected':len(expected),'terminal':len(lines(result)),'allMetricsTerminal':True,'rounds':rounds,'providerRetries':0})
 except Exception as exc:
  exclusive(JUDGE/'halt.json',{'startedAt':start,'haltedAt':now(),'error':str(exc),'rounds':rounds});raise
 finally:
  if bridge is not None and bridge.poll() is None:
   bridge.send_signal(signal.SIGTERM)
   try:bridge.wait(timeout=60)
   except subprocess.TimeoutExpired:raise RuntimeError('Bridge still closing; do not relaunch while pending')
if sys.argv[1:] == ['check']:
 print(json.dumps({'ready':True,'budget':preflight()}))
elif sys.argv[1:] == ['supervise']:
 supervise()
elif sys.argv[1:] == ['launch']:
 preflight()
 if (JUDGE/'supervisor-process.json').exists():raise SystemExit('Launch already recorded; inspect rather than duplicate')
 with (JUDGE/'supervisor.log').open('xb') as log:
  p=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'supervise'],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 exclusive(JUDGE/'supervisor-process.json',{'pid':p.pid,'startedAt':now()})
 print(json.dumps({'supervisorPid':p.pid,'directory':str(JUDGE)}))

else:
 raise SystemExit('Usage: judge-launch.py check|launch|supervise')
