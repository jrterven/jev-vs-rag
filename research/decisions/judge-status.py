"""Read-only, secret-free progress for the separately frozen Decisions judge."""
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import json
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
JUDGE = ROOT / 'data/research/decisions-extension-20261007-v1/v2/judge'
RUN = 'decisions-ragas-20261007-v1:'

def rows(path):
    if not path.exists():
        return []
    # An active append may leave one unfinished trailing JSONL record.
    contents = path.read_text().splitlines(keepends=True)
    return [json.loads(line) for line in contents if line.endswith('\n') and line.strip()]

samples = rows(JUDGE / 'samples.jsonl')
expected = {(row['id'], metric) for row in samples for metric in row['metrics']}
results = rows(JUDGE / 'study.results.jsonl')
terminal = {(row['sampleId'], row['metric']) for row in results}
processes = {}
for name in ['supervisor', 'bridge', 'runtime']:
    path = JUDGE / f'{name}-process.json'
    if path.exists():
        value = json.loads(path.read_text())
        processes[name] = {**value, 'live': Path('/proc', str(value['pid'])).exists()}
with sqlite3.connect(f'file:{ROOT / "data/research/study-budget.sqlite"}?mode=ro', uri=True) as db:
    db.execute('BEGIN')
    attempts = [json.loads(v) for v, in db.execute('SELECT value FROM attempts')]

def money(values):
    known = sum((Decimal(a['costUsd']) for a in values if a['costUsd'] is not None), Decimal(0))
    reserved = sum((Decimal(a['reservedUsd']) for a in values if a['costUsd'] is None), Decimal(0))
    return {'knownUsd': str(known), 'reservedUsd': str(reserved), 'committedUsd': str(known + reserved), 'statuses': dict(Counter(a['status'] for a in values))}

output = {
    'checkedAt': datetime.now(timezone.utc).isoformat(),
    'frozen': (JUDGE / 'extension-judge-freeze.json').exists(),
    'samples': len(samples), 'expectedMetricPairs': len(expected),
    'terminalMetricPairs': len(terminal), 'missingMetricPairs': len(expected - terminal),
    'duplicateRows': len(results) - len(terminal), 'unexpectedPairs': len(terminal - expected),
    'metricStatuses': dict(Counter(f"{row['metric']}:{row['status']}" for row in results)),
    'processes': processes,
    'global': money(attempts),
    'extensionIncludingJudge': money([a for a in attempts if a['runId'].startswith(('decisions-extension-20261007-v1:', RUN))]),
    'allJudges': money([a for a in attempts if a['method'] == 'ragas-judge']),
    'thisJudge': money([a for a in attempts if a['runId'].startswith(RUN)]),
}
for name in ['completion', 'halt']:
    path = JUDGE / f'{name}.json'
    if path.exists():
        output[name] = json.loads(path.read_text())
print(json.dumps(output, indent=2))
