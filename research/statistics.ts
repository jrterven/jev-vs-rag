import { Decimal } from 'decimal.js';
import { clusterBootstrap } from './metrics.js';
import { mean } from './util.js';
import { METHOD_IDS, type MethodId } from './types.js';

export interface ScoredQuery {
  questionId: string; documentId: string; corpus: string; method: string; round: number;
  metrics: { coverage: number } | null;
}

/** Pair questions before resampling documents, so both arms share each bootstrap draw. */
export function studyStatistics(rows: ScoredQuery[], options: { iterations?: number; seed?: number } = {}) {
  const iterations = options.iterations ?? 10000, seed = options.seed ?? 42;
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('Bootstrap iterations must be positive.');
  const base = rows.filter(r => r.round === 0 && r.metrics !== null && METHOD_IDS.includes(r.method as MethodId));
  const keys = new Set<string>();
  for (const row of base) {
    const key = JSON.stringify([row.corpus, row.method, row.questionId]);
    if (keys.has(key)) throw new Error('Duplicate base query in statistics.');
    keys.add(key);
    if (!Number.isFinite(row.metrics!.coverage) || row.metrics!.coverage < 0 || row.metrics!.coverage > 1) throw new Error('Invalid evidence coverage.');
  }
  const byDocument = (values: Array<{ documentId: string; value: number }>) => {
    const groups = new Map<string, number[]>();
    for (const row of values) groups.set(row.documentId, [...(groups.get(row.documentId) ?? []), row.value]);
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([documentId, values]) => ({ documentId, value: mean(values), nQuestions: values.length }));
  };
  const pairedComparisons = [];
  const bookSensitivity = [];
  for (const corpus of [...new Set(base.map(r => r.corpus))].sort()) {
    const own = base.filter(r => r.corpus === corpus), methods = [...new Set(own.map(r => r.method))].sort();
    for (const baseline of ['openai-dense', 'hybrid-bge']) {
      const controls = new Map(own.filter(r => r.method === baseline).map(r => [r.questionId, r]));
      if (!controls.size) continue;
      for (const method of methods.filter(m => m !== baseline)) {
        const arm = own.filter(r => r.method === method);
        const paired = arm.filter(r => controls.has(r.questionId)).map(r => {
          const control = controls.get(r.questionId)!;
          if (r.documentId !== control.documentId) throw new Error('A paired question changed documents.');
          return { documentId: r.documentId, value: r.metrics!.coverage - control.metrics!.coverage };
        });
        if (!paired.length) continue;
        const documents = byDocument(paired);
        pairedComparisons.push({ corpus, method, baseline, ...clusterBootstrap(paired, iterations, seed),
          nPairs: paired.length, missingMethod: controls.size - paired.length, missingBaseline: arm.length - paired.length,
          perDocument: documents,
          leaveOneDocumentOut: documents.length > 1 ? documents.map(d => ({ omittedDocumentId: d.documentId, difference: mean(documents.filter(x => x.documentId !== d.documentId).map(x => x.value)) })) : [],
          interpretation: 'Exploratory paired differences with pointwise percentile intervals; no multiplicity-adjusted significance claim.' });
      }
    }
    if (/book|openstax/i.test(corpus)) for (const method of methods) {
      const documents = byDocument(own.filter(r => r.method === method).map(r => ({ documentId: r.documentId, value: r.metrics!.coverage })));
      bookSensitivity.push({ corpus, method, mean: mean(documents.map(d => d.value)), perBook: documents,
        leaveOneBookOut: documents.length > 1 ? documents.map(d => ({ omittedDocumentId: d.documentId, coverage: mean(documents.filter(x => x.documentId !== d.documentId).map(x => x.value)) })) : [] });
    }
  }
  return { pairedComparisons, bookSensitivity };
}

export function costCurve(preparationUsd: string, meanQueryUsd: string, unknownAttempts = 0) {
  if (unknownAttempts > 0) return null;
  const preparation = new Decimal(preparationUsd), query = new Decimal(meanQueryUsd);
  if (!preparation.isFinite() || !query.isFinite() || preparation.isNegative() || query.isNegative()) throw new Error('Invalid API cost.');
  return [1, 5, 10, 50, 100, 1000].map(queries => {
    const total = preparation.add(query.mul(queries));
    return { queries, totalUsd: total.toFixed(), amortizedUsd: total.div(queries).toFixed() };
  });
}

export function costBreakEven(a: { preparationUsd: string; queryMeanUsd: string; unknownCostAttempts: number }, b: { preparationUsd: string; queryMeanUsd: string; unknownCostAttempts: number }) {
  if (a.unknownCostAttempts || b.unknownCostAttempts) return { queries: null, reason: 'incomplete_costs' };
  const slope = new Decimal(a.queryMeanUsd).minus(b.queryMeanUsd);
  if (slope.isZero()) return { queries: null, reason: new Decimal(a.preparationUsd).eq(b.preparationUsd) ? 'identical_lines' : 'parallel_lines' };
  const crossing = new Decimal(b.preparationUsd).minus(a.preparationUsd).div(slope);
  return crossing.isPositive() ? { queries: crossing.toFixed(), reason: 'positive_crossing' } : { queries: null, reason: 'no_positive_crossing' };
}
