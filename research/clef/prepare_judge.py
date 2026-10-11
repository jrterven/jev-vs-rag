#!/usr/bin/env python3
"""Preserve completed generation and export unchanged RAGAS inputs. No APIs."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,sqlite3,subprocess
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'data/research/clef-extension-20261009-v1'
EXPERIMENT=OUT/'experiment';JUDGE=OUT/'judge'
NODE=ROOT/'.runtime/node-v24.21.0-linux-arm64/bin/node'
BACKUP=ROOT/'data/research/study-budget-clef-generation-final-20261009.sqlite'
RUN='clef-ragas-20261009-v1'
def read(p):return json.loads(p.read_text())
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def exclusive(p,v):
    with p.open('x') as f:json.dump(v,f,indent=2)

def prepare():
    finished=read(OUT/'generation-exit.json');assert finished['exitCode']==0
    assert not Path('/proc',str(finished['pid']),'cmdline').exists()
    completion=read(EXPERIMENT/'completion.json')
    assert completion['generationTerminal']==completion['generationPlanned']==400 and completion['exitError'] is None
    assert completion['allPrimaryRetrievalTerminal'] and not completion['fullTimingScheduleComplete']
    assert not (EXPERIMENT/'generation.lock').exists()
    frozen=read(EXPERIMENT/'generation-source-freeze.json')
    for name,sha in frozen['files'].items():assert digest(ROOT/name)==sha,'Generation source changed: '+name
    assert digest(ROOT/'research/ragas/runtime.py')=='d497d7fa6ad46348d1cf92ba0788c08dd8c2ddf7fd2b24e25c2b7e1c2d998a5b','Frozen RAGAS runtime changed'
    with sqlite3.connect(f'file:{ROOT}/data/research/study-budget.sqlite?mode=ro',uri=True) as source:
        source.execute('BEGIN')
        assert not any(json.loads(v)['status']=='pending' for v, in source.execute('SELECT value FROM attempts'))
        assert not source.execute("SELECT id FROM runs WHERE status='running'").fetchone()
        receipt=OUT/'generation-preservation.json'
        if BACKUP.exists():assert receipt.exists() and digest(BACKUP)==read(receipt)['backupSha256']
        else:
            with BACKUP.open('xb'):pass
            BACKUP.chmod(0o600)
            with sqlite3.connect(BACKUP) as target:
                source.backup(target);assert target.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
            exclusive(receipt,{'at':datetime.now(timezone.utc).isoformat(),'backup':str(BACKUP),'bytes':BACKUP.stat().st_size,'backupSha256':digest(BACKUP),'integrity':'ok','generationCompletionSha256':digest(EXPERIMENT/'completion.json'),'reportSha256':digest(EXPERIMENT/'report.json'),'noPendingCalls':True})
    subprocess.run([str(NODE),'--import','tsx','research/ragas/study-export.ts','--ledger',str(BACKUP),'--out',str(JUDGE),'--scope','test','--experiment','clef='+str(EXPERIMENT)],cwd=ROOT,check=True)
    export=read(JUDGE/'export-manifest.json');assert export['sampleCount']+len(export['missing'])==400
    files=['research/clef/prepare_judge.py','research/clef/bridge.ts','research/clef/judge_launch.py','research/clef/secondary.ts','research/ragas/runtime.py','research/ragas/study-export.ts','research/ragas/export.ts','research/ledger.ts','research/util.ts','research/context.ts','server/engines/common.ts']
    hashes={name:digest(ROOT/name) for name in files}
    aliases={'source-snapshot/ragas/bridge.ts':'research/clef/bridge.ts'}
    for target,name in {**{'source-snapshot/'+n.removeprefix('research/'):n for n in files},**aliases}.items():
        p=JUDGE/target;p.parent.mkdir(parents=True,exist_ok=True)
        if p.exists():assert digest(p)==hashes[name]
        else:
            with p.open('xb') as f:f.write((ROOT/name).read_bytes())
    freeze={'schemaVersion':1,'runId':RUN,'files':hashes,'legacyAuditSourceAliases':aliases,'sampleSha256':digest(JUDGE/'samples.jsonl'),'retrievalBackupSha256':digest(BACKUP),'budgetUsd':'20','cumulativeJudgeCapUsd':'80','extensionCombinedCapUsd':'100','globalCapUsd':'200',
            'retrievalAmendmentSha256':read(OUT/'retrieval/main-v1-amended-audit.json')['amendmentSha256'],
            'failurePolicy':'Terminal metrics, failures and unknown reserves are immutable. Only unattempted pairs may continue after isolated errors; no provider retries. Stop for three consecutive failures, unresolved attempts, access/budget/provenance errors.',
            'metricPolicy':'Unchanged official RAGAS0.4.3 FA/AA; gpt-6.1-sol medium;8192 output tokens;concurrency2. Same200 frozen questions, generator and references; no human calibration claim for new samples.'}
    p=JUDGE/'extension-judge-freeze.json'
    if p.exists():assert read(p)==freeze
    else:exclusive(p,freeze)
    print(json.dumps({'ready':True,'judge':str(JUDGE),'samples':export['sampleCount'],'pairs':export['requestedMetrics'],'missingGenerations':len(export['missing']),'paidCalls':0}))
if __name__=='__main__':prepare()
