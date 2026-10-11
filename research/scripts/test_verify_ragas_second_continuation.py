"""Offline second-exception lineage tests. All writes stay in temporary fixtures."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tarfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


v = module('verify_ragas_second_continuation', 'verify-ragas-second-continuation.py')
first = module('first_continuation_test_helpers', 'test_verify_ragas_continuation.py')
encoded, write, append = first.encoded, first.write, first.append


class SecondContinuationAuditTests(unittest.TestCase):
    def setUp(self):
        first.ContinuationAuditTests.setUp(self)
        self.config['maxOutputTokens'] = 8192
        for sample, metric in [('second_unknown', 'faithfulness'), ('second_guard', 'answer_accuracy')]:
            for name in ('samples.jsonl', 'all-inputs.jsonl'):
                append(self.base/name, {'id': sample, 'metrics': [metric]})
            append(self.base/'study.results.jsonl', {'sampleId': sample, 'metric': metric, 'status': 'error', 'score': None, 'calls': []})
        self.config['inputHash'] = v.file_sha(self.base/'all-inputs.jsonl')
        write(self.base/'bridge/bridge-config.json', self.config)
        write(self.base/'study.results.jsonl.manifest.json', {'runId': self.run, 'inputSha256': v.file_sha(self.base/'samples.jsonl'), 'runtimeSha256': v.file_sha(self.root/'research/ragas/runtime.py')})
        old_launcher = self.root/'output/study-runbook-20261005/resume-ragas-test.py'
        old_launcher.parent.mkdir(parents=True, exist_ok=True); old_launcher.write_text('# first launcher\n')
        self.ack['sources']['continuation'].append({'path': str(old_launcher.relative_to(self.root)), 'sha256': v.file_sha(old_launcher)})
        self.ack['baseline']['configHash'] = v.canonical_hashes([self.config])[0]
        self.ack['baseline']['configFileSha256'] = v.file_sha(self.base/'bridge/bridge-config.json')
        self.ack['baseline']['input']['sha256'] = v.file_sha(self.base/'samples.jsonl')
        self.prior_ack = copy.deepcopy(self.ack)
        prior_ack_path = self.base/'continuation-20261005/acknowledgment.json'
        write(prior_ack_path, self.prior_ack)
        self.prior_lineage = {'schemaVersion': 1, 'kind': 'ragas-judge-continuation-lineage',
            'acknowledgment': self.prior_ack, 'acknowledgmentHash': v.canonical_hashes([self.prior_ack])[0],
            'acknowledgmentFileHash': v.file_sha(prior_ack_path), 'originalConfigHash': self.ack['baseline']['configHash'],
            'continuationSourceHash': v.file_sha(self.root/'research/ragas/continuation-bridge.ts'),
            'policySourceHash': v.file_sha(self.root/'research/ragas/continuation-policy.ts')}
        write(self.base/'bridge/continuation.json', self.prior_lineage)
        write(self.base/'bridge/continuation-budget.json', {'preserved': 'first settled snapshot'})
        write(self.base/'continuation-20261005/runtime-exit.json', {'exitCode': 2})
        new_refs = []
        for name in ('research/ragas/continuation2-bridge.ts', 'research/ragas/continuation2-policy.ts', 'output/study-runbook-20261005/resume-ragas-test-second.py'):
            path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('# second fixture '+name+'\n')
            new_refs.append({'path': name, 'sha256': v.file_sha(path)})
        self.second_unknown = dict(self.unknown, id=v.SECOND_UNKNOWN_ID, logicalKey=self.prefix+'judge:second-old', runId=self.prefix+'second-old', documentId='second_unknown', operation='ragas_faithfulness', payloadHash='4d0ccea82bdce6dea96dd6d907408129738751a768328f6c3aaa1ca499f554c0')
        with sqlite3.connect(self.baseline_ledger) as db:
            db.execute('UPDATE immutable SET hash=?,value=? WHERE key=?', (v.canonical_hashes([self.config])[0], encoded(self.config), 'ragas:'+self.run+':config'))
            db.execute('INSERT INTO attempts VALUES(?,?,?)', (self.second_unknown['id'], self.second_unknown['logicalKey'], encoded(self.second_unknown)))
            self.freeze(db, 'ragas:'+self.run+':continuation', self.prior_lineage)
        with tarfile.open(self.archive, 'w:gz') as archive:
            for path in sorted(self.base.rglob('*')):
                if path.is_file(): archive.add(path, arcname=str(path.relative_to(self.base)))
        self.ack = {'schemaVersion': 1, 'kind': 'ragas-judge-continuation2', 'runId': self.run,
            'authorization': {'literal': 'ok termina los exprimentos y el paper', 'authorizedBy': 'Juan Terven', 'authorizedAt': '2026-10-06T12:48:10.567150Z'},
            'baseline': {'configHash': v.canonical_hashes([self.config])[0], 'configFileSha256': v.file_sha(self.base/'bridge/bridge-config.json'),
                'ledgerBackup': {'path': 'second-baseline.sqlite', 'sha256': v.file_sha(self.baseline_ledger)},
                'phaseArchive': {'path': 'second-baseline.tar.gz', 'sha256': v.file_sha(self.archive)},
                'input': {'path': 'baseline/samples.jsonl', 'sha256': v.file_sha(self.base/'samples.jsonl')},
                'results': {'path': 'baseline/study.results.jsonl', 'prefixBytes': (self.base/'study.results.jsonl').stat().st_size, 'prefixSha256': v.file_sha(self.base/'study.results.jsonl'), 'terminalRows': 5}},
            'allowedUnknowns': [self.prior_ack['allowedUnknown'], {'attemptId': v.SECOND_UNKNOWN_ID,
                'valueSha256': v.sha_bytes(encoded(self.second_unknown).encode()), 'canonicalHash': v.canonical_hashes([self.second_unknown])[0],
                'payloadHash': self.second_unknown['payloadHash'], 'reservedUsd': '0.76192'}],
            'priorContinuation': {'acknowledgment': {'path': 'continuation-20261005/acknowledgment.json', 'sha256': v.file_sha(prior_ack_path)},
                'lineage': {'path': 'bridge/continuation.json', 'sha256': v.file_sha(self.base/'bridge/continuation.json')},
                'lineageHash': v.canonical_hashes([self.prior_lineage])[0],
                'budget': {'path': 'bridge/continuation-budget.json', 'sha256': v.file_sha(self.base/'bridge/continuation-budget.json')}},
            'sources': {'original': self.prior_ack['sources']['original'], 'priorContinuation': self.prior_ack['sources']['continuation'], 'continuation': new_refs}}
        write(self.ack_path, self.ack)
        shutil.rmtree(self.after); shutil.copytree(self.base, self.after); shutil.copyfile(self.baseline_ledger, self.ledger)
        for name, value in [('BASE_COUNTS', {'requested': 6, 'terminal': 5, 'completed': 1, 'error': 4}),
                            ('BASE_LEDGER_SHA', v.file_sha(self.baseline_ledger)), ('BASE_ARCHIVE_SHA', v.file_sha(self.archive)),
                            ('PRIOR_ACK_SHA', v.file_sha(prior_ack_path))]:
            p = patch.object(v, name, value); p.start(); self.addCleanup(p.stop)

    def freeze(self, db, key, value):
        db.execute('INSERT INTO immutable VALUES(?,?,?)', (key, v.canonical_hashes([value])[0], encoded(value)))

    def finish(self):
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
                calls.append({'requestId': rid, 'attemptId': a['id'], 'status': 'completed'})
            prior = self.ack['priorContinuation']
            lineage = {'schemaVersion': 1, 'kind': 'ragas-judge-continuation2-lineage', 'acknowledgment': self.ack,
                'acknowledgmentHash': v.canonical_hashes([self.ack])[0], 'acknowledgmentFileHash': v.file_sha(self.ack_path),
                'originalConfigHash': self.ack['baseline']['configHash'],
                'continuationSourceHash': v.file_sha(self.root/'research/ragas/continuation2-bridge.ts'),
                'policySourceHash': v.file_sha(self.root/'research/ragas/continuation2-policy.ts'),
                'priorAcknowledgmentHash': v.canonical_hashes([self.prior_ack])[0], 'priorAcknowledgmentFileHash': prior['acknowledgment']['sha256'],
                'priorLineageHash': prior['lineageHash'], 'priorLineageFileHash': prior['lineage']['sha256'], 'priorBudgetFileHash': prior['budget']['sha256']}
            write(self.after/'bridge/continuation2.json', lineage); self.freeze(db, 'ragas:'+self.run+':continuation2', lineage)
        append(self.after/'study.results.jsonl', {'sampleId': 'new', 'metric': 'answer_accuracy', 'status': 'completed', 'score': 0.5, 'calls': calls})
        totals = {'knownUsd': '0.02', 'reservedUsd': '1.52384', 'committedUsd': '1.54384', 'unknownAttempts': 2}
        write(self.after/'bridge/continuation2-budget.json', {'runId': self.run, 'maxEvalUsd': '80', 'global': totals, 'evaluation': totals})
        self.args.preflight = False; self.args.require_terminal = True

    def test_preflight_preserves_both_unknowns_and_no_new_activity(self):
        before = v.file_sha(self.ledger); result = v.verify(self.args)
        self.assertTrue(result['ok']); self.assertEqual(result['missingMetrics'], 1)
        self.assertEqual(result['newPaidAttempts'], 0); self.assertEqual(result['newUnknownAttempts'], 0)
        self.assertEqual(len(result['acknowledgedUnknownsPreserved']), 2)
        self.assertEqual(result['budgets']['judge']['unresolvedReservedUsd'], '1.52384')
        self.assertEqual(v.file_sha(self.ledger), before)
        self.assertNotIn('PRESERVE_DONT_PRINT', json.dumps(result))

    def test_final_keeps_four_errors_and_both_unknowns(self):
        self.finish(); result = v.verify(self.args)
        self.assertTrue(result['allMetricsTerminal']); self.assertEqual(result['terminalStatusCounts'], {'completed': 2, 'error': 4})
        self.assertEqual(result['newPaidAttempts'], 2)
        self.assertTrue(all(x['status'] == 'unknown' and x['costUsd'] is None and x['reservedUsd'] == '0.76192' for x in result['acknowledgedUnknownsPreserved']))

    def test_final_receipt_contract(self):
        self.finish(); result = v.verify(self.args)
        self.assertEqual(result['schemaVersion'], 2); self.assertEqual(result['kind'], 'verified-ragas-second-continuation-lineage')
        for name, path in [('historicalBudgetSha256', 'bridge/budget.json'), ('continuationBudgetSha256', 'bridge/continuation2-budget.json'),
                           ('priorAcknowledgmentSha256', 'continuation-20261005/acknowledgment.json'), ('priorLineageSha256', 'bridge/continuation.json'),
                           ('priorContinuationBudgetSha256', 'bridge/continuation-budget.json')]:
            self.assertEqual(result[name], v.file_sha(self.after/path))
        self.assertEqual(result['auditorSourceSha256'], v.file_sha(Path(v.__file__)))
        self.assertEqual(result['priorLineageCanonicalHash'], self.ack['priorContinuation']['lineageHash'])
        self.assertGreater(result['baselineArchiveFilesVerified'], 10)

    def test_all_four_historical_tables_unchanged(self):
        for table, key, column in [('attempts', 'id', 'value'), ('immutable', 'key', 'value'), ('responses', 'key', 'value'), ('runs', 'id', 'status')]:
            with self.subTest(table=table):
                shutil.copyfile(self.baseline_ledger, self.ledger)
                with sqlite3.connect(self.ledger) as db:
                    row = db.execute(f'SELECT {key} FROM {table} LIMIT 1').fetchone()[0]
                    db.execute(f'UPDATE {table} SET {column}=? WHERE {key}=?', ('changed', row))
                with self.assertRaisesRegex(v.AuditError, 'Historical ledger row'): v.verify(self.args)

    def test_either_unknown_change_rejected(self):
        for aid in (v.UNKNOWN_ID, v.SECOND_UNKNOWN_ID):
            with self.subTest(aid=aid):
                shutil.copyfile(self.baseline_ledger, self.ledger)
                with sqlite3.connect(self.ledger) as db:
                    row = json.loads(db.execute('SELECT value FROM attempts WHERE id=?', (aid,)).fetchone()[0])
                    row['costUsd'] = '0'; row['reservedUsd'] = '0'
                    db.execute('UPDATE attempts SET value=? WHERE id=?', (encoded(row), aid))
                with self.assertRaisesRegex(v.AuditError, 'Historical ledger row'): v.verify(self.args)

    def test_new_unknown_rejected_even_within_budget(self):
        self.finish()
        with sqlite3.connect(self.ledger) as db:
            row = json.loads(db.execute("SELECT value FROM attempts WHERE id='new-1'").fetchone()[0]); row.update(status='unknown', costUsd=None)
            db.execute("UPDATE attempts SET value=? WHERE id='new-1'", (encoded(row),))
        with self.assertRaisesRegex(v.AuditError, 'New unknown usage'): v.verify(self.args)

    def test_terminal_error_and_duplicate_calls_never_retry(self):
        rid = 'ragas:'+v.sha_bytes(encoded([self.run, 'second_guard', 'answer_accuracy', 1]).encode()); key = v.sha_bytes(rid.encode())
        write(self.after/'bridge/requests'/f'{key}.json', {'request': {'requestId': rid, 'sampleId': 'second_guard', 'metric': 'answer_accuracy'}, 'payloadHash': 'a'*64})
        with self.assertRaisesRegex(v.AuditError, 'baseline terminal'): v.verify(self.args)

    def test_historical_phase_and_archive_inventory_verified(self):
        for path in ['bridge/continuation.json', 'bridge/continuation-budget.json', 'continuation-20261005/runtime-exit.json', 'bridge/requests/historical.json']:
            with self.subTest(path=path):
                f = self.after/path; saved = f.read_bytes(); f.write_bytes(saved+b' ')
                with self.assertRaisesRegex(v.AuditError, 'Historical phase artifact'): v.verify(self.args)
                f.write_bytes(saved)
        (self.base/'unexpected.json').write_text('{}')
        with self.assertRaisesRegex(v.AuditError, 'inventory'): v.verify(self.args)

    def test_baseline_cannot_be_redefined_through_ack(self):
        self.ack['baseline']['ledgerBackup']['sha256'] = '0'*64; write(self.ack_path, self.ack)
        with self.assertRaisesRegex(v.AuditError, 'Baseline ledger'): v.verify(self.args)

    def test_prior_ack_chain_cannot_change(self):
        for field in ['lineageHash', 'acknowledgment']:
            changed = copy.deepcopy(self.ack)
            changed['priorContinuation'][field] = '0'*64 if field == 'lineageHash' else {'path': 'forged', 'sha256': '0'*64}
            write(self.ack_path, changed)
            with self.assertRaises(v.AuditError): v.verify(self.args)
        write(self.ack_path, self.ack)
        changed = copy.deepcopy(self.ack); changed['sources']['priorContinuation'].pop(); write(self.ack_path, changed)
        with self.assertRaisesRegex(v.AuditError, 'source chain'): v.verify(self.args)

    def test_ack_cannot_expand_unknown_scope(self):
        changed = copy.deepcopy(self.ack); changed['allowedUnknowns'].append(dict(changed['allowedUnknowns'][0], attemptId='third'))
        write(self.ack_path, changed)
        with self.assertRaisesRegex(v.AuditError, 'approved second halt'): v.verify(self.args)

    def test_second_sidecar_and_budget_bind_exact_artifacts(self):
        self.finish(); path = self.after/'bridge/continuation2.json'; saved = path.read_bytes()
        changed = json.loads(saved); changed['priorBudgetFileHash'] = '0'*64; write(path, changed)
        with self.assertRaisesRegex(v.AuditError, 'lineage'): v.verify(self.args)
        path.write_bytes(saved)
        path = self.after/'bridge/continuation2-budget.json'; budget = json.loads(path.read_text()); budget['evaluation']['reservedUsd'] = '0'; write(path, budget)
        with self.assertRaisesRegex(v.AuditError, 'budget snapshot'): v.verify(self.args)

    def test_duplicate_paid_identity_rejected(self):
        self.finish()
        with sqlite3.connect(self.ledger) as db:
            logical, value = db.execute("SELECT logical_key,value FROM attempts WHERE id='new-1'").fetchone(); row = json.loads(value); row['id'] = 'duplicate'
            db.execute('INSERT INTO attempts VALUES(?,?,?)', ('duplicate', logical, encoded(row)))
        with self.assertRaisesRegex(v.AuditError, 'paid more than once'): v.verify(self.args)

    def test_unplanned_third_subcall_rejected(self):
        rid = 'ragas:'+v.sha_bytes(encoded([self.run, 'new', 'answer_accuracy', 3]).encode()); key = v.sha_bytes(rid.encode())
        write(self.after/'bridge/requests'/f'{key}.json', {'request': {'requestId': rid, 'sampleId': 'new', 'metric': 'answer_accuracy'}, 'payloadHash': 'a'*64})
        with self.assertRaisesRegex(v.AuditError, 'unsupported ordinal'): v.verify(self.args)

    def test_terminal_and_jsonl_completion_required(self):
        self.args.require_terminal = True
        with self.assertRaisesRegex(v.AuditError, 'pending metrics'): v.verify(self.args)
        self.finish(); path = self.after/'study.results.jsonl'; path.write_bytes(path.read_bytes()+b'{')
        with self.assertRaisesRegex(v.AuditError, 'Incomplete JSONL'): v.verify(self.args)

    def test_historical_prefix_is_append_only(self):
        path = self.after/'study.results.jsonl'; path.write_text(path.read_text().replace('"second_guard"', '"forged"'))
        with self.assertRaisesRegex(v.AuditError, 'prefix changed'): v.verify(self.args)


if __name__ == '__main__': unittest.main()
