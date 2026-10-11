import { Decimal } from 'decimal.js';
import { CanonicalTokens, clusterBootstrap, evaluateRetrieval, intersectionSize } from './metrics.js';
import { prepareDocument } from './datasets.js';
import { METHOD_IDS, METHOD_LABELS, type DatasetBundle, type MethodReport, type ResearchReport } from './types.js';
import { Ledger } from './ledger.js';
import { combineBundles, type ExperimentManifest } from './runner.js';
import { mean, quantile } from './util.js';
import { costBreakEven, studyStatistics } from './statistics.js';
import { implementationSnapshot } from './implementation.js';

export async function evaluateExperiment(manifest: ExperimentManifest, bundles: DatasetBundle[], ledger: Ledger): Promise<ResearchReport> {
  if (implementationSnapshot().hash !== manifest.implementationHash) throw new Error('Evaluation implementation differs from the frozen experiment; restore its source snapshot before recomputing results.');
  const combined = combineBundles(bundles); if (combined.datasetHash !== manifest.datasetHash) throw new Error('Report dataset hash mismatch.');
  const runs = ledger.runs().filter(r => r.id.startsWith(manifest.id + ':')).map(r => ({ ...r, ...(ledger.get<Record<string, unknown>>(`${r.id}:generation-result`) ?? {}) })), attempts = ledger.attempts().filter(a => a.runId.startsWith(manifest.id + ':'));
  const questions = new Map(combined.questions.map(q => [q.id, q]));
  const docs = new Map(await Promise.all(combined.documents.map(async doc => { const prepared = await prepareDocument(doc, manifest.config.chunkTokens, manifest.config.overlapTokens, manifest.config.maxDocumentTokens); return [doc.id, { ...prepared, tokens: new CanonicalTokens(prepared.text) }] as const; })));
  const metrics = new Map<string, ReturnType<typeof evaluateRetrieval>>();
  for (const run of runs.filter(r => r.round === 0 && METHOD_IDS.includes(r.method as MethodReport['id']))) {
    const q = questions.get(run.questionId); if (!q) throw new Error('Unknown report question.'); if (q.unanswerable) continue;
    const doc = docs.get(run.documentId)!, byId = new Map(doc.chunks.map(c => [c.id, c]));
    const retrieved = run.status === 'completed' ? run.ranking.map(r => { const chunk = byId.get(r.chunkId); if (!chunk) throw new Error('Unknown retrieved chunk.'); return chunk; }) : [];
    metrics.set(run.id, evaluateRetrieval(doc.tokens, doc.chunks, retrieved, q.evidenceSets, manifest.config.topK));
  }
  const macro = (rows: Array<{ documentId: string; value: number }>) => { const groups = new Map<string, number[]>(); for (const r of rows) groups.set(r.documentId, [...(groups.get(r.documentId) ?? []), r.value]); return mean([...groups.values()].map(mean)); };
  const methods: MethodReport[] = [];
  for (const corpus of [...new Set(combined.sources.map(s => s.corpus))]) for (const method of manifest.config.methods) {
    const all = runs.filter(r => r.corpus === corpus && r.method === method), base = all.filter(r => r.round === 0), ownDocs = [...new Set(base.map(r => r.documentId))];
    if (!base.length) continue;
    const positive = base.filter(r => metrics.has(r.id)), rows = positive.map(r => ({ documentId: r.documentId, value: metrics.get(r.id)!.coverage }));
    const ci = rows.length ? clusterBootstrap(rows, manifest.config.bootstrapSamples, manifest.config.seed) : undefined;
    const time = all.filter(r => r.timingSample && r.status === 'completed' && r.timingValid !== false).map(r => r.elapsedMs);
    const methodAttempts = attempts.filter(a => (a.method === method || (manifest.config.structure && a.operation === 'structure')) && ownDocs.includes(a.documentId));
    const preparation = methodAttempts.filter(a => a.operation === 'document_embedding' || a.operation === 'structure');
    const retrieval = methodAttempts.filter(a => !['document_embedding', 'structure', 'generation'].includes(a.operation));
    const preparationUsd = ownDocs.reduce((sum, id) => sum.add(preparation.filter(a => a.documentId === id).reduce((n, a) => n.add(a.costUsd ?? 0), new Decimal(0))), new Decimal(0)).div(ownDocs.length).toFixed();
    const queryMeanUsd = ownDocs.reduce((sum, id) => { const docRuns = base.filter(r => r.documentId === id); return sum.add(docRuns.reduce((n, r) => n.add(retrieval.filter(a => a.runId === r.id).reduce((s, a) => s.add(a.costUsd ?? 0), new Decimal(0))), new Decimal(0)).div(docRuns.length)); }, new Decimal(0)).div(ownDocs.length).toFixed();
    const unknownCostAttempts = methodAttempts.filter(a => a.costUsd === null).length;
    methods.push({ id: method, label: METHOD_LABELS[method], corpus, coverage: ci?.mean ?? null, ...(ci ? { coverageLow: ci.low, coverageHigh: ci.high } : {}), latencyP50Ms: time.length ? quantile(time, 0.5) : null, ...(time.length ? { latencyP95Ms: quantile(time, 0.95) } : {}), preparationUsd, queryMeanUsd, unknownCostAttempts, nQueries: base.length, nAnswerable: positive.length, failures: base.filter(r => r.status !== 'completed').length, nTimingRuns: time.length, timingFailures: all.filter(r => r.timingSample && (r.status !== 'completed' || r.timingValid === false)).length,
      ...(positive.length ? { completeGold: macro(positive.map(r => ({ documentId: r.documentId, value: Number(metrics.get(r.id)!.completeGold) }))), oracleCoverage: macro(positive.map(r => ({ documentId: r.documentId, value: metrics.get(r.id)!.oracleCoverage }))), normalizedCoverage: macro(positive.map(r => ({ documentId: r.documentId, value: metrics.get(r.id)!.normalizedCoverage }))), tokenPrecision: macro(positive.map(r => ({ documentId: r.documentId, value: metrics.get(r.id)!.precision }))) } : {}),
      ...(unknownCostAttempts === 0 ? { projections: [1, 5, 10, 50, 100, 1000].map(queries => { const total = new Decimal(preparationUsd).add(new Decimal(queryMeanUsd).mul(queries)); return { queries, totalUsd: total.toFixed(), amortizedUsd: total.div(queries).toFixed() }; }) } : {}) });
  }
  const retentionRows = new Map<string, Array<{ documentId: string; questionId: string; value: number }>>();
  for (const run of runs.filter(r => r.round === 0 && r.status === 'completed')) {
    const q = questions.get(run.questionId)!; if (q.unanswerable) continue;
    const doc = docs.get(run.documentId)!, byId = new Map(doc.chunks.map(c => [c.id, c]));
    let stage = 0;
    for (const trace of run.traces.filter(t => ['hybrid50', 'retained', 'final'].includes(t.stage))) {
      const retained = trace.retainedIds.map(id => { const c = byId.get(id); if (!c) throw new Error('Unknown trace candidate.'); return doc.tokens.span(c); });
      const value = Math.max(...q.evidenceSets.map(set => mean(set.map(span => { const unit = doc.tokens.span(span); return intersectionSize([unit], retained) / (unit.end - unit.start); }))));
      const key = [run.method, run.corpus, stage++].join('|'); retentionRows.set(key, [...(retentionRows.get(key) ?? []), { documentId: run.documentId, questionId: run.questionId, value }]);
    }
  }
  const retention: ResearchReport['retention'] = [...retentionRows].map(([key, rows]) => { const [method, corpus, stage] = key.split('|'); return { method: method as MethodReport['id'], corpus, stage: Number(stage), coverage: macro(rows), nQueries: new Set(rows.map(r => r.questionId)).size }; });
  const perQuery = runs.map(r => ({ ...r, metrics: metrics.get(r.id) ?? null }));
  const breakEven = methods.flatMap((a, i) => methods.slice(i + 1).filter(b => b.corpus === a.corpus).map(b => ({ corpus: a.corpus, method: a.id, baseline: b.id, ...costBreakEven(a, b) })));
  return { schemaVersion: 1, kind: manifest.kind, datasetHash: manifest.datasetHash, experimentId: manifest.id, configHash: manifest.configHash, implementationHash: manifest.implementationHash, aggregation: 'document_macro', evidenceCoverage: 'max alternative of mean per-evidence-unit token coverage; overlapping retrieval tokens counted once', oracle: 'exact interval dynamic programming at k=5; no greedy fallback', qualityFailures: 'zero retrieved evidence for failed assigned base runs; failures counted explicitly', missingScheduledRuns: manifest.schedule.length - runs.length, methods, retention, breakEven,
    ...(manifest.bookAnnotation ? { bookAnnotation: manifest.bookAnnotation } : {}),
    perQuery, ...studyStatistics(perQuery, { iterations: manifest.config.bootstrapSamples, seed: manifest.config.seed }), timing: { configuredQuestions: manifest.config.timing.questions, rounds: manifest.config.timing.rounds, excludeResumed: true, latencyBasis: 'completed timed subset runs only, cold document preparation excluded; full retrieval wall time' },
    budget: ledger.totals(), experimentObservedUsd: attempts.reduce((sum, a) => sum.add(a.costUsd ?? 0), new Decimal(0)).toFixed(), generationObservedUsd: attempts.filter(a => a.operation === 'generation').reduce((sum, a) => sum.add(a.costUsd ?? 0), new Decimal(0)).toFixed(), generationFailures: runs.filter(r => r.generationError).length, resources: 'CPU, RAM, disk, electricity unpriced', preparation: combined.documents.map(d => ({ documentId: d.id, ...ledger.get<Record<string, unknown>>(`${manifest.id}:preparation:${d.id}`) })), prices: manifest.config.rates };
}
