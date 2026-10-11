"""Capture official web-edition metadata before acquiring every book section.

Run from the repository root. Existing discovery files are preserved; use a new
acquisition directory for a different edition rather than overwriting annotations.
"""
from datetime import datetime, timezone
import concurrent.futures, hashlib, json, pathlib, urllib.request
BASE = pathlib.Path('data/research/openstax-acquisition')
if (BASE/'official-metadata.json').exists():
    raise SystemExit('A pinned metadata manifest already exists; use it with acquire_openstax.py.')
CONFIG = json.loads(pathlib.Path('research/config/openstax-acquisition.json').read_text())
def sha(data): return hashlib.sha256(data).hexdigest()
def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'JevRagResearchSourceAcquisition/1.0'}),timeout=40) as r:
        data=r.read(16*1024*1024+1)
        if len(data)>16*1024*1024: raise ValueError('metadata exceeds cap')
        return data
def acquire(item):
    slug=item['url'].split('/books/')[1].split('/')[0]
    directory=BASE/slug;directory.mkdir(parents=True,exist_ok=True)
    existing=BASE/f'{slug}-preface.html'
    raw=existing.read_bytes() if existing.exists() else fetch(item['url'])
    (directory/'preface.html').write_bytes(raw)
    html=raw.decode();marker='window.__PRELOADED_STATE__ = ';pos=html.index(marker)+len(marker)
    state,end=json.JSONDecoder().raw_decode(html[pos:]);state_raw=html[pos:pos+end].encode()
    (directory/'state.json').write_bytes(state_raw)
    book=state['content']['book'];meta_url=f"https://openstax.org/apps/archive/{book['archiveVersion']}/contents/{book['id']}@{book['contentVersion']}.json"
    existing_meta=BASE/f'{slug}-book.json'
    meta_raw=existing_meta.read_bytes() if existing_meta.exists() else fetch(meta_url)
    (directory/'book.json').write_bytes(meta_raw);meta=json.loads(meta_raw)
    if meta['id']!=book['id'] or meta['version']!=book['contentVersion']:raise ValueError('state/meta version mismatch')
    leaves=[];chapters=[]
    def walk(node):
        if node.get('toc_type')=='chapter':chapters.append(node['title'])
        if not node.get('contents'):leaves.append(node)
        else:
            for child in node['contents']:walk(child)
    walk(meta['tree'])
    result={'requestedTitle':item['title'],'title':meta['title'],'slug':slug,'split':item['split'],'sourceUrl':item['url'], 'bookId':meta['id'],'bookVersion':meta['version'],'archiveVersion':book['archiveVersion'],'metadataUrl':meta_url,'pageUrlTemplate':f"https://openstax.org/apps/archive/{book['archiveVersion']}/contents/{meta['id']}@{meta['version']}:{{pageUUID}}.xhtml",'license':meta['license'],'authors':book.get('authors',[]),'published':book.get('publish_date'),'revised':meta.get('revised'),'tree':meta['tree'],'coverage':{'chapters':len(chapters),'leaves':len(leaves),'firstLeaf':leaves[0]['id'],'lastLeaf':leaves[-1]['id']},'rawStatePath':str(directory/'state.json'),'rawStateSha256':sha(state_raw),'rawHtmlPath':str(directory/'preface.html'),'rawHtmlSha256':sha(raw),'metadataPath':str(directory/'book.json'),'metadataSha256':sha(meta_raw)}
    (directory/'discovery.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'slug':slug,'id':meta['id'],'version':meta['version'],'license':meta['license'],'coverage':result['coverage']}),flush=True)
    return result
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    result=list(executor.map(acquire,CONFIG['documents']))
(BASE/'official-metadata.json').write_text(json.dumps({'schemaVersion':1,'acquiredAt':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),'source':'official OpenStax public reader and versioned archive','documents':result},ensure_ascii=False,indent=2))
print('SAVED',BASE/'official-metadata.json',flush=True)
