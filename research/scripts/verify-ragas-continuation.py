#!/usr/bin/env python3
"""Read-only lineage audit for the acknowledged RAGAS continuation; never calls providers."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

RUN_ID = 'ragas-books-test-20261004-v1'
UNKNOWN_ID = '44aaf63e-7983-4dac-99c9-14a5d4a6fe44'
UNKNOWN_PAYLOAD = '5deb0544525bd8fb589588dac4d7e502ae7a108c47c4014b4a70d06827bcd5ce'
BASE_COUNTS = {'requested': 2874, 'terminal': 1634, 'completed': 1632, 'error': 2}


class AuditError(ValueError):
    pass


def require(value, message):
    if not value:
        raise AuditError(message)


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def file_sha(path):
    require(path.is_file() and not path.is_symlink(), 'Missing or symlinked audit input')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    return json.loads(path.read_bytes())


def canonical_hashes(values, node='node'):
    # Use the original JS key-order/number semantics; do not approximate localeCompare in Python.
    script = "const fs=require('node:fs'),c=require('node:crypto');function s(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(s).join(',')+']';return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+s(v)).join(',')+'}'};process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(v=>c.createHash('sha256').update(s(v)).digest('hex'))))"
    result = subprocess.run([node, '-e', script], input=json.dumps(values, ensure_ascii=False), text=True, capture_output=True)
    require(result.returncode == 0, 'Cannot verify canonical hashes with Node')
    return json.loads(result.stdout)


def prefix_equal(before, after):
    require(before.is_file() and after.is_file(), 'Missing append-only artifact')
    require(not before.is_symlink() and not after.is_symlink(), 'Symlinked append-only artifact')
    with before.open('rb') as left, after.open('rb') as right:
        for chunk in iter(lambda: left.read(1024 * 1024), b''):
            require(right.read(len(chunk)) == chunk, 'Historical JSONL prefix changed')
    if before.stat().st_size:
        with before.open('rb') as stream:
            stream.seek(-1, 2)
            require(stream.read() == b'\n', 'Baseline JSONL ends in an incomplete line')
    return {'prefixBytes': before.stat().st_size, 'prefixSha256': file_sha(before)}


def jsonl(path, offset=0):
    with path.open('rb') as stream:
        stream.seek(offset)
        for line in stream:
            require(line.endswith(b'\n'), 'Incomplete JSONL line; use a consistent settled snapshot')
            row = json.loads(line)
            require(isinstance(row, dict), 'JSONL row must be an object')
            yield row


def terminal_rows(path, expected):
    result = {}
    for row in jsonl(path):
        key = (row.get('sampleId'), row.get('metric'))
        require(key in expected and key not in result, 'Foreign or duplicated terminal metric')
        require(row.get('status') in ('completed', 'error', 'unscorable'), 'Invalid terminal metric status')
        result[key] = row
    return result


def safe_source(root, relative):
    path = Path(relative)
    require(not path.is_absolute() and '..' not in path.parts, 'Source path must be repository relative')
    return root / path


def verify(args):
    base, phase = args.baseline_phase, args.phase
    ack = read_json(args.ack)
    require(ack.get('schemaVersion') == 1 and ack.get('kind') == 'ragas-judge-continuation', 'Unsupported continuation acknowledgment')
    require(ack.get('authorization', {}).get('literal') == 'Si continua con las evaluaciones pendientes'
            and ack['authorization'].get('authorizedBy') == 'Juan Terven'
            and isinstance(ack['authorization'].get('authorizedAt'), str), 'Missing exact continuation authorization')
    authorized_at = datetime.fromisoformat(ack['authorization']['authorizedAt'].replace('Z', '+00:00'))
    require(authorized_at.tzinfo is not None, 'Authorization time must include a timezone')
    run_id = ack['runId']; prefix = run_id + ':'
    require(run_id == RUN_ID and ack['allowedUnknown']['attemptId'] == UNKNOWN_ID
            and ack['allowedUnknown']['payloadHash'] == UNKNOWN_PAYLOAD
            and ack['allowedUnknown']['reservedUsd'] == '0.76192', 'Continuation identity differs from the approved halt')
    config = read_json(base / 'bridge/bridge-config.json')
    require(config['runId'] == run_id and config['maxEvalUsd'] == '80' and config['globalBudgetUsd'] == '200'
            and config['concurrency'] == 2 and config['retries'] == 0 and config['stopOnSettledUnknownUsage'] is True,
            'Original judge limits or policy differ')
    baseline_hash = file_sha(args.baseline_ledger)
    require(baseline_hash == ack['baseline']['ledgerBackup']['sha256'], 'Baseline ledger hash differs from acknowledgment')
    require(file_sha(args.baseline_archive) == ack['baseline']['phaseArchive']['sha256'], 'Baseline phase archive hash differs')
    require(file_sha(base / 'bridge/bridge-config.json') == ack['baseline']['configFileSha256'], 'Acknowledged config bytes differ')
    require(file_sha(base / 'samples.jsonl') == ack['baseline']['input']['sha256'], 'Acknowledged input bytes differ')

    frozen = ['samples.jsonl', 'all-inputs.jsonl', 'export-manifest.json', 'study.results.jsonl.manifest.json',
              'launch-snapshot.json', 'launch-started.json', 'preflight.json', 'study-amendment.json',
              'pip-freeze.txt', 'bridge/bridge-config.json', 'bridge/budget.json']
    before_sources = {str(p.relative_to(base)) for p in (base / 'source-snapshot').rglob('*') if p.is_file()}
    after_sources = {str(p.relative_to(phase)) for p in (phase / 'source-snapshot').rglob('*') if p.is_file()}
    require(before_sources and before_sources == after_sources, 'Frozen source inventory changed')
    preserved_files = {}
    for name in frozen + sorted(before_sources):
        digest = file_sha(base / name)
        require(digest == file_sha(phase / name), 'Frozen input, source or config changed')
        preserved_files[name] = digest
    launch = read_json(base / 'launch-snapshot.json')
    for row in launch.get('files', {}).values():
        require(file_sha(base / 'source-snapshot' / row['snapshot']) == row['sha256'], 'Original launch source hash mismatch')
    runtime = read_json(base / 'study.results.jsonl.manifest.json')
    require(runtime['runId'] == run_id and runtime['inputSha256'] == preserved_files['samples.jsonl']
            and runtime['runtimeSha256'] == preserved_files['source-snapshot/ragas/runtime.py'], 'Original runtime manifest mismatch')
    require(config['inputHash'] == preserved_files['all-inputs.jsonl']
            and config['bridgeSourceHash'] == preserved_files['source-snapshot/ragas/bridge.ts']
            and config['ledgerSourceHash'] == preserved_files['source-snapshot/ledger.ts'], 'Original bridge source/input mismatch')

    expected = set()
    sample_ids = set()
    for row in jsonl(base / 'samples.jsonl'):
        require(row['id'] not in sample_ids, 'Duplicated input sample')
        sample_ids.add(row['id'])
        require(len(row['metrics']) == len(set(row['metrics'])) and set(row['metrics']) <= {'faithfulness', 'answer_accuracy'}, 'Invalid planned metrics')
        expected.update((row['id'], metric) for metric in row['metrics'])
    before_results = terminal_rows(base / 'study.results.jsonl', expected)
    baseline_status = Counter(row['status'] for row in before_results.values())
    require(len(expected) == BASE_COUNTS['requested'] and len(before_results) == BASE_COUNTS['terminal']
            and baseline_status == Counter({k: BASE_COUNTS[k] for k in ('completed', 'error')}), 'Baseline cohort differs from the approved halt')
    result_prefix = prefix_equal(base / 'study.results.jsonl', phase / 'study.results.jsonl')
    require(all(result_prefix[k] == ack['baseline']['results'][k] for k in result_prefix)
            and len(before_results) == ack['baseline']['results']['terminalRows'], 'Acknowledged terminal prefix differs')
    trace_prefix = prefix_equal(base / 'study.results.jsonl.calls.jsonl', phase / 'study.results.jsonl.calls.jsonl')
    after_results = terminal_rows(phase / 'study.results.jsonl', expected)
    eligible = expected - before_results.keys()
    require(set(after_results) - before_results.keys() <= eligible, 'A terminal metric was retried')

    old_requests = {p.name for p in (base / 'bridge/requests').iterdir() if p.is_file()}
    for name in old_requests:
        require(file_sha(base / 'bridge/requests' / name) == file_sha(phase / 'bridge/requests' / name), 'Historical request/response artifact changed')
    new_requests = {}
    for path in (phase / 'bridge/requests').iterdir():
        if path.name in old_requests or path.name.endswith('.response.json'):
            continue
        require(path.name.endswith('.json'), 'Unexpected new bridge request artifact')
        record = read_json(path); req = record['request']; key = (req['sampleId'], req['metric'])
        require(key in eligible, 'New request targets a baseline terminal or unplanned metric')
        request_id = req['requestId']; request_key = sha_bytes(request_id.encode())
        require(path.name == request_key + '.json' and request_id not in new_requests, 'Duplicated or mismatched new request ID')
        new_requests[request_id] = {'key': key, 'hash': request_key, 'payloadHash': record['payloadHash']}
    trace_requests = Counter()
    for row in jsonl(phase / 'study.results.jsonl.calls.jsonl', trace_prefix['prefixBytes']):
        key = (row.get('sampleId'), row.get('metric'))
        require(key in eligible, 'Appended call trace targets an old terminal metric')
        if row['event'] == 'request':
            request_id = row['payload']['requestId']
            require(request_id in new_requests, 'New trace request lacks its persisted input')
            trace_requests[request_id] += 1
    require(set(trace_requests) == set(new_requests) and all(n == 1 for n in trace_requests.values()), 'New request/trace mismatch or duplicate request')
    for key, row in after_results.items():
        if key in before_results:
            continue
        for ordinal, call in enumerate(row.get('calls', []), 1):
            request_id = 'ragas:' + sha_bytes(json.dumps([run_id, key[0], key[1], ordinal], separators=(',', ':'), ensure_ascii=False).encode())
            require(call.get('requestId') == request_id and request_id in new_requests, 'New terminal call has wrong deterministic identity')
        if row['status'] == 'completed' and key[1] == 'answer_accuracy':
            require(len(row.get('calls', [])) == 2 and all(c.get('status') == 'completed' for c in row['calls']), 'Completed Answer Accuracy lacks both judge calls')

    source_hashes = {}
    for group in ('original', 'continuation'):
        rows = ack['sources'][group]
        require(rows and len({row['path'] for row in rows}) == len(rows), 'Missing or duplicate acknowledged sources')
        for row in rows:
            require(file_sha(safe_source(args.source_root, row['path'])) == row['sha256'], 'Acknowledged executable source hash differs')
            source_hashes[row['path']] = row['sha256']
    originals = {row['path'] for row in ack['sources']['original']}
    for name in ('research/ragas/bridge.ts', 'research/ragas/runtime.py', 'research/ledger.ts',
                 'research/util.ts', 'server/engines/common.ts', 'server/costs.ts'):
        snapshot = name.removeprefix('research/') if name.startswith('research/') else 'repository/' + name
        require(name in originals and source_hashes[name] == preserved_files['source-snapshot/' + snapshot],
                'Executed original source differs from its frozen baseline')
    require({'research/ragas/continuation-bridge.ts', 'research/ragas/continuation-policy.ts'} <=
            {row['path'] for row in ack['sources']['continuation']}, 'Missing required continuation implementation')

    with closing(sqlite3.connect(args.ledger.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('ATTACH DATABASE ? AS baseline', (args.baseline_ledger.resolve().as_uri() + '?mode=ro',))
        schema = 'SELECT type,name,tbl_name,sql FROM {}.sqlite_master WHERE name NOT LIKE \'sqlite_%\' ORDER BY type,name'
        require(db.execute(schema.format('main')).fetchall() == db.execute(schema.format('baseline')).fetchall(), 'Ledger schema changed')
        preserved_rows = {}
        specs = {'attempts': ('id', ['logical_key', 'value']), 'immutable': ('key', ['hash', 'value']),
                 'responses': ('key', ['value']), 'runs': ('id', ['status', 'value'])}
        for table, (key, columns) in specs.items():
            mismatch = ' OR '.join(['a.rowid IS NOT b.rowid'] + [f'a.{col} IS NOT b.{col}' for col in columns])
            require(db.execute(f'SELECT 1 FROM baseline.{table} b LEFT JOIN main.{table} a ON a.{key}=b.{key} WHERE a.{key} IS NULL OR {mismatch} LIMIT 1').fetchone() is None,
                    'Historical ledger row changed or disappeared: ' + table)
            preserved_rows[table] = db.execute(f'SELECT COUNT(*) FROM baseline.{table}').fetchone()[0]
        require(db.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == preserved_rows['runs'], 'Continuation added unrelated study runs')
        def frozen(key):
            row = db.execute('SELECT value FROM immutable WHERE key=?', (key,)).fetchone()
            return json.loads(row[0]) if row else None
        require(frozen('budget-limit') == {'maxBudgetUsd': '200'}
                and frozen('budget-scope:' + prefix) == {'runPrefix': prefix, 'maxBudgetUsd': '80'}, 'Budget caps changed')
        unknown = ack['allowedUnknown']
        raw = db.execute('SELECT value FROM baseline.attempts WHERE id=?', (unknown['attemptId'],)).fetchone()
        require(raw is not None and sha_bytes(raw[0].encode()) == unknown['valueSha256'], 'Acknowledged unknown raw record differs')
        attempt = json.loads(raw[0])
        require(attempt['status'] == 'unknown' and attempt['costUsd'] is None and attempt['reservedUsd'] == unknown['reservedUsd']
                and attempt['payloadHash'] == unknown['payloadHash'] and attempt['runId'].startswith(prefix), 'Unknown attempt was reinterpreted')
        config_hash, ack_hash, attempt_hash = canonical_hashes([config, ack, attempt], args.node)
        require(config_hash == ack['baseline']['configHash'] and attempt_hash == unknown['canonicalHash'], 'Acknowledged canonical hashes differ')
        require(frozen('ragas:' + run_id + ':config') == config, 'Original frozen config mismatch')
        old_unknown_ids = {r[0] for r in db.execute("SELECT id FROM baseline.attempts WHERE json_extract(value,'$.runId') LIKE ? AND json_extract(value,'$.status')='unknown'", (prefix + '%',))}
        require(old_unknown_ids == {unknown['attemptId']}, 'Acknowledgment does not cover the exact baseline unknown set')
        require(db.execute("SELECT 1 FROM baseline.attempts WHERE json_extract(value,'$.status')='pending' LIMIT 1").fetchone() is None, 'Baseline contains in-flight calls')
        new_attempts = {}
        for aid, logical, value in db.execute('SELECT a.id,a.logical_key,a.value FROM attempts a LEFT JOIN baseline.attempts b ON a.id=b.id WHERE b.id IS NULL'):
            a = json.loads(value)
            require(a['id'] == aid and a['logicalKey'] == logical and a['runId'].startswith(prefix), 'Unrelated or mismatched new paid attempt')
            key = logical.removeprefix(prefix + 'judge:')
            request_ids = [rid for rid, rec in new_requests.items() if rec['hash'] == key]
            require(len(request_ids) == 1, 'New paid attempt lacks an eligible new request')
            req = new_requests[request_ids[0]]
            require(a['documentId'] == req['key'][0] and a['operation'] == 'ragas_' + req['key'][1]
                    and a['runId'] == prefix + key and a['payloadHash'] == req['payloadHash']
                    and a['price'] == config['price'] and a['model'] == config['model'] and a['method'] == 'ragas-judge', 'New attempt changes the frozen request/model/tariff')
            new_attempts[aid] = a
        require(db.execute('SELECT 1 FROM attempts WHERE substr(logical_key,1,?)=? GROUP BY logical_key HAVING COUNT(*)>1 LIMIT 1', (len(prefix), prefix)).fetchone() is None, 'A logical request was paid more than once')
        for key, row in after_results.items():
            if key in before_results:
                continue
            for call in row.get('calls', []):
                aid = call.get('attemptId')
                require(aid is None or aid in new_attempts, 'New metric reuses a prior paid attempt')
        new_immutable = {r[0] for r in db.execute('SELECT a.key FROM immutable a LEFT JOIN baseline.immutable b ON a.key=b.key WHERE b.key IS NULL')}
        allowed_keys = {prefix + 'judge:' + req['hash'] + suffix for req in new_requests.values() for suffix in (':input', ':result')}
        lineage_key = 'ragas:' + run_id + ':continuation'
        require(new_immutable <= allowed_keys | {lineage_key}, 'Unexpected new immutable ledger record')
        new_response_keys = {r[0] for r in db.execute('SELECT a.key FROM responses a LEFT JOIN baseline.responses b ON a.key=b.key WHERE b.key IS NULL')}
        require(new_response_keys <= {prefix + 'judge:' + req['hash'] for req in new_requests.values()}, 'New response lacks eligible request')
        if args.preflight:
            require(not new_attempts and len(after_results) == len(before_results) and not new_requests, 'Preflight already contains new evaluation activity')
        else:
            lineage = read_json(phase / 'bridge/continuation.json')
            require(lineage.get('schemaVersion') == 1 and lineage.get('kind') == 'ragas-judge-continuation-lineage'
                    and lineage.get('acknowledgment') == ack and lineage.get('acknowledgmentHash') == ack_hash
                    and lineage.get('acknowledgmentFileHash') == file_sha(args.ack)
                    and lineage.get('originalConfigHash') == config_hash and frozen(lineage_key) == lineage, 'Continuation lineage sidecar/freeze differs')
            continuation_sources = {Path(k).name: v for k, v in source_hashes.items() if k in {r['path'] for r in ack['sources']['continuation']}}
            require(lineage['continuationSourceHash'] == continuation_sources.get('continuation-bridge.ts')
                    and lineage['policySourceHash'] == continuation_sources.get('continuation-policy.ts'), 'Continuation implementation not bound to acknowledgment')
        totals = {}
        for label, scope in [('global', ''), ('judge', prefix)]:
            known = Decimal(0); reserve = Decimal(0); statuses = Counter()
            for cost, reserved, status in db.execute("SELECT json_extract(value,'$.costUsd'),json_extract(value,'$.reservedUsd'),json_extract(value,'$.status') FROM attempts WHERE substr(json_extract(value,'$.runId'),1,?)=?", (len(scope), scope)):
                statuses[status] += 1
                if cost is None: reserve += Decimal(reserved)
                else: known += Decimal(cost)
            require(known + reserve <= Decimal('200' if label == 'global' else '80'), 'Committed usage exceeds unchanged cap')
            totals[label] = {'knownUsd': str(known), 'unresolvedReservedUsd': str(reserve), 'statuses': dict(statuses)}
        pending_api = totals['global']['statuses'].get('pending', 0)
        if not args.preflight:
            budget = read_json(phase / 'bridge/continuation-budget.json')
            require(budget.get('runId') == run_id and budget.get('maxEvalUsd') == '80', 'Continuation budget identity differs')
            for label, budget_label in [('global', 'global'), ('judge', 'evaluation')]:
                actual, reported = totals[label], budget[budget_label]
                known, reserved = Decimal(actual['knownUsd']), Decimal(actual['unresolvedReservedUsd'])
                require(Decimal(reported['knownUsd']) == known and Decimal(reported['reservedUsd']) == reserved
                        and Decimal(reported['committedUsd']) == known + reserved
                        and reported['unknownAttempts'] == actual['statuses'].get('unknown', 0) + actual['statuses'].get('pending', 0),
                        'Continuation budget snapshot does not reconcile with the ledger')
    all_terminal = set(after_results) == expected
    if args.require_terminal:
        require(all_terminal and pending_api == 0, 'Evaluation still has pending metrics or calls')
    return {'schemaVersion': 1, 'kind': 'verified-ragas-continuation-lineage', 'recordedAt': datetime.now(timezone.utc).isoformat(),
            'ok': True, 'preflight': args.preflight, 'runId': run_id, 'acknowledgmentSha256': file_sha(args.ack),
            'auditorSourceSha256': file_sha(Path(__file__)),
            'baselineLedgerSha256': baseline_hash, 'ledgerSha256': file_sha(args.ledger), 'baselineRowsPreserved': preserved_rows,
            'resultsSha256': file_sha(phase / 'study.results.jsonl'), 'callsSha256': file_sha(phase / 'study.results.jsonl.calls.jsonl'),
            'lineageSha256': None if args.preflight else file_sha(phase / 'bridge/continuation.json'),
            'continuationBudgetSha256': None if args.preflight else file_sha(phase / 'bridge/continuation-budget.json'),
            'historicalBudgetSha256': preserved_files['bridge/budget.json'],
            'frozenFilesPreserved': len(preserved_files), 'oldRequestResponseFilesPreserved': len(old_requests),
            'resultPrefix': result_prefix, 'callTracePrefix': trace_prefix, 'originalTerminalMetrics': len(before_results),
            'expectedMetrics': len(expected), 'newTerminalMetrics': len(after_results) - len(before_results),
            'terminalMetrics': len(after_results), 'missingMetrics': len(expected) - len(after_results), 'allMetricsTerminal': all_terminal,
            'terminalStatusCounts': dict(Counter(row['status'] for row in after_results.values())), 'newRequests': len(new_requests),
            'newPaidAttempts': len(new_attempts), 'newUnknownAttempts': sum(a['status'] == 'unknown' for a in new_attempts.values()),
            'acknowledgedUnknownPreserved': {'attemptId': unknown['attemptId'], 'rawValueSha256': unknown['valueSha256'], 'reservedUsd': unknown['reservedUsd'], 'status': 'unknown', 'costUsd': None},
            'budgets': totals, 'sourceHashes': source_hashes,
            'limitations': ['Lineage audit complements the original cost/provenance audit; it does not relabel unknown usage as settled.', 'Partial continuation is not a completed evaluation. No automatic-score quality conclusion is made.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('baseline-ledger', 'baseline-phase', 'baseline-archive', 'ledger', 'phase', 'ack', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--source-root', type=Path, default=Path.cwd())
    parser.add_argument('--node', default='node')
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--require-terminal', action='store_true')
    args = parser.parse_args()
    try:
        require(not args.out.exists(), 'Output already exists')
        result = verify(args)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open('x') as stream:
            json.dump(result, stream, indent=2); stream.write('\n')
        print(json.dumps({'ok': True, 'output': str(args.out), 'missingMetrics': result['missingMetrics'], 'newPaidAttempts': result['newPaidAttempts']}))
        return 0
    except Exception as exc:
        # Never print untrusted parser data, source text, provider response bodies, or raw SQL values.
        print(json.dumps({'ok': False, 'error': str(exc) if isinstance(exc, AuditError) else type(exc).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
