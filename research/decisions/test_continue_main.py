import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('continuation', Path(__file__).with_name('continue_main.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def fixture(path):
    db = sqlite3.connect(path)
    db.executescript('CREATE TABLE attempts(id TEXT PRIMARY KEY,logical_key TEXT,value TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,value TEXT); CREATE TABLE immutable(key TEXT PRIMARY KEY,hash TEXT,value TEXT); CREATE TABLE responses(key TEXT PRIMARY KEY,value TEXT);')
    db.execute('INSERT INTO attempts VALUES(?,?,?)', ('a', 'logical-a', json.dumps({'runId': 'old', 'status': 'unknown', 'costUsd': None, 'reservedUsd': '0.0272'})))
    db.execute('INSERT INTO runs VALUES(?,?,?)', ('old', 'failed', '{"status":"failed"}'))
    db.execute('INSERT INTO immutable VALUES(?,?,?)', ('fixed', 'hash', '{}'))
    db.execute('INSERT INTO responses VALUES(?,?)', ('response', '{}'))
    db.commit()
    return db

class ContinuationTests(unittest.TestCase):
    def test_old_rows_unchanged_all_columns_and_additions_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / 'old.sqlite'
            before = fixture(old)
            live = sqlite3.connect(':memory:')
            before.backup(live)
            live.execute('INSERT INTO responses VALUES(?,?)', ('new', '{}'))
            live.commit()
            self.assertEqual(module.unchanged(live, old), dict(attempts=1, runs=1, immutable=1, responses=1))
            for table, key, column in [('attempts','id','logical_key'),('runs','id','status'),('immutable','key','hash'),('responses','key','value')]:
                current = live.execute(f'SELECT {key},{column} FROM {table} LIMIT 1').fetchone()
                live.execute(f'UPDATE {table} SET {column}=? WHERE {key}=?', ('changed',current[0]))
                live.commit()
                with self.assertRaisesRegex(RuntimeError,'Historical rows changed'):
                    module.unchanged(live,old)
                live.execute(f'UPDATE {table} SET {column}=? WHERE {key}=?',(current[1],current[0]))
                live.commit()
            live.close(); before.close()

    def test_deleted_historical_row_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / 'old.sqlite'
            before = fixture(old); live = sqlite3.connect(':memory:'); before.backup(live)
            live.execute('DELETE FROM responses'); live.commit()
            with self.assertRaisesRegex(RuntimeError,'Historical rows changed'):
                module.unchanged(live,old)
            live.close(); before.close()

    def test_unknown_cost_retained_pending_and_running_block(self):
        db = fixture(':memory:')
        with patch.object(module,'read',return_value={'schedule':[]}):
            self.assertEqual(module.state(db)['global']['reservedUsd'],'0.0272')
            a = json.loads(db.execute('SELECT value FROM attempts').fetchone()[0])
            a['status'] = 'pending'
            db.execute('UPDATE attempts SET value=?',(json.dumps(a),))
            with self.assertRaisesRegex(RuntimeError,'Pending API calls'): module.state(db)
            a['status'] = 'unknown'; db.execute('UPDATE attempts SET value=?',(json.dumps(a),))
            db.execute("UPDATE runs SET status='running'")
            with self.assertRaisesRegex(RuntimeError,'Running ledger case'): module.state(db)
        db.close()

    def test_no_old_retrieval_or_failed_generation_is_retried(self):
        old = {'success': {'status':'completed'}, 'failure': {'status':'failed'}}
        valid = [{'runId':'new','operation':'decisions'}, {'runId':'success','operation':'generation'}]
        module.validate_new_attempts(valid, ['new'], {'success','failure'}, old)
        for row in [{'runId':'success','operation':'decisions'}, {'runId':'failure','operation':'decisions'}, {'runId':'failure','operation':'generation'}, {'runId':'other','operation':'generation'}]:
            with self.assertRaises(RuntimeError): module.validate_new_attempts([row],['new'],{'success','failure'},old)

    def test_shared_gpu_authorized_but_unavailable_still_stops(self):
        with patch.object(module.subprocess,'check_output',return_value='{"available":false,"computeProcesses":[]}'):
            with self.assertRaisesRegex(RuntimeError,'GPU availability'): module.gpu_available()
        for processes in [[],[{'pid':123}]]:
            with patch.object(module.subprocess,'check_output',return_value=json.dumps({'available':True,'computeProcesses':processes})):
                self.assertEqual(module.gpu_available()['computeProcesses'],processes)

if __name__ == '__main__': unittest.main()
