#!/usr/bin/env python3
"""Private consistent closure archive. Never publish raw texts/provider records."""
from datetime import datetime,timezone
from pathlib import Path
import hashlib,json,os,tarfile

ROOT=Path(__file__).resolve().parents[2]
EXT=ROOT/'data/research/clef-extension-20261009-v1'
RESULTS=ROOT/'output/clef-spark-20261007'
OUT=ROOT/'data/research/archives/clef-final-20261009.tar.gz'
RECEIPT=OUT.with_suffix('.receipt.json')
def read(p):return json.loads(p.read_text())
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def main():
    preserved=read(EXT/'judge-preservation.json');audit=read(RESULTS/'judge-final-audit.json');comparison=read(RESULTS/'judge-analysis-final.json')
    assert audit['ok'] and audit['allMetricsTerminal']
    for name in ('originalComparison','decisionsComparison'):
        assert comparison[name]['extension']['accounting']['pending']==0
    judge=EXT/'judge'
    for name in ('supervisor','bridge','runtime'):
        assert not Path('/proc',str(read(judge/(name+'-process.json'))['pid']),'cmdline').exists(),'Judge still live'
    assert not (judge/'study.results.jsonl.lock').exists() and not (judge/'bridge/bridge.lock').exists()
    ledger=Path(preserved['backup']);assert digest(ledger)==preserved['backupSha256']==audit['integrity']['ledgerSha256']
    assert not OUT.exists() and not RECEIPT.exists(),'Archive exists; verify rather than overwrite'
    files=[];excluded=[]
    for p in sorted(EXT.rglob('*')):
        assert not p.is_symlink(),'Unexpected symlink in private source tree'
        if not p.is_file():continue
        if 'token' in p.name.lower() or p.name.startswith('.env') or p.suffix=='.lock':
            excluded.append({'path':str(p.relative_to(ROOT)),'reason':'credentials/session token/lock'});continue
        if p.name=='main-v1-amended-closed.tar.gz':
            # The original archive remains preserved separately; its expanded
            # raw records and checksum receipt are included here without duplication.
            excluded.append({'path':str(p.relative_to(ROOT)),'reason':'duplicate closed retrieval archive; expanded records and receipt included','sha256':digest(p)});continue
        assert p.suffix in {'.json','.jsonl','.ts','.py','.log','.txt','.source'},'Inspect unexpected extension artifact: '+str(p)
        files.append(p)
    files.append(ledger)
    for name in ('judge-final-audit.json','judge-analysis-final.json','earlier-primary-timing-components.json'):
        files.append(RESULTS/name)
    # Metadata contains paths/hashes only; source documents stay private.
    inventory=[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':digest(p)} for p in files]
    OUT.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(OUT,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:
        with tarfile.open(fileobj=f,mode='w:gz',compresslevel=1) as tar:
            for p in files:tar.add(p,arcname=str(p.relative_to(ROOT)),recursive=False)
    with tarfile.open(OUT,'r:gz') as tar:
        members=tar.getmembers();assert [m.name for m in members]==[v['path'] for v in inventory]
        for member,expected in zip(members,inventory):
            with tar.extractfile(member) as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==expected['sha256'],'Archive content changed'
    receipt={'createdAt':datetime.now(timezone.utc).isoformat(),'kind':'private-complete-clef-archive','archive':str(OUT),'bytes':OUT.stat().st_size,'sha256':digest(OUT),
             'files':inventory,'excluded':excluded,'sourceSha256':digest(Path(__file__)),
             'policy':'Private raw source texts, outcomes, provider records and consistent ledger. Not a public paper artifact. Tokens and locks excluded; all original failures, interrupted repeats and unknown consumption preserved.'}
    with RECEIPT.open('x') as f:json.dump(receipt,f,indent=2)
    RECEIPT.chmod(0o600)
    print(json.dumps({k:receipt[k] for k in ('archive','bytes','sha256')}|{'files':len(files),'excludedFiles':len(excluded)}))
if __name__=='__main__':main()
