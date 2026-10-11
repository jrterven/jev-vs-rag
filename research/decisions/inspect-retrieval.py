"""Post hoc, read-only diagnostics of frozen Decisions rankings; no API calls."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sqlite3
import statistics

def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def macro(rows):
    documents = defaultdict(list)
    for row in rows:
        documents[row['documentId']].append(row['metrics']['coverage'])
    return statistics.mean(map(statistics.mean, documents.values())) if documents else None

def inspect(analysis_path, baseline_path, ledger_path):
    assert digest(analysis_path) == 'bfcf48f5b8afad21b1c2b33a0633a9f507ae69871c8ca3dd27a8b44b115c8d57', 'Frozen analysis changed'
    assert digest(baseline_path) == 'f102690b610c8fc7c14f924ede944d470a4ddcaa3fb3a0d6a0e63bfaecff3e59', 'Original report changed'
    assert digest(ledger_path) == 'ae32ef0c13df405fa8f22722566556726458292f9e5fa2823b5cc2f3b7023fb4', 'Use the final retrieval backup'
    analysis = json.loads(Path(analysis_path).read_text())
    baseline = json.loads(Path(baseline_path).read_text())
    base = [r for r in analysis['perQuery'] if r['round'] == 0]
    assert len(base) == 952 and len({r['id'] for r in base}) == 952
    summaries = defaultdict(Counter)
    query_diagnostics = []
    with sqlite3.connect(f'file:{Path(ledger_path).resolve()}?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        for compact in base:
            saved = db.execute('SELECT value FROM runs WHERE id=?', (compact['id'],)).fetchone()
            assert saved, 'Missing saved base run'
            run = json.loads(saved[0])
            assert run['status'] == compact['status']
            final = next((t for t in run['traces'] if t['stage'] == 'final'), None)
            final_diagnostic = None
            for trace in run['traces']:
                if trace['stage'] not in ['window', 'reduction']:
                    continue
                key = f"{run['id']}:decisions:{trace['level']}:{trace['payloadHash']}"
                archived = db.execute('SELECT value FROM responses WHERE key=?', (key,)).fetchone()
                assert archived, 'Missing raw Decisions response'
                response = json.loads(archived[0])
                assert response['status'] == 200 and response['payloadHash'] == trace['payloadHash']
                choice = response['data']['answers'][0]
                probabilities = {p['value']: p['probability'] for p in choice['probabilities']}
                assert len(probabilities) == len(trace['candidateIds']) + 1
                assert all(probabilities[r['chunkId']] == r['score'] for r in trace['scores'])
                scores = sorted((probabilities[c] for c in trace['candidateIds']), reverse=True)
                assert scores and '__none__' in probabilities
                stage = 'initial-window' if trace['level'] == 0 else 'reduction-window'
                is_final = final is not None and trace['level'] == final['level'] and set(trace['candidateIds']) == set(final['candidateIds'])
                diagnostic = {
                    'options': len(scores), 'zeroScoredPassages': sum(s == 0 for s in scores),
                    'fallbackSelected': choice['choice'] == '__none__',
                    'allPassageScoresZero': all(s == 0 for s in scores),
                    'tieAtTenCutoff': len(scores) > 10 and scores[9] == scores[10],
                    'tieAtFiveCutoff': len(scores) > 5 and scores[4] == scores[5],
                    'zeroInTopFive': any(s == 0 for s in scores[:5]),
                }
                for group in [stage] + (['final-comparison'] if is_final else []):
                    counter = summaries[(run['corpus'], run['method'], group)]
                    counter['calls'] += 1
                    for key, value in diagnostic.items():
                        counter[key] += int(value)
                if is_final:
                    assert final_diagnostic is None, 'Duplicate final comparison'
                    final_diagnostic = diagnostic
            assert (final_diagnostic is not None) == (run['status'] == 'completed')
            query_diagnostics.append({'id': run['id'], 'corpus': run['corpus'], 'method': run['method'],
                                      'status': run['status'], 'final': final_diagnostic})
    # These additional comparisons change the population; keep them separate.
    paired_completed = []
    for corpus in ['qasper-test', 'openstax-books']:
        for new, old in [('hybrid-decisions', 'hybrid-jev'), ('decisions-scan', 'jev-scan')]:
            old_rows = {r['questionId']: r for r in baseline['perQuery']
                        if r['round'] == 0 and r['corpus'] == corpus and r['method'] == old}
            current = [r for r in base if r['corpus'] == corpus and r['method'] == new and r['metrics'] is not None]
            common = [r for r in current if r['status'] == 'completed' and old_rows[r['questionId']]['status'] == 'completed']
            earlier = [old_rows[r['questionId']] for r in common]
            paired_completed.append({'corpus': corpus, 'method': new, 'baseline': old,
                                     'questions': len(common), 'documents': len({r['documentId'] for r in common}),
                                     'newCoverage': macro(common), 'oldCoverage': macro(earlier),
                                     'difference': macro(common) - macro(earlier)})
    per_book = []
    for method in ['hybrid-decisions', 'decisions-scan']:
        rows = [r for r in base if r['corpus'] == 'openstax-books' and r['method'] == method]
        for document in sorted({r['documentId'] for r in rows}):
            selected = [r for r in rows if r['documentId'] == document]
            assert len(selected) == 10
            per_book.append({'method': method, 'documentId': document, 'questions': len(selected),
                             'failures': sum(r['status'] != 'completed' for r in selected), 'coverage': macro(selected)})
    return {'kind': 'posthoc-frozen-retrieval-diagnostics', 'schemaVersion': 1,
            'inputHashes': {str(p): digest(p) for p in [analysis_path, baseline_path, ledger_path]},
            'sourceSha256': digest(__file__), 'scope': 'Assigned base runs only; paid responses before failure remain in window totals.',
            'interpretation': 'Exact zero probabilities and equal-score cutoff ties are descriptive; document-order tie breaking is frozen. Fallback is excluded without probability renormalization. These diagnostics do not establish that ties cause evidence loss. Completed-pair sensitivity changes question composition and does not replace assigned-query results.',
            'windows': [{'corpus': c, 'method': m, 'stage': s, **dict(counts)} for (c, m, s), counts in sorted(summaries.items())],
            'completedPairSensitivity': paired_completed, 'perBook': per_book, 'queries': query_diagnostics}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['analysis', 'baseline', 'ledger', 'out']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit('Output exists; preserve it.')
    result = inspect(args.analysis, args.baseline, args.ledger)
    with args.out.open('x') as destination:
        json.dump(result, destination, indent=2)
    print(json.dumps({'out': str(args.out), 'baseQueries': len(result['queries']), 'windowGroups': len(result['windows'])}))
