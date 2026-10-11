#!/usr/bin/env python3
"""Isolated dependency/model setup with one process receipt; no paid API calls."""
import datetime,json,os,subprocess,sys,time,traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/clef-spark-20261007'
PYTHON=ROOT/'.venv-clef/bin/python'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(name,value):
    temp=OUT/(name+'.tmp');temp.write_text(json.dumps(value,indent=2)+'\n');temp.replace(OUT/name)
def main():
    OUT.mkdir(parents=True,exist_ok=True)
    fd=os.open(OUT/'bootstrap.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,str(os.getpid()).encode());os.close(fd)
    started=now();save('bootstrap-process.json',{'pid':os.getpid(),'startedAt':started,'root':str(ROOT)})
    status='failed'
    def run(stage,cmd):
        save('bootstrap-progress.json',{'stage':stage,'updatedAt':now(),'pid':os.getpid()})
        print(stage,flush=True);subprocess.run([str(x) for x in cmd],cwd=ROOT,check=True)
    try:
        run('Installing CUDA PyTorch in isolated venv',[PYTHON,'-m','pip','install','torch==2.11.0','--index-url','https://download.pytorch.org/whl/cu130'])
        run('Installing pinned Transformers and inference dependencies',[PYTHON,'-m','pip','install','transformers==5.10.2','accelerate','pillow','huggingface_hub','einops','psutil','tiktoken'])
        with (OUT/'requirements.freeze.txt').open('w') as f:subprocess.run([str(PYTHON),'-m','pip','freeze'],stdout=f,check=True)
        run('Checking CUDA capability',[PYTHON,'-c','import torch,json; assert torch.cuda.is_available(); x=torch.ones(1024,device="cuda",dtype=torch.bfloat16); assert (x@x).isfinite(); print(json.dumps({"torch":torch.__version__,"cuda":torch.version.cuda,"gpu":torch.cuda.get_device_name(0),"capability":torch.cuda.get_device_capability(0),"arch":torch.cuda.get_arch_list()}))'])
        run('Downloading and verifying Clef 27B weights',[PYTHON,ROOT/'research/clef/download_model.py','--root',ROOT/'data/clef'])
        status='completed'
    except Exception as e:
        save('bootstrap-error.json',{'error':str(e),'traceback':traceback.format_exc(),'at':now()});raise
    finally:
        save('bootstrap-exit.json',{'status':status,'startedAt':started,'finishedAt':now(),'pid':os.getpid()})
        (OUT/'bootstrap.lock').unlink(missing_ok=True)
if __name__=='__main__':main()
