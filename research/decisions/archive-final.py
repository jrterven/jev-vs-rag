"""Private archival of the closed extension and its consistent final ledger."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT/'data/research/decisions-extension-20261007-v1'
V2 = EXT/'v2'
OUT = ROOT/'data/research/archives/decisions-final-20261007.tar.gz'
RECEIPT = OUT.with_suffix('.receipt.json')


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def main():
    preservation = json.loads((V2/'judge-preservation.json').read_text())
    audit = json.loads((V2/'judge-final-audit.json').read_text())
    comparison = json.loads((V2/'judge-analysis.json').read_text())
    if not audit['ok'] or not audit['allMetricsTerminal'] or comparison['extension']['accounting']['pending']:
        raise SystemExit('Require final passing audit and complete comparison.')
    ledger = Path(preservation['backup'])
    if sha(ledger) != preservation['backupSha256'] or audit['integrity']['ledgerSha256'] != preservation['backupSha256']:
        raise SystemExit('Final ledger identity differs.')
    if OUT.exists() or RECEIPT.exists():
        raise SystemExit('Archive/receipt exists; verify it rather than overwrite.')
    files=[]
    excluded=[]
    for p in sorted(EXT.rglob('*')):
        if p.is_symlink():
            raise SystemExit('Unexpected archive symlink: '+str(p))
        if not p.is_file():
            continue
        if 'token' in p.name.lower() or p.name.startswith('.env') or p.suffix == '.lock':
            excluded.append(str(p.relative_to(ROOT)))
            continue
        if p.suffix not in {'.json','.jsonl','.ts','.py','.log','.txt'}:
            raise SystemExit('Inspect unexpected archive file: '+str(p.relative_to(ROOT)))
        files.append(p)
    files.append(ledger)
    metadata=[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in files]
    OUT.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(OUT,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as raw:
        with tarfile.open(fileobj=raw,mode='w:gz',compresslevel=1) as tar:
            for p in files:
                tar.add(p,arcname=str(p.relative_to(ROOT)),recursive=False)
    with tarfile.open(OUT,'r:gz') as tar:
        members=tar.getmembers()
        if [m.name for m in members] != [m['path'] for m in metadata]:
            raise SystemExit('Archive inventory mismatch; preserve for inspection.')
        for member,expected in zip(members,metadata):
            with tar.extractfile(member) as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest() != expected['sha256']:
                    raise SystemExit('Archive content differs: '+member.name)
    receipt={'createdAt':datetime.now(timezone.utc).isoformat(),'kind':'private-complete-decisions-archive',
        'archive':str(OUT),'bytes':OUT.stat().st_size,'sha256':sha(OUT),'files':metadata,'excluded':excluded,
        'policy':'Private research records: includes raw text, provider records and a consistent ledger. Not a public paper artifact. Credentials/tokens/locks excluded.',
        'sourceSha256':sha(Path(__file__))}
    with RECEIPT.open('x') as f:
        json.dump(receipt,f,indent=2)
    os.chmod(RECEIPT,0o600)
    print(json.dumps({k:receipt[k] for k in ('archive','bytes','sha256')}|{'files':len(files),'excluded':excluded}))


if __name__=='__main__':
    main()
