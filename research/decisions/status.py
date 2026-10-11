"""Safe read-only status. No prompts, responses, secrets, API calls or mutations."""
import json
from pathlib import Path
import sqlite3
from decimal import Decimal as D
from datetime import datetime, timezone
from collections import Counter
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/decisions-extension-20261007-v1'
prefix = 'decisions-extension-20261007-v1:'
db = sqlite3.connect(f'file:{ROOT / "data/research/study-budget.sqlite"}?mode=ro', uri=True)
a = [json.loads(v) for v, in db.execute('SELECT value FROM attempts')]
ours = [x for x in a if x['runId'].startswith(prefix)]
def money(rows):
    return {'knownUsd': str(sum((D(x['costUsd']) for x in rows if x['costUsd'] is not None), D(0))), 'reservedUsd': str(sum((D(x['reservedUsd']) for x in rows if x['costUsd'] is None), D(0))), 'statusCounts':dict(Counter(x['status'] for x in rows))}
phases = {}
for version, phase in [('', 'pilot'), ('v2', 'pilot'), ('v2', 'main')]:
    folder = OUT / version
    phase_prefix = prefix + (version + ':' if version else '') + phase + ':'
    m = folder / phase / 'manifest.json'
    if not m.exists(): continue
    manifest = json.loads(m.read_text())
    ids = {x['id'] for x in manifest['schedule']}
    rows = [json.loads(v) for v, in db.execute('SELECT value FROM runs WHERE substr(id,1,?)=?', (len(phase_prefix), phase_prefix))]
    result = {'planned':len(ids), 'statuses':dict(Counter(x.get('status','running') for x in rows))}
    for name in ['process','exit']:
        p = folder / f'{phase}-{name}.json'
        if p.exists(): result[name] = json.loads(p.read_text())
    if (folder/phase/'completion.json').exists(): result['completion'] = json.loads((folder/phase/'completion.json').read_text())
    phases[(version or 'v1') + ':' + phase] = result
continuation = OUT/'v2/main-continuation-20261007-v1'
continuation_state = {name:json.loads((continuation/f'{name}.json').read_text()) for name in ['dispatch','process','exit','verification'] if (continuation/f'{name}.json').exists()}
print(json.dumps({'checkedAt':datetime.now(timezone.utc).isoformat(),'phases':phases,'sharedGpuContinuation':continuation_state or None,'extension':money(ours),'global':money(a),'progress':json.loads((OUT/'v2/progress.json').read_text()) if (OUT/'v2/progress.json').exists() else None}, indent=2))
