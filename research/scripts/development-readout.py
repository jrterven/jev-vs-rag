"""Read measured development outputs without changing frozen runs or calling APIs.

Usage: python development-readout.py --experiment DIR --ledger BACKUP --out DIR
Optional --plot uses matplotlib. Monetary values remain decimal strings.
"""
import argparse
from collections import Counter, defaultdict
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3
import statistics


def quantile(values, p):
    values = sorted(values)
    if not values:
        return None
    pos = (len(values) - 1) * p
    lo = int(pos)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (pos - lo)


def macro(rows):
    groups = defaultdict(list)
    for document_id, value in rows:
        groups[document_id].append(value)
    return statistics.mean(statistics.mean(v) for v in groups.values()) if groups else None


def summarize(directory, ledger_path):
    raw = (directory / 'report.json').read_bytes()
    report = json.loads(raw)
    manifest = json.loads((directory / 'manifest.json').read_text())
    bundles = json.loads((directory / 'datasets.json').read_text())
    if report['kind'] != 'measured' or manifest['phase'] != 'pilot':
        raise ValueError('This readout accepts measured development runs only.')
    if any(s['split'] != 'development' for b in bundles for s in b['sources']):
        raise ValueError('Test data are excluded from this development readout.')
    questions = {q['id']: q for b in bundles for q in b['freeze']['questions']}
    preparation = {x['documentId']: x for x in report['preparation']}
    with sqlite3.connect(ledger_path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        attempts = [json.loads(x[0]) for x in db.execute('SELECT value FROM attempts')]
    attempts = [a for a in attempts if a['runId'].startswith(manifest['id'] + ':')]
    assert len({a['id'] for a in attempts}) == len(attempts), 'Duplicate API attempt IDs'
    for a in attempts:
        if a['costUsd'] is not None:
            cached = a.get('cachedTokens', 0)
            price = a['price']
            reconstructed = (Decimal(a['inputTokens'] - cached) * Decimal(price['input'])
                             + Decimal(cached) * Decimal(price.get('cachedInput', price['input']))
                             + Decimal(a['outputTokens']) * Decimal(price['output'])) / Decimal(1_000_000)
            assert reconstructed == Decimal(a['costUsd']), 'Usage/rate snapshot does not match API cost'
    total = sum((Decimal(a['costUsd']) for a in attempts if a['costUsd'] is not None), Decimal(0))
    assert total == Decimal(report['experimentObservedUsd']), 'Ledger/report expense differs'
    attempt_by_run = defaultdict(list)
    operations = defaultdict(list)
    for a in attempts:
        attempt_by_run[a['runId']].append(a)
        operations[a['operation']].append(a)
    methods = []
    rows = []
    for method in report['methods']:
        own = [x for x in report['perQuery'] if x['method'] == method['id'] and x['corpus'] == method['corpus']]
        base = [x for x in own if x['round'] == 0]
        measured = [x for x in own if x.get('timingSample') and x.get('timingValid') and x['status'] == 'completed']
        coverage = macro([(x['documentId'], x['metrics']['coverage']) for x in base if x.get('metrics') is not None])
        assert coverage is None or abs(coverage - method['coverage']) < 1e-12
        if measured:
            assert abs(quantile([x['elapsedMs'] for x in measured], .5) - method['latencyP50Ms']) < 1e-8
        gen = [x for x in base if x.get('generation')]
        negatives = [x for x in gen if questions[x['questionId']].get('unanswerable')]
        positives = [x for x in gen if not questions[x['questionId']].get('unanswerable')]
        unknown = method['unknownCostAttempts'] > 0
        doc_ids = {x['documentId'] for x in base}
        charged = [a for a in attempts if a['documentId'] in doc_ids and (a['method'] == method['id'] or (manifest['config'].get('structure') and a['operation'] == 'structure'))]
        prep_cost = sum((Decimal(a['costUsd'] or 0) for a in charged if a['operation'] in ('document_embedding', 'structure')), Decimal(0)) / len(doc_ids)
        query_costs = defaultdict(list)
        for x in base:
            query_costs[x['documentId']].append(sum((Decimal(a['costUsd'] or 0) for a in charged if a['runId'] == x['id'] and a['operation'] not in ('document_embedding', 'structure', 'generation')), Decimal(0)))
        query_cost = sum((sum(v, Decimal(0)) / len(v) for v in query_costs.values()), Decimal(0)) / len(query_costs)
        assert abs(prep_cost - Decimal(method['preparationUsd'])) < Decimal('1e-21')
        assert abs(query_cost - Decimal(method['queryMeanUsd'])) < Decimal('1e-21')
        summary = {k: method.get(k) for k in ['id', 'label', 'corpus', 'coverage', 'coverageLow', 'coverageHigh', 'completeGold', 'nQueries', 'nAnswerable', 'nTimingRuns', 'latencyP50Ms', 'latencyP95Ms', 'preparationUsd', 'queryMeanUsd', 'unknownCostAttempts', 'failures', 'timingFailures']}
        summary['projections'] = [{'queries': n, 'apiTotalUsd': None if unknown else str(Decimal(method['preparationUsd']) + n * Decimal(method['queryMeanUsd']))} for n in [1, 5, 10, 50, 100, 1000]]
        summary['byRound'] = [{'round': i, 'n': len(times := [x['elapsedMs'] for x in measured if x['round'] == i]), 'p50Ms': quantile(times, .5), 'p95Ms': quantile(times, .95)} for i in sorted({x['round'] for x in measured})]
        summary['generation'] = {'n': len(gen), 'p50Ms': quantile([x['generation']['elapsedMs'] for x in gen], .5), 'negativeN': len(negatives), 'negativeAbstentions': sum(x['generation']['abstained'] for x in negatives), 'positiveN': len(positives), 'positiveAbstentions': sum(x['generation']['abstained'] for x in positives), 'correctness': 'not evaluated; abstained is the generator declaration'}
        planned = [x for x in manifest['schedule'] if x['method'] == method['id'] and x['corpus'] == method['corpus'] and x['generate']]
        summary['generation'].update({'planned': len(planned), 'missingOrFailed': len(planned) - len(gen)})
        methods.append(summary)
        for x in measured:
            first_windows = [t for t in x['traces'] if t['stage'] == 'window' and t.get('level', 0) == 0]
            reductions = [t for t in x['traces'] if t['stage'] == 'reduction']
            own_attempts = [a for a in attempt_by_run[x['id']] if a['operation'] != 'generation']
            rows.append({'runId': x['id'], 'method': x['method'], 'questionId': x['questionId'], 'documentId': x['documentId'], 'round': x['round'], 'tokens': preparation[x['documentId']]['tokens'], 'chunks': preparation[x['documentId']]['chunks'], 'elapsedMs': x['elapsedMs'], 'phasesMs': x['phases'], 'initialWindows': len(first_windows), 'reductionCalls': len(reductions), 'apiCalls': len(own_attempts), 'unknownAttempts': sum(a['costUsd'] is None for a in own_attempts), 'knownApiUsd': str(sum((Decimal(a['costUsd']) for a in own_attempts if a['costUsd'] is not None), Decimal(0)))})
    controls = []
    for method in ('oracle', 'closed-book'):
        planned = [x for x in manifest['schedule'] if x['method'] == method and x['generate']]
        gen = [x for x in report['perQuery'] if x['method'] == method and x.get('generation')]
        negatives = [x for x in gen if questions[x['questionId']].get('unanswerable')]
        positives = [x for x in gen if not questions[x['questionId']].get('unanswerable')]
        controls.append({'method': method, 'planned': len(planned), 'generated': len(gen), 'missingOrFailed': len(planned) - len(gen), 'negativeN': len(negatives), 'negativeAbstentions': sum(x['generation']['abstained'] for x in negatives), 'positiveN': len(positives), 'positiveAbstentions': sum(x['generation']['abstained'] for x in positives)})
    return {'experimentId': manifest['id'], 'reportSha256': hashlib.sha256(raw).hexdigest(), 'datasetHash': report['datasetHash'], 'implementationHash': report['implementationHash'], 'kind': report['kind'], 'provenance': [b.get('provenance', {}) for b in bundles], 'scope': {'questions': len(questions), 'answerable': sum(not q.get('unanswerable') for q in questions.values()), 'documents': len(preparation), 'minChunks': min(x['chunks'] for x in preparation.values()), 'maxChunks': max(x['chunks'] for x in preparation.values()), 'minTokens': min(x['tokens'] for x in preparation.values()), 'maxTokens': max(x['tokens'] for x in preparation.values())}, 'apiObservedUsd': str(total), 'unknownApiAttempts': sum(a['costUsd'] is None for a in attempts), 'operationCosts': {k: {'attempts': len(v), 'unknown': sum(a['costUsd'] is None for a in v), 'knownUsd': str(sum((Decimal(a['costUsd']) for a in v if a['costUsd'] is not None), Decimal(0)))} for k, v in operations.items()}, 'methods': methods, 'controls': controls, 'runs': rows, 'limitations': ['Development only; synthetic stress data are not book quality measurements.', 'Quality and average API costs use round 0, macro averaged by document; timing uses all valid repetitions.', 'API projections describe similar queries and document lengths, exclude generation and unpriced CPU/GPU/RAM/storage/electricity.', 'Preparation API costs are means per document. Local preparation combines shared BM25/BGE/model work and cannot be charged independently to every method.', 'No latency confidence intervals; network and warm-up can affect measurements.', 'Declared abstention does not prove factual correctness or citation support.']}


def plot(summary, out):
    if summary['scope']['answerable'] != summary['scope']['questions'] or any(m['corpus'] != 'qasper-development' for m in summary['methods']):
        raise ValueError('The optional figure template is for the positive QASPER pilot only; use JSON for diagnostic/synthetic cohorts.')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.ticker import PercentFormatter
    methods = summary['methods']
    colors = ['#0072B2' if m['id'] == 'openai-dense' else '#D55E00' if 'jev' in m['id'] else '#626B73' for m in methods]
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'svg.fonttype': 'none'})
    fig, axes = plt.subplots(1, 2, figsize=(11.4, 5.6), gridspec_kw={'width_ratios': [1.35, 1]})
    y = list(range(len(methods)))
    for i, (m, color) in enumerate(zip(methods, colors)):
        if m['coverage'] is not None:
            axes[0].errorbar(m['coverage'], i, xerr=[[m['coverage'] - m['coverageLow']], [m['coverageHigh'] - m['coverage']]], fmt='o', color=color, capsize=3)
        axes[1].plot([m['latencyP50Ms'], m['latencyP95Ms']], [i, i], color=color, linewidth=2)
        axes[1].scatter(m['latencyP50Ms'], i, color=color, marker='o', zorder=3)
        axes[1].scatter(m['latencyP95Ms'], i, edgecolor=color, facecolor='white', marker='s', zorder=3)
    axes[0].set_yticks(y, [m['label'] for m in methods])
    axes[0].set_xlim(0, 1.025)
    axes[0].xaxis.set_major_formatter(PercentFormatter(1))
    axes[0].set_title('Evidence coverage@5 · 95% bootstrap intervals')
    axes[0].set_xlabel('Document-macro coverage')
    axes[1].set_yticks(y, [''] * len(y))
    axes[1].set_xlim(left=0)
    axes[1].set_title('Retrieval latency · median and p95')
    axes[1].set_xlabel('Milliseconds · filled circle: median; square: p95')
    for ax in axes:
        ax.invert_yaxis()
        ax.set_ylim(len(y) - .5, -.5)
        ax.grid(axis='x', color='#E3E7EB', linewidth=.7)
        ax.set_axisbelow(True)
        ax.spines[['top', 'right']].set_visible(False)
    scope = summary['scope']
    fig.suptitle(f"QASPER development · {scope['questions']} questions / {scope['documents']} articles", x=.02, ha='left', fontsize=14, weight='bold')
    fig.text(.02, .015, 'Exploratory. Coverage is not answer accuracy. Latency spread is not a confidence interval.\nThree timing rounds per method; API network waits included. These data do not represent books.', fontsize=9, color='#46515B')
    fig.tight_layout(rect=(0, .1, 1, .93))
    fig.savefig(out / 'quality-latency.svg')
    fig.savefig(out / 'quality-latency.png', dpi=160)
    plt.close(fig)
    compared = [m for m in methods if m['id'] in ('openai-dense', 'jev-scan') and not m['unknownCostAttempts']]
    if len(compared) == 2:
        fig, ax = plt.subplots(figsize=(8.5, 5.4))
        for m in compared:
            color = '#0072B2' if m['id'] == 'openai-dense' else '#D55E00'
            xx = [x['queries'] for x in m['projections']]
            yy = [float(x['apiTotalUsd']) for x in m['projections']]
            ax.plot(xx, yy, color=color, marker='o', label=m['label'])
        ax.set_xscale('log')
        ax.set_yscale('log')
        ax.set_xticks([1, 5, 10, 50, 100, 1000], ['1', '5', '10', '50', '100', '1,000'])
        ax.set_xlabel('Similar queries on the same article · logarithmic scale')
        ax.set_ylabel('Projected API cost (USD) · logarithmic scale')
        ax.set_title('Reuse cost · preparation + N × mean retrieval cost', loc='left', weight='bold')
        ax.grid(color='#E3E7EB', linewidth=.7)
        ax.spines[['top', 'right']].set_visible(False)
        ax.legend(frameon=False)
        fig.text(.03, .025, 'Projection from the QASPER development pilot, not new observed spending.\nExcludes generation and unpriced local resources. Mean preparation per article; macro-document query mean.', fontsize=9)
        fig.tight_layout(rect=(0, .105, 1, 1))
        fig.savefig(out / 'projected-api-cost.svg')
        fig.savefig(out / 'projected-api-cost.png', dpi=160)
        plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--experiment', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--plot', action='store_true')
    args = parser.parse_args()
    result = summarize(args.experiment, args.ledger)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'efficiency.json').write_text(json.dumps(result, indent=2) + '\n')
    if args.plot:
        plot(result, args.out)
    print(json.dumps({'experiment': result['experimentId'], 'out': str(args.out), 'apiObservedUsd': result['apiObservedUsd'], 'unknownApiAttempts': result['unknownApiAttempts']}))


if __name__ == '__main__':
    main()
