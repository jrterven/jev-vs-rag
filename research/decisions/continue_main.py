"""Audited user-authorized shared-GPU continuation; no terminal retries.

The original retrieval/generator adapters remain unchanged. A separate runner
records shared execution and excludes these times from isolated-GPU summaries.
"""
from datetime import datetime, timezone
from decimal import Decimal as D
from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/decisions-extension-20261007-v1/v2'
RECORDS = OUT / 'main-continuation-20261007-v1'
BACKUP = ROOT / 'data/research/study-budget-decisions-gpu-stop-20261007.sqlite'
LIVE = ROOT / 'data/research/study-budget.sqlite'
NODE = ROOT / '.runtime/node-v24.21.0-linux-arm64/bin/node'
MANIFEST_SHA = 'c0df2976828a24632b757d6a1031c3de6e647cb19d0c9c15b4f6908a532ab836'
ORIGINAL_SHA = '66fb1133e10f524ae444a6918f243c69a335c389a68c52da57f0d28f1e98c874'
PREFIX = 'decisions-extension-20261007-v1:v2:main:'
TABLES = [('attempts', 'id'), ('runs', 'id'), ('immutable', 'key'), ('responses', 'key')]

def stamp():
    return datetime.now(timezone.utc).isoformat()

def read(path):
    return json.loads(path.read_text())

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def need(condition, message):
    if not condition:
        raise RuntimeError(message)

def exclusive(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')

def connect(path):
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)

def unchanged(db, prior):
    """All columns in all old rows must still match, including nulls."""
    db.execute('ATTACH DATABASE ? AS prior', (str(prior),))
    checks = {}
    try:
        for table, key in TABLES:
            columns = [r[1] for r in db.execute(f'PRAGMA main.table_info({table})')]
            need(columns == [r[1] for r in db.execute(f'PRAGMA prior.table_info({table})')], 'Schema changed: ' + table)
            predicate = ' OR '.join(f'n.{col} IS NOT o.{col}' for col in columns)
            changed = db.execute(f'SELECT count(*) FROM prior.{table} o LEFT JOIN main.{table} n ON n.{key}=o.{key} WHERE n.{key} IS NULL OR {predicate}').fetchone()[0]
            need(changed == 0, 'Historical rows changed: ' + table)
            checks[table] = db.execute(f'SELECT count(*) FROM prior.{table}').fetchone()[0]
    finally:
        db.execute('DETACH DATABASE prior')
    return checks

def sources():
    need(digest(OUT / 'main/manifest.json') == MANIFEST_SHA, 'Main manifest changed')
    snapshot = read(OUT / 'main/source-snapshot.json')
    need(snapshot['hash'] == '67377d5e7ef4ae96a759e09b1792d6675fad7f7edc8be8d7fc39e8db7e825296', 'Source snapshot identity changed')
    for name, text in snapshot['files'].items():
        need((ROOT / name).read_bytes() == text.encode(), 'Frozen source changed: ' + name)
    return {'manifestSha256': MANIFEST_SHA, 'sourceSnapshotSha256': digest(OUT / 'main/source-snapshot.json'), 'supervisorSha256': digest(Path(__file__)), 'sharedRunnerSha256': digest(ROOT/'research/decisions/run-shared-gpu.ts'), 'sharedPolicySha256': digest(ROOT/'research/decisions/shared-gpu-policy.ts')}

def gpu_available():
    command = [str(NODE), '--import', 'tsx', '--input-type=module', '-e', "import {probeGpu} from './research/hardware.ts'; console.log(JSON.stringify(probeGpu()));"]
    gpu = json.loads(subprocess.check_output(command, cwd=ROOT, timeout=20, text=True))
    need(gpu['available'], 'GPU availability cannot be verified')
    return gpu

def state(db):
    attempts = [json.loads(v) for v, in db.execute('SELECT value FROM attempts')]
    need(not any(a['status'] == 'pending' for a in attempts), 'Pending API calls')
    need(not db.execute("SELECT 1 FROM runs WHERE status='running'").fetchone(), 'Running ledger case')
    need(not db.execute("SELECT 1 FROM immutable WHERE key='budget-halt'").fetchone(), 'Budget halt')
    def money(rows):
        known = sum((D(a['costUsd']) for a in rows if a['costUsd'] is not None), D(0))
        reserve = sum((D(a['reservedUsd']) for a in rows if a['costUsd'] is None), D(0))
        return {'knownUsd': str(known), 'reservedUsd': str(reserve), 'committedUsd': str(known + reserve)}
    global_cost = money(attempts)
    extension_cost = money([a for a in attempts if a['runId'].startswith('decisions-extension-20261007-v1:')])
    need(D(global_cost['committedUsd']) + 20 < 200 and D(extension_cost['committedUsd']) + 20 < 100, 'Insufficient budget including judge allowance')
    manifest = read(OUT / 'main/manifest.json')
    runs = {rid: json.loads(value) for rid, value in db.execute('SELECT id,value FROM runs WHERE substr(id,1,?)=?', (len(PREFIX), PREFIX))}
    assigned = {row['id'] for row in manifest['schedule']}
    need(set(runs).issubset(assigned), 'Unscheduled existing run')
    need(all(row['status'] in ('completed', 'failed') for row in runs.values()), 'Nonterminal existing case')
    return {'existing': len(runs), 'failed': sum(r['status'] == 'failed' for r in runs.values()), 'remainingIds': [r['id'] for r in manifest['schedule'] if r['id'] not in runs], 'global': global_cost, 'extension': extension_cost}

def stopped():
    for name in ['main-process.json', 'main-exit.json']:
        receipt = read(OUT / name)
        for key in ['pid', 'supervisorPid']:
            need(not receipt.get(key) or not Path('/proc', str(receipt[key])).exists(), 'Original process still exists')
    need(not (OUT / 'running.lock').exists(), 'Runner lock exists')

def prepare():
    stopped()
    need(read(OUT / 'main-exit.json')['exitCode'] == 1, 'Unexpected original exit')
    need(read(OUT / 'main/completion.json')['exitError'] == 'GPU occupied or unavailable; no comparable timing.', 'Unexpected halt cause')
    need(not RECORDS.exists() and not BACKUP.exists(), 'Preservation already exists; inspect it, never overwrite')
    source_info = sources()
    gpu = gpu_available()
    original = ROOT / 'data/research/study-budget-ragas-cohort-final-20261006.sqlite'
    need(digest(original) == ORIGINAL_SHA, 'Original closed-study backup changed')
    with connect(LIVE) as db:
        before = state(db)
        need(before['existing'] == 1262 and before['failed'] == 12 and len(before['remainingIds']) == 90, 'Unexpected halted cohort')
        checks = unchanged(db, original)
        with sqlite3.connect(BACKUP) as target:
            db.backup(target)
            need(target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Backup integrity failed')
    RECORDS.mkdir()
    files = {}
    for name in ['main-process.json', 'main-exit.json', 'main.log', 'main-supervisor.log', 'progress.json', 'main/completion.json', 'main/report.json']:
        origin = OUT / name
        target = RECORDS / 'halted' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, target)
        files[name] = digest(target)
    exclusive(RECORDS / 'preflight.json', {'schemaVersion': 1, 'recordedAt': stamp(), 'kind': 'same-cohort-unattempted-only-shared-gpu', 'policyId': 'juan-authorized-shared-gpu-20261007-v1', 'authorization': 'Juan: cual proceso ajeno? no creo que el proceso ajeno utilice 100% del GPU. Puedes usarlo', 'reason': 'Original GPU guard halted. Juan explicitly authorized sharing the GPU; another resident process does not imply full utilization. Historical guard cause remains unknown.', 'source': source_info, 'backup': str(BACKUP), 'backupSha256': digest(BACKUP), 'backupBytes': BACKUP.stat().st_size, 'integrity': 'ok', 'originalRowsUnchanged': checks, 'preservedFiles': files, 'gpu': gpu, 'before': before, 'policy': 'New operational runner, unchanged scientific adapters and schedule. Skip all 1262 terminal cases including 12 failures. Complete only remaining 90 scheduled retrievals and original generation assignments. Retain all usage reservations. Record shared GPU probes and mark every new timing as shared; exclude it from isolated-GPU summaries.'})
    print(json.dumps({'prepared': True, 'remainingRetrievals': 90, 'receipt': str(RECORDS / 'preflight.json')}))

def check_preflight():
    receipt = read(RECORDS / 'preflight.json')
    need(receipt['source'] == sources(), 'Continuation source changed')
    need(digest(BACKUP) == receipt['backupSha256'], 'Pre-continuation backup changed')
    for name, expected in receipt['preservedFiles'].items():
        need(digest(RECORDS / 'halted' / name) == expected, 'Preserved stop artifact changed')
    return receipt

def launch():
    stopped()
    need(not (RECORDS / 'process.json').exists() and not (RECORDS / 'dispatch.json').exists() and not (RECORDS / 'exit.json').exists(), 'Continuation already dispatched')
    receipt = check_preflight()
    need((datetime.now(timezone.utc) - datetime.fromisoformat(receipt['recordedAt'])).total_seconds() < 600, 'Preflight older than ten minutes')
    with connect(LIVE) as db:
        need(state(db) == receipt['before'], 'Ledger state changed after preflight')
        unchanged(db, BACKUP)
    gpu = gpu_available()
    with (RECORDS / 'supervisor.log').open('x') as output:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'supervise'], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
    value = {'supervisorPid': process.pid, 'startedAt': stamp(), 'gpu': gpu, 'preflightSha256': digest(RECORDS / 'preflight.json')}
    exclusive(RECORDS / 'dispatch.json', value)
    print(json.dumps(value))

def supervise():
    stopped()
    check_preflight()
    gpu_available()
    command = [str(NODE), '--import', 'tsx', 'research/decisions/run-shared-gpu.ts', 'run', 'main', '--allow-paid']
    with (RECORDS / 'runner.log').open('x') as output:
        child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        start = {'pid': child.pid, 'supervisorPid': os.getpid(), 'startedAt': stamp(), 'command': command, 'preflightSha256': digest(RECORDS / 'preflight.json')}
        exclusive(RECORDS / 'process.json', start)
        code = child.wait()
    exclusive(RECORDS / 'exit.json', {**start, 'finishedAt': stamp(), 'exitCode': code})

def validate_new_attempts(extra, remaining, generations, old_runs):
    for attempt in extra:
        rid = attempt['runId']
        if attempt['operation'] == 'generation':
            need(rid in generations and (rid not in old_runs or old_runs[rid]['status'] == 'completed'), 'Unassigned generation')
        else:
            need(rid in remaining, 'Terminal retrieval was retried')

def verify(save=True):
    receipt = check_preflight()
    exit_record = read(RECORDS / 'exit.json')
    need(exit_record['exitCode'] == 0 and not Path('/proc', str(exit_record['pid'])).exists() and not (OUT / 'running.lock').exists(), 'Continuation not cleanly exited')
    need(digest(OUT / 'main-exit.json') == receipt['preservedFiles']['main-exit.json'], 'Original exit receipt changed')
    completed = read(OUT / 'main/completion.json')
    need(completed['allRetrievalTerminal'] and completed['generationTerminal'] == 400 and not completed['exitError'], 'Incomplete continuation')
    with connect(BACKUP) as prior:
        old_attempts = {row[0] for row in prior.execute('SELECT id FROM attempts')}
        old_runs = {rid: json.loads(v) for rid, v in prior.execute('SELECT id,value FROM runs')}
    manifest = read(OUT / 'main/manifest.json')
    generations = {r['id'] for r in manifest['schedule'] if r['generate']}
    with connect(LIVE) as db:
        checks = unchanged(db, BACKUP)
        after = state(db)
        need(not after['remainingIds'] and after['failed'] >= 12, 'Incomplete or lost failures')
        extra = [json.loads(v) for key, v in db.execute('SELECT id,value FROM attempts') if key not in old_attempts]
        validate_new_attempts(extra, receipt['before']['remainingIds'], generations, old_runs)
        for rid in receipt['before']['remainingIds']:
            row = json.loads(db.execute('SELECT value FROM runs WHERE id=?',(rid,)).fetchone()[0])
            need(row.get('timingValid') is False and row.get('timingEnvironment') == 'shared-gpu' and row.get('operationalContinuationId') == receipt['policyId'], 'Shared timing was relabeled as isolated')
    result = {'verifiedAt': stamp(), 'preflightSha256': digest(RECORDS / 'preflight.json'), 'exitSha256': digest(RECORDS / 'exit.json'), 'oldRowsUnchanged': checks, 'newAttempts': len(extra), 'terminalRetrievalRetries': 0, 'after': after, 'completion': completed}
    if save:
        need(not (RECORDS / 'verification.json').exists(), 'Verification already saved')
        exclusive(RECORDS / 'verification.json', result)
        print(json.dumps(result))
    return result

if __name__ == '__main__':
    actions = {'prepare': prepare, 'launch': launch, 'supervise': supervise, 'verify': verify}
    need(len(sys.argv) == 2 and sys.argv[1] in actions, 'Use prepare|launch|supervise|verify')
    actions[sys.argv[1]]()
