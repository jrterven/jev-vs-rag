#!/usr/bin/env python3
"""Wait for the existing pilot, audit it, then run the frozen test exactly once."""
import argparse,datetime,json,os,subprocess,sys,tarfile,time,traceback
from pathlib import Path
from runtime import digest,identity
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/clef-spark-20261007'
INPUTS=ROOT/'data/research/clef-spark-inputs-20261007'
PYTHON=ROOT/'.venv-clef/bin/python'
CODE='b3251cdf90215006c854f595dcc3050a1b01a2e01207c314f4bb312f008c170d'
FREEZE='f8bad31cb81abda0b475f95527f66e9146f615bedf2e151836553bc6e1a49d02'
PINS={'pilot':'b3efb5741b3dc3eec6cca5d13bf79d36fd33f045f84bc79180a5dfbb80999552',
      'main':'e4e66b0f42360d4586362fcb47bd3074c2239ef87006539d29b55b27eb2ee3df'}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def read(p):return json.loads(p.read_text())
def save(name,value,exclusive=False):
    p=OUT/name;data=json.dumps(value,indent=2)+'\n'
    if exclusive:
        with p.open('x') as f:f.write(data);f.flush();os.fsync(f.fileno())
    else:
        tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(data);tmp.replace(p)
def verify():
    code={name:(ROOT/'research/clef'/name).read_text() for name in ('run.py','runtime.py','search.py')}
    assert identity(code)==CODE,'Runtime changed since pilot'
    frozen=OUT/'runtime-requirements.freeze.txt';assert digest(frozen)==FREEZE
    actual=subprocess.run([str(PYTHON),'-m','pip','freeze'],capture_output=True,check=True).stdout
    assert actual==frozen.read_bytes(),'Installed dependency versions changed'
    for phase,pin in PINS.items():
        p=INPUTS/phase/'manifest.json';assert digest(p)==pin
        for name,sha in read(p)['files'].items():assert digest(p.parent/name)==sha,'Input changed '+name
    assert not (OUT/'main-v1').exists(),'Test already exists; never rerun'
    return {'passed':True,'at':now(),'implementationHash':CODE,'runtimeFreezeSha256':FREEZE,'inputManifests':PINS}
def pilot_alive(pid):
    p=Path(f'/proc/{pid}/cmdline')
    if not p.exists():return False
    try:cmd=p.read_bytes()
    except FileNotFoundError:return False
    if not cmd:return False
    assert str(ROOT/'research/clef/run.py').encode() in cmd and b'pilot-v2' in cmd,'PID reused by another command; audit before continuing'
    return True
def preserve(cohort):
    destination=OUT/(cohort+'-closed.tar.gz');temp=OUT/(cohort+'-closed.tar.gz.partial')
    assert not destination.exists() and not temp.exists(),'Preservation already exists'
    with tarfile.open(temp,'x:gz') as archive:
        for name in [cohort,cohort+'.log',cohort+'-dispatch.json',cohort+'-audit.json','runtime-requirements.freeze.txt']:
            p=OUT/name
            if p.exists():archive.add(p,arcname=name)
    temp.rename(destination)
    save(cohort+'-preservation.json',{'at':now(),'file':destination.name,'sha256':digest(destination),'bytes':destination.stat().st_size},True)
def cohort_audit(cohort,phase,gate=False):
    cmd=[str(PYTHON),str(ROOT/'research/clef/audit.py'),'--inputs',str(INPUTS/phase),'--directory',str(OUT/cohort),'--out',str(OUT/(cohort+'-audit.json'))]
    if gate:cmd+=['--pilot-gate',str(OUT/'pilot-gate.json')]
    subprocess.run(cmd,cwd=ROOT,check=True)
def main():
    check=verify()
    if '--check' in sys.argv:print(json.dumps(check));return
    fd=os.open(OUT/'continuation.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,str(os.getpid()).encode());os.close(fd)
    save('continuation-process.json',{'pid':os.getpid(),'startedAt':now()},True)
    save('continuation-preflight.json',check,True)
    status='failed'
    try:
        pilot=OUT/'pilot-v2';pid=read(pilot/'process.json')['pid']
        while pilot_alive(pid):
            save('continuation-progress.json',{'stage':'waiting-for-existing-pilot','at':now(),'pilotPid':pid,'pilotProgress':read(pilot/'progress.json')})
            time.sleep(30)
        assert read(pilot/'exit.json')['status']=='completed','Pilot failed; preserve and inspect, never retry cases'
        assert not (OUT/'inference.lock').exists(),'Inference lock still held'
        cohort_audit('pilot-v2','pilot',True);preserve('pilot-v2');verify()
        save('continuation-progress.json',{'stage':'launching-frozen-test','at':now()})
        env={**os.environ,'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','TOKENIZERS_PARALLELISM':'false','PYTHONUNBUFFERED':'1'}
        cmd=[str(PYTHON),'-u',str(ROOT/'research/clef/run.py'),'--inputs',str(INPUTS/'main'),'--out',str(OUT/'main-v1'),'--pilot-gate',str(OUT/'pilot-gate.json')]
        with (OUT/'main-v1.log').open('x') as log:
            child=subprocess.Popen(cmd,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
            save('main-v1-dispatch.json',{'pid':child.pid,'at':now(),'cmd':cmd,'supervisorPid':os.getpid()},True)
            save('continuation-progress.json',{'stage':'test-running','at':now(),'pid':child.pid})
            code=child.wait()
        if code:raise RuntimeError(f'Test exited {code}; preserve terminal cases and inspect without retries')
        cohort_audit('main-v1','main');preserve('main-v1');status='retrieval-completed'
        save('continuation-progress.json',{'stage':status,'at':now(),'paidApiCalls':0,'next':'Offline evidence analysis; secondary paid evaluation needs original shared ledger audit.'})
    except BaseException as e:
        save('continuation-halt.json',{'at':now(),'error':str(e),'traceback':traceback.format_exc()},True);raise
    finally:
        save('continuation-exit.json',{'at':now(),'status':status},True);(OUT/'continuation.lock').unlink(missing_ok=True)
if __name__=='__main__':main()
