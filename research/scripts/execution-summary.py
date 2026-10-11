#!/usr/bin/env python3
"""Summarize measured preparation/generation time without provider calls.

Preparation is a shared local-index phase and a separate OpenAI phase, not
seven independently prepared indexes. Failed/missing generations stay counted.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import statistics


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def durations(values):
    require(all(not isinstance(x, bool) and isinstance(x, (int, float))
                and math.isfinite(x) and x >= 0 for x in values), 'Invalid measured duration')
    if not values:
        return {'n': 0, 'meanMs': None, 'medianMs': None, 'p95Ms': None, 'sumMs': None}
    ordered = sorted(values)
    position = .95 * (len(ordered) - 1)
    low = math.floor(position)
    p95 = ordered[low] + (ordered[min(low + 1, len(ordered) - 1)] - ordered[low]) * (position - low)
    return {'n': len(values), 'meanMs': statistics.mean(values), 'medianMs': statistics.median(values),
            'p95Ms': p95, 'sumMs': sum(values)}


def summarize(experiment: Path, ledger: Path, readout_path: Path):
    report_path, manifest_path = experiment / 'report.json', experiment / 'manifest.json'
    readout = json.loads(readout_path.read_text())
    require(readout['kind'] == 'measured-study-readout', 'Measured audited readout required')
    hashes = {name: sha(path) for name, path in [('report', report_path), ('manifest', manifest_path), ('ledgerSnapshot', ledger)]}
    require(all(readout['hashes'][name] == value for name, value in hashes.items()), 'Audited input hash mismatch')
    report, manifest = json.loads(report_path.read_text()), json.loads(manifest_path.read_text())
    require(report['kind'] == manifest['kind'] == 'measured', 'Mock data refused')
    require(report['experimentId'] == manifest['id'] == readout['experimentId'], 'Experiment identity mismatch')
    require(report['datasetHash'] == manifest['datasetHash'] == readout['protocol']['datasetHash'], 'Dataset identity mismatch')
    require(report['missingScheduledRuns'] == 0, 'Incomplete schedule')
    wal = Path(str(ledger) + '-wal')
    require(not wal.exists() or wal.stat().st_size == 0, 'Use a closed consistent backup, not an active WAL ledger')
    document_corpus = {row['id']: row['corpus'] for row in readout['documents']}
    preparation = report['preparation']
    require(len({row['documentId'] for row in preparation}) == len(preparation)
            and {row['documentId'] for row in preparation} == set(document_corpus), 'Preparation document coverage mismatch')
    with sqlite3.connect(ledger.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as db:
        require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Corrupt ledger backup')
        for row in preparation:
            saved = db.execute('SELECT value FROM immutable WHERE key=?',
                               (f"{manifest['id']}:preparation:{row['documentId']}",)).fetchone()
            expected = {key: value for key, value in row.items() if key != 'documentId'}
            require(saved is not None and json.loads(saved[0]) == expected, 'Preparation differs from its immutable checkpoint')
    preparation_groups = defaultdict(list)
    for row in preparation:
        preparation_groups[document_corpus[row['documentId']]].append(row)
    prep_summary = []
    for corpus, rows in sorted(preparation_groups.items()):
        require(all(set(row['phases']) == {'localPreparationMs', 'openaiPreparationMs'} for row in rows),
                'Unexpected preparation policy; update this supplemental analysis explicitly')
        prep_summary.append({'corpus': corpus, 'documents': len(rows), 'chunks': sum(row['chunks'] for row in rows),
                             'sourceTokens': sum(row['tokens'] for row in rows),
                             'sharedLocalIndexes': durations([row['phases']['localPreparationMs'] for row in rows]),
                             'openaiDocumentEmbeddings': durations([row['phases']['openaiPreparationMs'] for row in rows])})
    by_id = {row['id']: row for row in report['perQuery']}
    require(len(by_id) == len(report['perQuery']), 'Duplicate measured run')
    generation_groups = defaultdict(list)
    for scheduled in manifest['schedule']:
        if scheduled['generate']:
            generation_groups[(scheduled['corpus'], scheduled['method'])].append(scheduled)
    generation_summary = []
    for (corpus, method), assigned in sorted(generation_groups.items()):
        rows = [by_id[row['id']] for row in assigned]
        completed = [row for row in rows if row.get('generation')]
        generation_summary.append({'corpus': corpus, 'method': method, 'assigned': len(rows), 'completed': len(completed),
                                   'retrievalFailed': sum(row['status'] != 'completed' for row in rows),
                                   'oracleIneligible': sum('control ineligible' in row.get('generationError', '') for row in rows),
                                   'failedOrUnavailable': len(rows) - len(completed),
                                   'generationWallTime': durations([row['generation']['elapsedMs'] for row in completed])})
    return {'schemaVersion': 1, 'kind': 'measured-execution-summary', 'experimentId': manifest['id'], 'phase': manifest['phase'],
            'hashes': {**hashes, 'readout': sha(readout_path), 'analysis': sha(Path(__file__))},
            'preparation': prep_summary, 'generation': generation_summary,
            'interpretation': {
                'preparation': 'Per-document measured phases include first local model loading. Local indexes are shared among baselines; their cost/time is not multiplied by the number of methods. Canonicalization, acquisition, startup outside prepare, query time and generation are excluded.',
                'generation': 'Wall time recorded by the frozen generator implementation, only for completed generations. Counts retain all assigned controls/arms and failed/unavailable cases. It is not retrieval latency or a latency estimate for failed answers.',
                'statistics': 'Arithmetic mean, linear-interpolated p95 and median over recorded durations; no bootstrap uncertainty implied.'}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--experiment', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--readout', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = summarize(args.experiment, args.ledger, args.readout)
    contents = (json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode()
    if args.out.exists():
        require(args.out.read_bytes() == contents, 'Refusing to replace a different scientific summary')
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open('xb') as handle:
            handle.write(contents)
    print(json.dumps({'output': str(args.out), 'experimentId': result['experimentId'],
                      'preparationCorpora': len(result['preparation']), 'generationGroups': len(result['generation'])}))
