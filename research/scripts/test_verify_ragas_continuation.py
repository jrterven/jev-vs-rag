"""Offline synthetic lineage fixtures; no model calls, SSH, or real ledger writes."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verify_ragas_continuation', Path(__file__).with_name('verify-ragas-continuation.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def encoded(x):
    return json.dumps(x, separators=(',', ':'), ensure_ascii=False)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def append(path, row):
    with path.open('a') as f:
        f.write(encoded(row) + '\n')


class ContinuationAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base, self.after = self.root/'baseline', self.root/'after'
        self.base.mkdir(); (self.base/'bridge/requests').mkdir(parents=True)
        self.baseline_ledger, self.ledger = self.root/'baseline.sqlite', self.root/'after.sqlite'
        self.archive = self.root/'baseline.tar.gz'; self.archive.write_bytes(b'synthetic archive fixture')
        self.ack_path = self.root/'ack.json'
        self.run = v.RUN_ID; self.prefix = self.run + ':'
        original = ['research/ragas/bridge.ts', 'research/ragas/runtime.py', 'research/ledger.ts', 'research/util.ts', 'server/engines/common.ts', 'server/costs.ts']
        continuation = ['research/ragas/continuation-bridge.ts', 'research/ragas/continuation-policy.ts']
        refs = {'original': [], 'continuation': []}
        launch = {'files': {}}
        for name in original + continuation:
            path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('// synthetic '+name+'\n')
            refs['original' if name in original else 'continuation'].append({'path': name, 'sha256': v.file_sha(path)})
            if name in original:
                relative = name.removeprefix('research/') if name.startswith('research/') else 'repository/'+name
                target = self.base/'source-snapshot'/relative; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path,target)
                launch['files'][name] = {'snapshot': relative, 'sha256': v.file_sha(path)}
        samples = [{'id': sample, 'metrics': [metric]} for sample,metric in [('good','faithfulness'),('unknown','answer_accuracy'),('guard','answer_accuracy'),('new','answer_accuracy')]]
        for name in ['samples.jsonl','all-inputs.jsonl']:
            for row in samples: append(self.base/name,row)
        self.config = {'schemaVersion':1,'runId':self.run,'model':'gpt-6.1-sol','maxEvalUsd':'80','globalBudgetUsd':'200','concurrency':2,'retries':0,'stopOnSettledUnknownUsage':True,'inputHash':v.file_sha(self.base/'all-inputs.jsonl'),'bridgeSourceHash':v.file_sha(self.root/'research/ragas/bridge.ts'),'ledgerSourceHash':v.file_sha(self.root/'research/ledger.ts'),'price':{'input':'2','output':'10'}}
        write(self.base/'bridge/bridge-config.json',self.config)
        write(self.base/'study.results.jsonl.manifest.json',{'runId':self.run,'inputSha256':v.file_sha(self.base/'samples.jsonl'),'runtimeSha256':v.file_sha(self.root/'research/ragas/runtime.py')})
        write(self.base/'launch-snapshot.json',launch)
        for name in ['export-manifest.json','launch-started.json','preflight.json','study-amendment.json']: write(self.base/name, {'synthetic':True})
        (self.base/'pip-freeze.txt').write_text('synthetic==1\n')
        for sample,metric,status in [('good','faithfulness','completed'),('unknown','answer_accuracy','error'),('guard','answer_accuracy','error')]:
            append(self.base/'study.results.jsonl',{'sampleId':sample,'metric':metric,'status':status,'score':0.5 if status=='completed' else None,'calls':[]})
        (self.base/'study.results.jsonl.calls.jsonl').write_text('')
        write(self.base/'bridge/requests/historical.json', {'private':'PRESERVE_DONT_PRINT'})
        write(self.base/'bridge/budget.json',{'historical':True})
        self.unknown = {'id':v.UNKNOWN_ID,'logicalKey':self.prefix+'judge:old','runId':self.prefix+'old','documentId':'unknown','method':'ragas-judge','operation':'ragas_answer_accuracy','model':'gpt-6.1-sol','payloadHash':v.UNKNOWN_PAYLOAD,'price':self.config['price'],'reservedUsd':'0.76192','status':'unknown','costUsd':None,'error':'fetch failed'}
        self.unknown_raw = encoded(self.unknown)
        with sqlite3.connect(self.baseline_ledger) as db:
            db.executescript('CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE attempts(id TEXT PRIMARY KEY,logical_key TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE responses(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,value TEXT NOT NULL);')
            db.execute('INSERT INTO attempts VALUES(?,?,?)',(v.UNKNOWN_ID,self.unknown['logicalKey'],self.unknown_raw))
            db.execute('INSERT INTO responses VALUES(?,?)',('old-response','{"private":"BASELINE"}'))
            db.execute('INSERT INTO runs VALUES(?,?,?)',('old-run','completed','{"result":42}'))
            self.freeze(db,'budget-limit',{'maxBudgetUsd':'200'})
            self.freeze(db,'budget-scope:'+self.prefix,{'runPrefix':self.prefix,'maxBudgetUsd':'80'})
            self.freeze(db,'ragas:'+self.run+':config',self.config)
        self.ack = {'schemaVersion':1,'kind':'ragas-judge-continuation','runId':self.run,'authorization':{'literal':'Si continua con las evaluaciones pendientes','authorizedBy':'Juan Terven','authorizedAt':'2026-10-05T23:00:00Z'},'baseline':{'configHash':v.canonical_hashes([self.config])[0],'configFileSha256':v.file_sha(self.base/'bridge/bridge-config.json'),'ledgerBackup':{'path':'baseline.sqlite','sha256':v.file_sha(self.baseline_ledger)},'phaseArchive':{'path':'baseline.tar.gz','sha256':v.file_sha(self.archive)},'input':{'path':'baseline/samples.jsonl','sha256':v.file_sha(self.base/'samples.jsonl')},'results':{'path':'baseline/study.results.jsonl','prefixBytes':(self.base/'study.results.jsonl').stat().st_size,'prefixSha256':v.file_sha(self.base/'study.results.jsonl'),'terminalRows':3}},'allowedUnknown':{'attemptId':v.UNKNOWN_ID,'valueSha256':v.sha_bytes(self.unknown_raw.encode()),'canonicalHash':v.canonical_hashes([self.unknown])[0],'payloadHash':v.UNKNOWN_PAYLOAD,'reservedUsd':'0.76192'},'sources':refs}
        write(self.ack_path,self.ack)
        shutil.copytree(self.base,self.after); shutil.copyfile(self.baseline_ledger,self.ledger)
        self.args=argparse.Namespace(baseline_phase=self.base,phase=self.after,baseline_ledger=self.baseline_ledger,ledger=self.ledger,baseline_archive=self.archive,ack=self.ack_path,source_root=self.root,node='node',preflight=True,require_terminal=False)
        # Only cohort cardinalities shrink in synthetic fixtures. IDs, accounting,
        # byte-preservation and policy checks execute unchanged.
        self.counts = patch.object(v,'BASE_COUNTS',{'requested':4,'terminal':3,'completed':1,'error':2})
        self.counts.start(); self.addCleanup(self.counts.stop)

    def freeze(self,db,key,value):
        db.execute('INSERT INTO immutable VALUES(?,?,?)',(key,v.canonical_hashes([value])[0],encoded(value)))

    def finish(self):
        calls=[]
        with sqlite3.connect(self.ledger) as db:
            for ordinal in (1,2):
                rid='ragas:'+v.sha_bytes(encoded([self.run,'new','answer_accuracy',ordinal]).encode()); key=v.sha_bytes(rid.encode()); logical=self.prefix+'judge:'+key
                request={'requestId':rid,'sampleId':'new','metric':'answer_accuracy'}
                record={'request':request,'payloadHash':'a'*64}
                write(self.after/'bridge/requests'/f'{key}.json',record)
                append(self.after/'study.results.jsonl.calls.jsonl',{'event':'request','sampleId':'new','metric':'answer_accuracy','payload':request})
                a={'id':'new-'+str(ordinal),'logicalKey':logical,'runId':self.prefix+key,'documentId':'new','operation':'ragas_answer_accuracy','method':'ragas-judge','model':self.config['model'],'price':self.config['price'],'payloadHash':'a'*64,'reservedUsd':'0.76192','costUsd':'0.01','status':'completed'}
                db.execute('INSERT INTO attempts VALUES(?,?,?)',(a['id'],logical,encoded(a)))
                self.freeze(db,logical+':input',record)
                self.freeze(db,logical+':result',{'ok':True,'attemptId':a['id']})
                db.execute('INSERT INTO responses VALUES(?,?)',(logical,'{"status":200}'))
                calls.append({'requestId':rid,'attemptId':a['id'],'status':'completed'})
            lineage={'schemaVersion':1,'kind':'ragas-judge-continuation-lineage','acknowledgment':self.ack,'acknowledgmentHash':v.canonical_hashes([self.ack])[0],'acknowledgmentFileHash':v.file_sha(self.ack_path),'originalConfigHash':self.ack['baseline']['configHash'],'continuationSourceHash':v.file_sha(self.root/'research/ragas/continuation-bridge.ts'),'policySourceHash':v.file_sha(self.root/'research/ragas/continuation-policy.ts')}
            write(self.after/'bridge/continuation.json',lineage)
            self.freeze(db,'ragas:'+self.run+':continuation',lineage)
        append(self.after/'study.results.jsonl',{'sampleId':'new','metric':'answer_accuracy','status':'completed','score':0.5,'calls':calls})
        totals={'knownUsd':'0.02','reservedUsd':'0.76192','committedUsd':'0.78192','unknownAttempts':1}
        write(self.after/'bridge/continuation-budget.json',{'runId':self.run,'maxEvalUsd':'80','global':totals,'evaluation':totals})
        self.args.preflight=False; self.args.require_terminal=True

    def test_preflight_read_only_and_incomplete_explicit(self):
        before=v.file_sha(self.ledger)
        r=v.verify(self.args)
        self.assertTrue(r['ok']); self.assertFalse(r['allMetricsTerminal']); self.assertEqual(r['missingMetrics'],1)
        self.assertEqual(r['newPaidAttempts'],0); self.assertEqual(v.file_sha(self.ledger),before)
        self.assertNotIn('PRESERVE_DONT_PRINT',json.dumps(r))

    def test_completed_continuation_preserves_unknown_and_records_lineage(self):
        self.finish(); r=v.verify(self.args)
        self.assertTrue(r['allMetricsTerminal']); self.assertEqual(r['terminalStatusCounts'],{'completed':2,'error':2})
        self.assertEqual(r['acknowledgedUnknownPreserved']['status'],'unknown'); self.assertIsNone(r['acknowledgedUnknownPreserved']['costUsd'])
        self.assertEqual(r['newPaidAttempts'],2); self.assertEqual(r['budgets']['judge']['knownUsd'],'0.02')
        self.assertEqual(r['resultsSha256'],v.file_sha(self.after/'study.results.jsonl'))

    def test_receipt_schema_matches_offline_cost_and_package_contract(self):
        self.finish(); r=v.verify(self.args)
        self.assertEqual(set(r), {
            'schemaVersion','kind','recordedAt','ok','preflight','runId','acknowledgmentSha256',
            'auditorSourceSha256','baselineLedgerSha256','ledgerSha256','baselineRowsPreserved',
            'resultsSha256','callsSha256','lineageSha256','continuationBudgetSha256','historicalBudgetSha256',
            'frozenFilesPreserved','oldRequestResponseFilesPreserved','resultPrefix','callTracePrefix',
            'originalTerminalMetrics','expectedMetrics','newTerminalMetrics','terminalMetrics','missingMetrics',
            'allMetricsTerminal','terminalStatusCounts','newRequests','newPaidAttempts','newUnknownAttempts',
            'acknowledgedUnknownPreserved','budgets','sourceHashes','limitations'})
        self.assertEqual(r['historicalBudgetSha256'],v.file_sha(self.base/'bridge/budget.json'))
        self.assertEqual(r['historicalBudgetSha256'],v.file_sha(self.after/'bridge/budget.json'))
        self.assertEqual(r['continuationBudgetSha256'],v.file_sha(self.after/'bridge/continuation-budget.json'))
        self.assertEqual(r['auditorSourceSha256'],v.file_sha(Path(v.__file__)))
        self.assertNotEqual(r['historicalBudgetSha256'],r['continuationBudgetSha256'])

    def test_all_four_historical_tables_immutable(self):
        for table,key,column in [('attempts','id','value'),('immutable','key','value'),('responses','key','value'),('runs','id','status')]:
            with self.subTest(table=table):
                shutil.copyfile(self.baseline_ledger,self.ledger)
                with sqlite3.connect(self.ledger) as db:
                    row=db.execute(f'SELECT {key} FROM {table} LIMIT 1').fetchone()[0]
                    db.execute(f'UPDATE {table} SET {column}=? WHERE {key}=?',('changed',row))
                with self.assertRaisesRegex(v.AuditError,'Historical ledger row'):
                    v.verify(self.args)

    def test_terminal_error_prefix_change_rejected(self):
        path=self.after/'study.results.jsonl'; path.write_text(path.read_text().replace('"guard"','"forged"'))
        with self.assertRaisesRegex(v.AuditError,'prefix changed'):v.verify(self.args)

    def test_request_for_unpaid_terminal_guard_error_rejected(self):
        rid='ragas:'+v.sha_bytes(encoded([self.run,'guard','answer_accuracy',1]).encode()); key=v.sha_bytes(rid.encode())
        write(self.after/'bridge/requests'/f'{key}.json',{'request':{'requestId':rid,'sampleId':'guard','metric':'answer_accuracy'},'payloadHash':'a'*64})
        with self.assertRaisesRegex(v.AuditError,'baseline terminal'):v.verify(self.args)

    def test_double_paid_logical_key_rejected(self):
        self.finish()
        with sqlite3.connect(self.ledger) as db:
            logical,value=db.execute("SELECT logical_key,value FROM attempts WHERE id='new-1'").fetchone(); a=json.loads(value); a['id']='duplicate'
            db.execute('INSERT INTO attempts VALUES(?,?,?)',('duplicate',logical,encoded(a)))
        with self.assertRaisesRegex(v.AuditError,'paid more than once'):v.verify(self.args)

    def test_original_sources_and_historical_requests_cannot_change(self):
        for relative in ['source-snapshot/ragas/runtime.py','bridge/requests/historical.json','bridge/budget.json']:
            with self.subTest(relative=relative):
                path=self.after/relative; old=path.read_bytes(); path.write_bytes(old+b' ')
                with self.assertRaises(v.AuditError):v.verify(self.args)
                path.write_bytes(old)

    def test_limits_lineage_ack_and_budget_must_reconcile(self):
        self.finish()
        path=self.after/'bridge/continuation-budget.json'; budget=json.loads(path.read_text()); budget['evaluation']['knownUsd']='0'
        write(path,budget)
        with self.assertRaisesRegex(v.AuditError,'budget snapshot'):v.verify(self.args)
        budget['evaluation']['knownUsd']='0.02'; write(path,budget)
        path=self.after/'bridge/continuation.json'; sidecar=json.loads(path.read_text()); sidecar['acknowledgmentFileHash']='0'*64; write(path,sidecar)
        with self.assertRaisesRegex(v.AuditError,'lineage'):v.verify(self.args)

    def test_prefix_ack_and_specific_unknown_identity_required(self):
        for change in [('runId','other'),('allowedUnknown',dict(self.ack['allowedUnknown'],attemptId='other'))]:
            value=copy.deepcopy(self.ack); value[change[0]]=change[1]; write(self.ack_path,value)
            with self.assertRaisesRegex(v.AuditError,'approved halt'):v.verify(self.args)
        write(self.ack_path,self.ack)
        changed=copy.deepcopy(self.ack); changed['baseline']['results']['prefixBytes']-=1; write(self.ack_path,changed)
        with self.assertRaisesRegex(v.AuditError,'Acknowledged terminal prefix'):v.verify(self.args)
        write(self.ack_path,self.ack)
        self.args.require_terminal=True
        with self.assertRaisesRegex(v.AuditError,'pending metrics'):v.verify(self.args)

    def test_incomplete_or_duplicate_appended_jsonl_rejected(self):
        self.finish()
        path=self.after/'study.results.jsonl'; original=path.read_bytes(); path.write_bytes(original+b'{')
        with self.assertRaisesRegex(v.AuditError,'Incomplete JSONL'):v.verify(self.args)
        path.write_bytes(original)
        append(path,{'sampleId':'new','metric':'answer_accuracy','status':'error','score':None,'calls':[]})
        with self.assertRaisesRegex(v.AuditError,'duplicated terminal'):v.verify(self.args)

    def test_new_ack_cannot_legitimize_modified_original_executable(self):
        path=self.root/'research/ledger.ts'; path.write_text('// changed original ledger\n')
        changed=copy.deepcopy(self.ack)
        for row in changed['sources']['original']:
            if row['path']=='research/ledger.ts':row['sha256']=v.file_sha(path)
        write(self.ack_path,changed)
        with self.assertRaisesRegex(v.AuditError,'Executed original source differs'):v.verify(self.args)

    def test_historical_trace_and_duplicate_new_trace_rejected(self):
        self.finish()
        path=self.after/'study.results.jsonl.calls.jsonl'; line=path.read_text().splitlines()[0]
        with path.open('a') as stream:stream.write(line+'\n')
        with self.assertRaisesRegex(v.AuditError,'duplicate request'):v.verify(self.args)


if __name__=='__main__':unittest.main()
