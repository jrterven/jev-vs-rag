"""Post-retrieval lineage gate, consistent backup and frozen judge inputs. No APIs."""
from pathlib import Path
import hashlib
import json
import sqlite3
import subprocess

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'data/research/decisions-extension-20261007-v1/v2'
PHASE=OUT/'main'
BACKUP=ROOT/'data/research/study-budget-decisions-retrieval-final-20261007.sqlite'
PRIOR=ROOT/'data/research/study-budget-ragas-cohort-final-20261006.sqlite'
NODE=ROOT/'.runtime/node-v24.21.0-linux-arm64/bin/node'
def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(path):return json.loads(path.read_text())
exit_record=read(OUT/'main-exit.json')
continuation=None
if exit_record['exitCode']!=0:
    from continue_main import verify, RECORDS
    # The original exit stays 1. A separate audited execution block must finish
    # every still-unattempted assignment, retaining all historical failures.
    if not (RECORDS/'verification.json').exists():raise SystemExit('Continuation verification missing; do not launch judge.')
    verified=verify(save=False)
    exit_record=read(RECORDS/'exit.json')
    continuation={'kind':'authorized-shared-gpu-unattempted-only','records':str(RECORDS),'files':{name:digest(RECORDS/name) for name in ['preflight.json','process.json','exit.json','verification.json']},'oldRowsUnchanged':verified['oldRowsUnchanged'],'terminalRetrievalRetries':verified['terminalRetrievalRetries']}
if exit_record['exitCode']!=0 or Path('/proc',str(exit_record['pid'])).exists() or (OUT/'running.lock').exists():raise SystemExit('Retrieval/generation process has not exited cleanly.')
completed=read(PHASE/'completion.json')
if not completed['allRetrievalTerminal'] or completed['generationTerminal']!=completed['generationPlanned'] or completed['exitError']:raise SystemExit('Incomplete cohort.')
if digest(PRIOR)!='66fb1133e10f524ae444a6918f243c69a335c389a68c52da57f0d28f1e98c874':raise SystemExit('Original study backup changed.')
source=sqlite3.connect(f'file:{ROOT/"data/research/study-budget.sqlite"}?mode=ro',uri=True)
if any(json.loads(v)['status']=='pending' for v, in source.execute('SELECT value FROM attempts')):raise SystemExit('Global pending calls: audit before judge.')
source.execute('ATTACH DATABASE ? AS old',(str(PRIOR),))
checks={}
for table,key in [('attempts','id'),('runs','id'),('immutable','key'),('responses','key')]:
    count=source.execute(f'SELECT count(*) FROM old.{table}').fetchone()[0]
    columns=[r[1] for r in source.execute(f'PRAGMA main.table_info({table})')]
    if columns!=[r[1] for r in source.execute(f'PRAGMA old.table_info({table})')]:raise SystemExit('Historical table schema changed: '+table)
    predicate=' OR '.join(f'n.{column} IS NOT o.{column}' for column in columns)
    changed=source.execute(f'SELECT count(*) FROM old.{table} o LEFT JOIN main.{table} n ON n.{key}=o.{key} WHERE n.{key} IS NULL OR {predicate}').fetchone()[0]
    if changed:raise SystemExit(f'Historical rows changed in {table}: {changed}')
    checks[table]={'unchanged':count,'changedOrMissing':changed}
source.execute('DETACH DATABASE old')
receipt_path=OUT/'retrieval-preservation.json'
if BACKUP.exists():
    if not receipt_path.exists() or digest(BACKUP)!=read(receipt_path)['backupSha256']:raise SystemExit('Existing backup is not verified; never overwrite.')
else:
    target=sqlite3.connect(BACKUP);source.backup(target)
    if target.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise SystemExit('Backup integrity failure')
    target.close()
    receipt={'backup':str(BACKUP),'backupSha256':digest(BACKUP),'bytes':BACKUP.stat().st_size,'integrity':'ok','historicalRows':checks,'manifestSha256':digest(PHASE/'manifest.json'),'reportSha256':digest(PHASE/'report.json'),'completion':completed}
    with receipt_path.open('x') as f:json.dump(receipt,f,indent=2)
source.close()
JUDGE=OUT/'judge';JUDGE.mkdir(exist_ok=True)
subprocess.run([str(NODE),'--import','tsx','research/ragas/study-export.ts','--ledger',str(BACKUP),'--out',str(JUDGE),'--scope','test','--experiment','decisions-extension='+str(PHASE)],cwd=ROOT,check=True)
source_files=['research/decisions/prepare-judge.py','research/decisions/bridge.ts','research/decisions/judge-launch.py','research/ragas/runtime.py','research/ragas/study-export.ts','research/ragas/export.ts','research/ledger.ts','research/util.ts','server/engines/common.ts']
if continuation:source_files.extend(['research/decisions/continue_main.py','research/decisions/run-shared-gpu.ts','research/decisions/shared-gpu-policy.ts'])
if digest(ROOT/'research/ragas/runtime.py')!='d497d7fa6ad46348d1cf92ba0788c08dd8c2ddf7fd2b24e25c2b7e1c2d998a5b':raise SystemExit('Frozen scientific judge runtime changed.')
files={name:digest(ROOT/name) for name in source_files}
aliases={'source-snapshot/ragas/bridge.ts':'research/decisions/bridge.ts'}
# The original offline auditor expects this legacy artifact path. These are the
# NEW bridge bytes; the explicit alias prevents confusing them with the old bridge.
for target,name in {**{'source-snapshot/'+name.removeprefix('research/'):name for name in source_files},**aliases}.items():
    path=JUDGE/target;path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if digest(path)!=files[name]:raise SystemExit('Source snapshot changed: '+target)
    else:
        with path.open('xb') as f:f.write((ROOT/name).read_bytes())
manifest={'schemaVersion':1,'runId':'decisions-ragas-20261007-v1','files':files,'legacyAuditSourceAliases':aliases,'sampleSha256':digest(JUDGE/'samples.jsonl'),'retrievalBackupSha256':digest(BACKUP),'budgetUsd':'20','cumulativeJudgeCapUsd':'80','extensionCombinedCapUsd':'100','globalCapUsd':'200','failurePolicy':'Retain every terminal metric and unknown reserve. Continue only unattempted pairs after isolated failures. Stop at three consecutive provider failures, access/provenance/budget failure or unresolved calls. No provider retries.','metricPolicy':'Unchanged official RAGAS 0.4.3 FA/AA; gpt-6.1-sol medium; 8192 output tokens, concurrency 2; no human calibration claim for these new samples.'}
if continuation:manifest['retrievalContinuation']=continuation
p=JUDGE/'extension-judge-freeze.json'
if p.exists():
    if read(p)!=manifest:raise SystemExit('Judge source/config freeze mismatch')
else:
    with p.open('x') as f:json.dump(manifest,f,indent=2)
print(json.dumps({'ready':True,'backup':str(BACKUP),'judgeInputs':str(JUDGE),'sourceFreeze':str(p)}))
