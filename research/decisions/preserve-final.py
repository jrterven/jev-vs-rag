"""Consistent final ledger backup after the Decisions judge closes. No API calls."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/decisions-extension-20261007-v1/v2'
JUDGE = OUT / 'judge'
BACKUP = ROOT / 'data/research/study-budget-decisions-final-20261007.sqlite'
RECEIPT = OUT / 'judge-preservation.json'

def read(path):
    return json.loads(path.read_text())

def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

completion = read(JUDGE / 'completion.json')
if not completion['allMetricsTerminal'] or completion['terminal'] != completion['expected']:
    raise SystemExit('Metric cohort is incomplete.')
if (JUDGE / 'halt.json').exists():
    raise SystemExit('Judge halt requires inspection.')
for name in ['supervisor', 'bridge', 'runtime']:
    process = read(JUDGE / f'{name}-process.json')
    if Path('/proc', str(process['pid'])).exists():
        raise SystemExit(f'{name} process still present; wait for normal exit.')
for path in [JUDGE / 'study.results.jsonl.lock', JUDGE / 'bridge/bridge.lock', OUT / 'running.lock']:
    if path.exists():
        raise SystemExit('Execution lock remains: ' + str(path))
freeze = read(JUDGE / 'extension-judge-freeze.json')
for name, expected in freeze['files'].items():
    if digest(ROOT / name) != expected:
        raise SystemExit('Frozen source differs: ' + name)
if digest(JUDGE / 'samples.jsonl') != freeze['sampleSha256']:
    raise SystemExit('Judge sample bytes changed.')
samples = [json.loads(line) for line in (JUDGE / 'samples.jsonl').read_text().splitlines() if line.strip()]
results = [json.loads(line) for line in (JUDGE / 'study.results.jsonl').read_text().splitlines() if line.strip()]
expected = {(s['id'], m) for s in samples for m in s['metrics']}
actual = {(r['sampleId'], r['metric']) for r in results}
if len(results) != len(actual) or actual != expected or len(actual) != completion['terminal']:
    raise SystemExit('Duplicate, missing or foreign metric records.')
if BACKUP.exists():
    if not RECEIPT.exists() or digest(BACKUP) != read(RECEIPT)['backupSha256']:
        raise SystemExit('Existing backup lacks matching receipt; never overwrite.')
    print(json.dumps(read(RECEIPT)))
    raise SystemExit(0)
temporary = BACKUP.with_suffix('.sqlite.inprogress')
with temporary.open('xb'):
    pass
os.chmod(temporary, 0o600)
with sqlite3.connect(f'file:{ROOT / "data/research/study-budget.sqlite"}?mode=ro', uri=True) as source:
    source.execute('BEGIN')
    if any(json.loads(value)['status'] == 'pending' for value, in source.execute('SELECT value FROM attempts')):
        temporary.unlink()
        raise SystemExit('Unresolved provider calls; no final backup created.')
    with sqlite3.connect(temporary) as target:
        source.backup(target)
        if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise SystemExit('Backup integrity failure; preserve temporary file for inspection.')
temporary.rename(BACKUP)
receipt = {
    'createdAt': datetime.now(timezone.utc).isoformat(),
    'backup': str(BACKUP), 'bytes': BACKUP.stat().st_size,
    'backupSha256': digest(BACKUP), 'integrity': 'ok',
    'judgeFreezeSha256': digest(JUDGE / 'extension-judge-freeze.json'),
    'resultSha256': digest(JUDGE / 'study.results.jsonl'),
    'completionSha256': digest(JUDGE / 'completion.json'),
    'sourceSha256': digest(Path(__file__)),
    'expectedMetricPairs': len(expected), 'terminalMetricPairs': len(actual),
    'policy': 'Consistent SQLite backup after all judge processes exited. Preserves errors and unknown usage. Final scientific/cost audit follows separately.',
}
with RECEIPT.open('x') as target:
    json.dump(receipt, target, indent=2)
print(json.dumps(receipt))
