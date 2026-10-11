"""Offline cohort-lineage tests; no provider calls."""
import copy,json,sqlite3,tarfile,shutil,unittest
from pathlib import Path
from unittest.mock import patch
import importlib.util

def module(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));v=importlib.util.module_from_spec(s);s.loader.exec_module(v);return v
old=module('oldfixtures','test_verify_ragas_second_continuation.py')
v=module('cohortaudit','verify-ragas-cohort-continuation.py')
write,append,encoded=old.write,old.append,old.encoded
class CohortTests(unittest.TestCase):
 def setUp(self):
  old.SecondContinuationAuditTests.setUp(self)
  self.second_ack=copy.deepcopy(self.ack)
  prior_path=self.base/'continuation2-20261006/acknowledgment.json';write(prior_path,self.second_ack)
  prev=self.second_ack['priorContinuation']
  second_lineage={'schemaVersion':1,'kind':'ragas-judge-continuation2-lineage','acknowledgment':self.second_ack,'acknowledgmentHash':v.canonical_hashes([self.second_ack])[0],'acknowledgmentFileHash':v.file_sha(prior_path),'originalConfigHash':self.ack['baseline']['configHash'],'continuationSourceHash':v.file_sha(self.root/'research/ragas/continuation2-bridge.ts'),'policySourceHash':v.file_sha(self.root/'research/ragas/continuation2-policy.ts'),'priorAcknowledgmentHash':v.canonical_hashes([self.prior_ack])[0],'priorLineageHash':prev['lineageHash']}
  write(self.base/'bridge/continuation2.json',second_lineage);write(self.base/'bridge/continuation2-budget.json',{'preserved':True})
  third=dict(self.second_unknown,id=v.THIRD_UNKNOWN_ID,logicalKey=self.prefix+'judge:third-old',runId=self.prefix+'third-old',documentId='second_guard',payloadHash=v.THIRD_UNKNOWN_PAYLOAD)
  with sqlite3.connect(self.baseline_ledger) as db:
   self.freeze(db,'ragas:'+self.run+':continuation2',second_lineage)
   db.execute('INSERT INTO attempts VALUES(?,?,?)',(third['id'],third['logicalKey'],encoded(third)))
  refs=[]
  for name in ['research/ragas/cohort-bridge.ts','research/ragas/cohort-policy.ts','output/study-runbook-20261005/resume-ragas-test-cohort.py']:
   p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('# fixture\n');refs.append({'path':name,'sha256':v.file_sha(p)})
  self.ack=copy.deepcopy(self.second_ack);self.ack['kind']='ragas-judge-cohort';self.ack['authorization']['literal']='autorizo terminar los 329 missing sample/metric pairs'
  self.ack['allowedUnknowns'].append({'attemptId':third['id'],'valueSha256':v.sha_bytes(encoded(third).encode()),'canonicalHash':v.canonical_hashes([third])[0],'payloadHash':third['payloadHash'],'reservedUsd':'0.76192'})
  self.ack['priorContinuation']={k:{'path':path,'sha256':v.file_sha(self.base/path)} for k,path in [('acknowledgment','continuation2-20261006/acknowledgment.json'),('lineage','bridge/continuation2.json'),('budget','bridge/continuation2-budget.json')]}
  self.ack['priorContinuation']['lineageHash']=v.canonical_hashes([second_lineage])[0]
  self.ack['sources']['priorContinuation']=self.second_ack['sources']['priorContinuation']+self.second_ack['sources']['continuation'];self.ack['sources']['continuation']=refs
  with tarfile.open(self.archive,'w:gz') as tf:
   for p in sorted(self.base.rglob('*')):
    if p.is_file():tf.add(p,arcname=str(p.relative_to(self.base)))
  self.ack['baseline']['ledgerBackup']['sha256']=v.file_sha(self.baseline_ledger);self.ack['baseline']['phaseArchive']['sha256']=v.file_sha(self.archive);write(self.ack_path,self.ack)
  shutil.rmtree(self.after);shutil.copytree(self.base,self.after);shutil.copyfile(self.baseline_ledger,self.ledger)
  for name,value in [('BASE_COUNTS',{'requested':6,'terminal':5,'completed':1,'error':4}),('BASE_LEDGER_SHA',v.file_sha(self.baseline_ledger)),('BASE_ARCHIVE_SHA',v.file_sha(self.archive)),('PRIOR_ACK_SHA',v.file_sha(prior_path))]:
   p=patch.object(v,name,value);p.start();self.addCleanup(p.stop)
 def freeze(self,db,key,value):old.SecondContinuationAuditTests.freeze(self,db,key,value)
 def finish(self):
     (self.after/'cohort-20261006').mkdir(exist_ok=True)
     calls = []
     with sqlite3.connect(self.ledger) as db:
         for ordinal in (1, 2):
             rid = 'ragas:'+v.sha_bytes(encoded([self.run, 'new', 'answer_accuracy', ordinal]).encode()); key = v.sha_bytes(rid.encode()); logical = self.prefix+'judge:'+key
             request = {'requestId': rid, 'sampleId': 'new', 'metric': 'answer_accuracy'}
             record = {'request': request, 'payloadHash': 'a'*64}
             write(self.after/'bridge/requests'/f'{key}.json', record)
             append(self.after/'study.results.jsonl.calls.jsonl', {'event': 'request', 'sampleId': 'new', 'metric': 'answer_accuracy', 'payload': request})
             a = {'id': 'new-'+str(ordinal), 'logicalKey': logical, 'runId': self.prefix+key, 'documentId': 'new', 'operation': 'ragas_answer_accuracy', 'method': 'ragas-judge', 'model': self.config['model'], 'price': self.config['price'], 'payloadHash': 'a'*64, 'reservedUsd': '0.76192', 'costUsd': '0.01', 'status': 'completed'}
             db.execute('INSERT INTO attempts VALUES(?,?,?)', (a['id'], logical, encoded(a)))
             self.freeze(db, logical+':input', record); self.freeze(db, logical+':result', {'ok': True, 'attemptId': a['id']})
             db.execute('INSERT INTO responses VALUES(?,?)', (logical, '{"status":200}'))
             write(self.after/'bridge/requests'/f'{key}.response.json',{'ok':True,'attempt':a})
             append(self.after/'cohort-20261006/provider-events.jsonl',{'attemptId':a['id'],'ok':True,'httpStatus':200,'hardStop':False,'at':'2026-10-06T17:00:00Z'})
             calls.append({'requestId': rid, 'attemptId': a['id'], 'status': 'completed'})
         prior = self.ack['priorContinuation']
         lineage = {'schemaVersion': 1, 'kind': 'ragas-judge-cohort-lineage', 'acknowledgment': self.ack,
             'acknowledgmentHash': v.canonical_hashes([self.ack])[0], 'acknowledgmentFileHash': v.file_sha(self.ack_path),
             'originalConfigHash': self.ack['baseline']['configHash'],
             'continuationSourceHash': v.file_sha(self.root/'research/ragas/cohort-bridge.ts'),
             'policySourceHash': v.file_sha(self.root/'research/ragas/cohort-policy.ts'),
             'priorAcknowledgmentHash': v.canonical_hashes([self.second_ack])[0], 'priorAcknowledgmentFileHash': prior['acknowledgment']['sha256'],
             'priorLineageHash': prior['lineageHash'], 'priorLineageFileHash': prior['lineage']['sha256'], 'priorBudgetFileHash': prior['budget']['sha256']}
         write(self.after/'bridge/cohort.json', lineage); self.freeze(db, 'ragas:'+self.run+':cohort', lineage)
     append(self.after/'study.results.jsonl', {'sampleId': 'new', 'metric': 'answer_accuracy', 'status': 'completed', 'score': 0.5, 'calls': calls})
     totals = {'knownUsd': '0.02', 'reservedUsd': '2.28576', 'committedUsd': '2.30576', 'unknownAttempts': 3}
     write(self.after/'bridge/cohort-budget.json', {'runId': self.run, 'maxEvalUsd': '80', 'global': totals, 'evaluation': totals})
     self.args.preflight = False; self.args.require_terminal = True
 def test_preflight(self):
  r=v.verify(self.args);self.assertTrue(r['ok']);self.assertEqual(r['missingMetrics'],1);self.assertEqual(len(r['acknowledgedUnknownsPreserved']),3)
 def test_historical_mutation_rejected(self):
  with sqlite3.connect(self.ledger) as db:db.execute('DELETE FROM attempts WHERE id=?',(v.THIRD_UNKNOWN_ID,))
  with self.assertRaises(v.AuditError):v.verify(self.args)
 def test_source_mutation_rejected(self):
  (self.root/'research/ragas/cohort-bridge.ts').write_text('changed')
  with self.assertRaises(v.AuditError):v.verify(self.args)
 def test_earlier_lineage_change_rejected(self):
  (self.after/'bridge/continuation.json').write_text('{}')
  with self.assertRaises(v.AuditError):v.verify(self.args)
 def test_unaccounted_activity_rejected(self):
  append(self.after/'study.results.jsonl',{'sampleId':'new','metric':'answer_accuracy','status':'error','calls':[]})
  with self.assertRaises(v.AuditError):v.verify(self.args)
 def test_final_success_preserves_three_unknowns(self):
  self.finish();r=v.verify(self.args);self.assertTrue(r['allMetricsTerminal']);self.assertEqual(r['newPaidAttempts'],2);self.assertEqual(r['newUnknownAttempts'],0)
 def test_missing_provider_event_rejected(self):
  self.finish();(self.after/'cohort-20261006/provider-events.jsonl').write_text('')
  with self.assertRaises(v.AuditError):v.verify(self.args)
 def test_new_unknown_terminal_failure_is_accounted(self):
  self.finish()
  with sqlite3.connect(self.ledger) as db:
   a=json.loads(db.execute('SELECT value FROM attempts WHERE id=?',('new-2',)).fetchone()[0]);a['status']='unknown';a['costUsd']=None
   db.execute('UPDATE attempts SET value=? WHERE id=?',(encoded(a),a['id']))
  key=a['logicalKey'].removeprefix(self.prefix+'judge:');write(self.after/'bridge/requests'/f'{key}.response.json',{'ok':False,'attempt':a})
  events=list(v.jsonl(self.after/'cohort-20261006/provider-events.jsonl'));events[1].update(ok=False,httpStatus=503)
  (self.after/'cohort-20261006/provider-events.jsonl').write_text(''.join(encoded(x)+'\n' for x in events))
  rows=list(v.jsonl(self.after/'study.results.jsonl'));rows[-1].update(status='error',score=None);rows[-1]['calls'][1]['status']='error'
  (self.after/'study.results.jsonl').write_text(''.join(encoded(x)+'\n' for x in rows))
  totals={'knownUsd':'0.01','reservedUsd':'3.04768','committedUsd':'3.05768','unknownAttempts':4}
  write(self.after/'bridge/cohort-budget.json',{'runId':self.run,'maxEvalUsd':'80','global':totals,'evaluation':totals})
  r=v.verify(self.args);self.assertTrue(r['allMetricsTerminal']);self.assertEqual(r['newUnknownAttempts'],1)
if __name__=='__main__':unittest.main()
