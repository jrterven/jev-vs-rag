#!/usr/bin/env python3
"""Download the pinned official Clef release; hash every file before execution."""
import argparse,hashlib,json,os,time,urllib.request
from pathlib import Path
from huggingface_hub import snapshot_download
MODEL='Cloudflare/clef'
REVISION='ed3eed331870db2eff4b0db01237128ede8a00ce'
def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args()
    root=a.root.resolve();root.mkdir(parents=True,exist_ok=True)
    meta=json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true',timeout=60))
    assert meta['sha']==REVISION and not meta.get('gated')
    (root/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
    path=Path(snapshot_download(MODEL,revision=REVISION,local_dir=root/'model',max_workers=4))
    files={}
    for row in meta['siblings']:
        file=path/row['rfilename']
        if not file.is_file():raise ValueError('Missing release file '+str(file))
        digest=sha(file);expected=(row.get('lfs') or {}).get('sha256')
        if expected and digest!=expected:raise ValueError('Release LFS SHA mismatch '+row['rfilename'])
        if row.get('size') is not None and file.stat().st_size!=row['size']:raise ValueError('Release size mismatch')
        files[row['rfilename']]={'sha256':digest,'bytes':file.stat().st_size,'upstreamLfsSha256':expected}
    receipt={'kind':'verified-clef-release','model':MODEL,'revision':REVISION,'path':str(path),'files':files,'verifiedAt':time.time()}
    (root/'model-verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'verified':True,'files':len(files),'bytes':sum(x['bytes'] for x in files.values()),'revision':REVISION}),flush=True)
if __name__=='__main__':main()
