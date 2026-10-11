/** Read-only scientific audit and semantic-phase summaries for a frozen study. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Decimal } from 'decimal.js';
import { canonicalText, prepareDocument, validateFreeze } from '../datasets.js';
import { CanonicalTokens, intersectionSize, intervalSize, clusterBootstrap } from '../metrics.js';
import { contextContentTokens, oracleContext, planRetrievalContext } from '../context.js';
import { generationBody } from '../ragas/export.js';
import { studyStatistics } from '../statistics.js';
import { hashObject, mean, readJson, sha256, writeJson } from '../util.js';
import { METHOD_IDS, type DatasetBundle, type FrozenQuestion, type GenerationContextManifest, type PreparedDocument, type QueryRun, type ResearchConfig, type RetrievalMetrics } from '../types.js';
import type { ExperimentManifest, ScheduledRun } from '../runner.js';
import type { PaidAttempt } from '../ledger.js';

type ScoredRun = QueryRun & { metrics: RetrievalMetrics | null };
type Point = { phase: string; coverage: number; candidates: number; level?: number };

/** Count the exact historical generator input, not a new packing of the ranking.
 * Reconstruction is admitted only when its full provider-payload hash matches
 * one completed attempt; legacy outputs without a manifest use the same check.
 */
export function generationInputFacts(run: QueryRun, document: PreparedDocument, question: FrozenQuestion, config: ResearchConfig, attempts: PaidAttempt[], tokens = new CanonicalTokens(document.text)) {
  if (!run.generation) return null;
  if (run.status !== 'completed') throw new Error('Generation requires a completed retrieval/control run.');
  const isRetrieval = METHOD_IDS.includes(run.method as typeof METHOD_IDS[number]);
  const plan = isRetrieval ? planRetrievalContext(document, run.ranking) : undefined;
  const contexts = run.method === 'closed-book' ? [] : run.method === 'oracle' ? oracleContext(document, question) : plan!.contexts;
  const contextManifest: GenerationContextManifest = plan?.manifest ?? { policy: run.method === 'closed-book' ? 'closed-book-v1' : 'complete-gold-or-ineligible-v1', selectedChunkIds: [], omittedChunkIds: [], contentTokens: contextContentTokens(contexts), budget: 2500 };
  if (run.generation.contextManifest && hashObject(run.generation.contextManifest) !== hashObject(contextManifest)) throw new Error(`Historical generation context manifest differs: ${run.id}`);
  const payloadHash = hashObject(generationBody(question, contexts, run.method, config));
  const matching = attempts.filter(a => a.runId === run.id && a.operation === 'generation' && a.status === 'completed' && a.payloadHash === payloadHash);
  if (matching.length !== 1) throw new Error(`Cannot prove one exact historical generation input: ${run.id}`);
  const attempt = matching[0]!;
  if (attempt.documentId !== document.id || attempt.method !== run.method || attempt.model !== config.models.generation || attempt.reportedModel !== config.models.generation) throw new Error('Historical generation attempt identity/model differs.');
  const chunks = new Map(document.chunks.map(c => [c.id, c]));
  const retrievedIds = isRetrieval ? [...new Set(run.ranking.slice(0, 5).map(r => r.chunkId))] : [];
  const retrieved = retrievedIds.map(id => { const chunk = chunks.get(id); if (!chunk) throw new Error('Unknown retrieved generation passage.'); return tokens.span(chunk); });
  const selected = contextManifest.selectedChunkIds.map(id => { const chunk = chunks.get(id); if (!chunk) throw new Error('Unknown selected generation passage.'); return tokens.span(chunk); });
  const consumed = contexts.flatMap(c => c.spans).map(span => tokens.span(span));
  const coverage = (intervals: Array<{ start: number; end: number }>) => question.unanswerable ? null : Math.max(...question.evidenceSets.map(set => mean(set.map(span => { const unit = tokens.span(span); return intersectionSize([unit], intervals) / (unit.end - unit.start); }))));
  const retrievedSourceTokens = isRetrieval ? intervalSize(retrieved) : null, consumedSourceTokens = intervalSize(consumed);
  // Source-token unions and retokenized content budgets have different units:
  // the latter includes inserted separators and excludes citation/instruction overhead.
  return { runId: run.id, questionId: run.questionId, documentId: run.documentId, corpus: run.corpus, method: run.method,
    verifiedGenerationAttemptId: attempt.id, generationPayloadHash: payloadHash, policy: contextManifest.policy,
    retrievedPassages: retrievedIds.length, selectedPassages: contextManifest.selectedChunkIds.length,
    omittedPassages: contextManifest.omittedChunkIds.length, omittedChunkIds: contextManifest.omittedChunkIds,
    contexts: contexts.length, fewerContextsThanRetrieved: isRetrieval && contexts.length < retrievedIds.length,
    contentTokens: contextManifest.contentTokens, contentBudget: contextManifest.budget,
    retrievedSourceTokens, consumedSourceTokens,
    omittedSourceTokens: isRetrieval ? intervalSize(retrieved) - intersectionSize(retrieved, selected) : null,
    sourceTokensNotRepresented: isRetrieval ? intervalSize(retrieved) - intersectionSize(retrieved, consumed) : null,
    retrievedEvidenceCoverage: isRetrieval ? coverage(retrieved) : null, consumedEvidenceCoverage: coverage(consumed) };
}

type GenerationInputFacts = NonNullable<ReturnType<typeof generationInputFacts>>;
/** All counts retain assigned denominators; token means describe successful inputs only. */
export function summarizeGenerationInputs(schedule: ScheduledRun[], runs: QueryRun[], facts: GenerationInputFacts[]) {
  const byRun = new Map(runs.map(r => [r.id, r])), byFacts = new Map(facts.map(f => [f.runId, f]));
  if (byRun.size !== runs.length || byFacts.size !== facts.length) throw new Error('Duplicate generation summary run.');
  const groups = new Map<string, ScheduledRun[]>();
  for (const row of schedule.filter(s => s.generate)) { const key = JSON.stringify([row.corpus, row.method]); groups.set(key, [...(groups.get(key) ?? []), row]); }
  return [...groups.values()].map(assigned => {
    const completed = assigned.filter(s => byRun.get(s.id)?.generation);
    const own = completed.map(s => { const fact = byFacts.get(s.id); if (!fact) throw new Error('Successful generation lacks verified input facts.'); return fact; });
    const total = (select: (row: GenerationInputFacts) => number) => own.reduce((sum, row) => sum + select(row), 0);
    const average = (select: (row: GenerationInputFacts) => number) => own.length ? total(select) / own.length : null;
    const retrieval = own.filter(row => row.retrievedSourceTokens !== null);
    const macroCoverage = (key: 'retrievedEvidenceCoverage' | 'consumedEvidenceCoverage') => {
      const documents = new Map<string, number[]>();
      for (const row of own) if (row[key] !== null) documents.set(row.documentId, [...(documents.get(row.documentId) ?? []), row[key]!]);
      return documents.size ? mean([...documents.values()].map(mean)) : null;
    };
    return { corpus: assigned[0].corpus, method: assigned[0].method, scheduled: assigned.length, completed: own.length,
      failedOrUnavailable: assigned.length - own.length,
      oracleIneligible: assigned.filter(s => s.method === 'oracle' && byRun.get(s.id)?.generationError?.includes('control ineligible')).length,
      fewerContextsThanRetrieved: own.filter(row => row.fewerContextsThanRetrieved).length,
      omittedPassageGenerations: own.filter(row => row.omittedPassages > 0).length,
      sourceTokenLossGenerations: own.filter(row => (row.omittedSourceTokens ?? 0) > 0).length,
      emptyContextGenerations: own.filter(row => row.contexts === 0).length,
      retrievedPassagesTotal: total(row => row.retrievedPassages), selectedPassagesTotal: total(row => row.selectedPassages), omittedPassagesTotal: total(row => row.omittedPassages),
      contextsTotal: total(row => row.contexts), contextsMean: average(row => row.contexts),
      contentTokensTotal: total(row => row.contentTokens), contentTokensMean: average(row => row.contentTokens),
      retrievedSourceTokensTotal: retrieval.length ? retrieval.reduce((sum, row) => sum + row.retrievedSourceTokens!, 0) : null,
      retrievedSourceTokensMean: retrieval.length ? mean(retrieval.map(row => row.retrievedSourceTokens!)) : null,
      consumedSourceTokensTotal: total(row => row.consumedSourceTokens), consumedSourceTokensMean: average(row => row.consumedSourceTokens),
      omittedSourceTokensTotal: retrieval.length ? retrieval.reduce((sum, row) => sum + row.omittedSourceTokens!, 0) : null,
      retrievedEvidenceCoverageDocumentMacro: macroCoverage('retrievedEvidenceCoverage'), consumedEvidenceCoverageDocumentMacro: macroCoverage('consumedEvidenceCoverage') };
  });
}

/** Align semantic phases, never pool ordinal stage 1 from different-depth scans. */
export function semanticRetention(run: QueryRun, document: PreparedDocument, question: FrozenQuestion) {
  if (run.method !== 'jev-scan' || run.status !== 'completed' || question.unanswerable) return null;
  const tokens = new CanonicalTokens(document.text), chunks = new Map(document.chunks.map(c => [c.id, c]));
  const finals = run.traces.filter(t => t.stage === 'final');
  if (finals.length !== 1) throw new Error(`Expected one final selection: ${run.id}`);
  const final = finals[0], windows = run.traces.filter(t => t.stage === 'window' && t.level === 0);
  const initialIds = [...new Set(windows.flatMap(t => t.candidateIds))];
  const allCovered = initialIds.length === chunks.size && initialIds.every(id => chunks.has(id));
  if (!allCovered) throw new Error(`Completed full scan lacks complete initial coverage: ${run.id}`);
  const retained = run.traces.filter(t => t.stage === 'retained').sort((a, b) => a.level! - b.level!);
  if (new Set(retained.map(t => t.level)).size !== retained.length) throw new Error('Duplicate retained levels.');
  const score = (phase: string, ids: string[], level?: number): Point => {
    const unique = [...new Set(ids)], intervals = unique.map(id => { const chunk = chunks.get(id); if (!chunk) throw new Error('Unknown trace passage.'); return tokens.span(chunk); });
    const coverage = Math.max(...question.evidenceSets.map(set => mean(set.map(span => { const unit = tokens.span(span); return intersectionSize([unit], intervals) / (unit.end - unit.start); }))));
    return { phase, coverage, candidates: unique.length, ...(level === undefined ? {} : { level }) };
  };
  const first = retained.find(t => t.level === 0) ?? (final.level === 0 ? final : undefined);
  if (!first) throw new Error('Missing first-selection trace.');
  const phases = [score('initial-scan', initialIds, 0), score('first-selection', first.retainedIds, 0), score('final-input', final.candidateIds, final.level), score('final-five', final.retainedIds, final.level)];
  const rankingIds = run.ranking.map(r => r.chunkId);
  if (JSON.stringify(rankingIds) !== JSON.stringify(final.retainedIds)) throw new Error('Final trace differs from returned ranking.');
  const levels = retained.map(t => score('retained-level', t.retainedIds, t.level));
  // Removing candidates cannot increase union coverage of a fixed evidence set.
  const ordered = [phases[0], ...levels, phases[3]];
  if (ordered.some((p, i) => i > 0 && p.coverage > ordered[i - 1].coverage + 1e-12)) throw new Error('Evidence retention unexpectedly increased.');
  return { runId: run.id, questionId: run.questionId, documentId: run.documentId, corpus: run.corpus, initialPassages: chunks.size, initialWindows: windows.length, finalLevel: final.level, allInitialPassagesCovered: true, phases, levels };
}

export function auditAttemptCost(attempt: PaidAttempt): string | null {
  if (attempt.costUsd === null) return null;
  const input = attempt.inputTokens, output = attempt.outputTokens;
  const cached = attempt.cachedTokens ?? 0, written = attempt.cacheWriteTokens ?? 0;
  if (![input, output, cached, written].every(n => Number.isSafeInteger(n) && n! >= 0) || cached + written > input!) throw new Error(`Invalid reported usage: ${attempt.id}`);
  if (written && attempt.price.cacheWrite === undefined) throw new Error('Unpriced cache writes.');
  const cost = new Decimal(input! - cached - written).mul(attempt.price.input)
    .add(new Decimal(cached).mul(attempt.price.cachedInput ?? attempt.price.input))
    .add(new Decimal(written).mul(attempt.price.cacheWrite ?? '0'))
    .add(new Decimal(output!).mul(attempt.price.output)).div(1e6);
  if (!cost.eq(attempt.costUsd)) throw new Error(`Recorded cost differs from historical usage/rate: ${attempt.id}`);
  return cost.toFixed();
}

type CostAuditableReport = {
  methods: Array<{ id: string; corpus: string; nQueries: number; preparationUsd: string; queryMeanUsd: string; unknownCostAttempts: number }>;
  perQuery: QueryRun[];
};

/** Reconstruct the frozen report's known subtotals without settling unknown bills.
 * The per-document sums retain exact finite USD amounts; downstream code can
 * form rational macro lower bounds and round downward without rounding up a bound.
 */
export function auditMethodCosts(report: CostAuditableReport, manifest: ExperimentManifest, attempts: PaidAttempt[]) {
  const known = (value: string, label: string) => { const result = new Decimal(value); if (!result.isFinite() || result.isNegative()) throw new Error(`Invalid nonnegative ${label}.`); return result; };
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (ids.has(attempt.id) || !attempt.runId.startsWith(manifest.id + ':')) throw new Error('Duplicate or foreign cost attempt.'); ids.add(attempt.id);
    if (!['document_embedding', 'structure', 'query_embedding', 'window', 'reduction', 'generation'].includes(attempt.operation)) throw new Error(`Unsupported historical cost operation: ${attempt.operation}`);
    known(attempt.reservedUsd, 'reservation');
    for (const rate of [attempt.price.input, attempt.price.output, attempt.price.cachedInput, attempt.price.cacheWrite]) if (rate !== undefined) known(rate, 'historical rate');
    if (attempt.costUsd !== null) { known(attempt.costUsd, 'observed charge'); auditAttemptCost(attempt); }
  }
  const summarize = (rows: PaidAttempt[]) => ({ attempts: rows.length, knownAttempts: rows.filter(a => a.costUsd !== null).length,
    unknownAttempts: rows.filter(a => a.costUsd === null).length,
    knownSubtotalUsd: rows.reduce((sum, a) => sum.add(a.costUsd ?? 0), new Decimal(0)).toFixed(),
    unresolvedReservationUsd: rows.filter(a => a.costUsd === null).reduce((sum, a) => sum.add(a.reservedUsd), new Decimal(0)).toFixed() });
  const seen = new Set<string>();
  const methods = report.methods.map(row => {
    const key = JSON.stringify([row.corpus, row.id]);
    if (seen.has(key)) throw new Error('Duplicate method/corpus cost row.'); seen.add(key);
    const base = report.perQuery.filter(run => run.corpus === row.corpus && run.method === row.id && run.round === 0);
    const scheduled = manifest.schedule.filter(run => run.corpus === row.corpus && run.method === row.id && run.round === 0);
    const runIds = new Set(base.map(run => run.id));
    if (!base.length || runIds.size !== base.length || base.length !== row.nQueries || base.length !== scheduled.length || scheduled.some(run => !runIds.has(run.id))) throw new Error('Cost base-run cohort differs from all assigned queries.');
    for (const run of base) {
      const assigned = scheduled.find(s => s.id === run.id)!;
      if (run.documentId !== assigned.documentId || run.questionId !== assigned.questionId) throw new Error('Cost base-run identity differs from the frozen assignment.');
    }
    const documentIds = [...new Set(base.map(run => run.documentId))];
    // Match report.ts exactly: optional structure preparation is shared and
    // attributed to each method, while the experiment ledger counts it once.
    const own = attempts.filter(a => documentIds.includes(a.documentId) && (a.method === row.id || (manifest.config.structure && a.operation === 'structure')));
    const preparation = own.filter(a => ['document_embedding', 'structure'].includes(a.operation));
    const retrieval = own.filter(a => !['document_embedding', 'structure', 'generation'].includes(a.operation));
    const baseRetrieval = retrieval.filter(a => runIds.has(a.runId));
    const repeatedRetrieval = retrieval.filter(a => !runIds.has(a.runId));
    const generation = own.filter(a => a.operation === 'generation');
    for (const attempt of [...retrieval, ...generation]) {
      const assigned = manifest.schedule.find(run => run.id === attempt.runId);
      if (!assigned || assigned.method !== row.id || assigned.corpus !== row.corpus || assigned.documentId !== attempt.documentId || (attempt.operation === 'generation' && !assigned.generate)) throw new Error('Cost attempt lacks an exact frozen run attribution.');
    }
    const categories = { preparation: summarize(preparation), baseRetrieval: summarize(baseRetrieval), repeatedRetrieval: summarize(repeatedRetrieval), generation: summarize(generation) };
    const perDocument = documentIds.map(documentId => {
      const assigned = base.filter(run => run.documentId === documentId), ownIds = new Set(assigned.map(run => run.id));
      return { documentId, nBaseRuns: assigned.length,
        preparation: summarize(preparation.filter(a => a.documentId === documentId)),
        baseRetrieval: summarize(baseRetrieval.filter(a => ownIds.has(a.runId))) };
    });
    const preparationUsd = perDocument.reduce((sum, document) => sum.add(document.preparation.knownSubtotalUsd), new Decimal(0)).div(documentIds.length);
    const queryUsd = perDocument.reduce((sum, document) => sum.add(new Decimal(document.baseRetrieval.knownSubtotalUsd).div(document.nBaseRuns)), new Decimal(0)).div(documentIds.length);
    if (!preparationUsd.eq(row.preparationUsd) || !queryUsd.eq(row.queryMeanUsd)) throw new Error('Known cost subtotals do not reconcile with the frozen report macro means.');
    const unknownAttempts = Object.values(categories).reduce((sum, category) => sum + category.unknownAttempts, 0);
    if (unknownAttempts !== row.unknownCostAttempts) throw new Error('Method unknown-cost flag differs from the audited attempt partition.');
    return { corpus: row.corpus, method: row.id, nDocuments: documentIds.length, nBaseRuns: base.length,
      knownPreparationUsdPerDocument: preparationUsd.toFixed(), knownQueryUsdPerAssignedBaseQuery: queryUsd.toFixed(),
      preparationComplete: categories.preparation.unknownAttempts === 0, baseRetrievalComplete: categories.baseRetrieval.unknownAttempts === 0,
      methodUnknownAttempts: unknownAttempts, categories, perDocument };
  });
  return { schemaVersion: 1, kind: 'audited-method-cost-subtotals', experimentId: manifest.id, datasetHash: manifest.datasetHash,
    aggregation: 'document_macro', experiment: summarize(attempts), methods,
    policy: 'Known historical nonnegative API charges only. Unknown charges are omitted from known subtotals, never settled at zero. Preparation is averaged across all assigned documents; query cost averages assigned base-run known costs within each document, then documents. Failures and unanswerable assignments remain in denominators. Incomplete components support known-subtotal lower bounds; reuse curves remain conditional arithmetic projections, not guaranteed bounds on future invoices. Reservations are unresolved budget commitments, not observed costs or demonstrated upper bounds. Generation and non-base retrieval uncertainty are separate. Shared structure costs are attributed to methods as in the frozen report and must not be summed again as experiment spending.' };
}

export async function readout(directory: string, ledgerPath: string, output: string) {
  const manifest = readJson<ExperimentManifest>(join(directory, 'manifest.json'));
  if (manifest.kind !== 'measured') throw new Error('Only measured experiments are eligible.');
  const bundles = readJson<DatasetBundle[]>(join(directory, 'datasets.json'));
  for (const bundle of bundles) validateFreeze(bundle.freeze);
  const report = readJson<Omit<CostAuditableReport, 'perQuery'> & { datasetHash: string; experimentId: string; implementationHash: string; perQuery: ScoredRun[]; experimentObservedUsd: string; missingScheduledRuns: number }>(join(directory, 'report.json'));
  if (report.datasetHash !== manifest.datasetHash || report.experimentId !== manifest.id || report.implementationHash !== manifest.implementationHash || hashObject(bundles.map(b => b.freeze.hash).sort()) !== manifest.datasetHash) throw new Error('Report/manifest/data identity mismatch.');
  const snapshot = readJson<{ hash: string; files: Record<string, string> }>(join(directory, 'source-snapshot.json'));
  if (snapshot.hash !== manifest.implementationHash || hashObject(snapshot.files) !== snapshot.hash) throw new Error('Invalid frozen implementation snapshot.');
  const questions = new Map(bundles.flatMap(b => b.freeze.questions).map(q => [q.id, q]));
  const documents = new Map(bundles.flatMap(b => b.freeze.documents).map(d => [d.id, d]));
  const sources = new Map(bundles.flatMap(b => b.sources).map(s => [s.documentId, s]));
  const db = new DatabaseSync(resolve(ledgerPath), { readOnly: true });
  let attempts: PaidAttempt[];
  try {
    if (String(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0]) !== 'ok') throw new Error('SQLite integrity check failed.');
    const frozen = db.prepare('SELECT value FROM immutable WHERE key=?').get(`experiment:${manifest.id}`);
    if (!frozen || hashObject(JSON.parse(String(frozen.value))) !== hashObject(manifest)) throw new Error('Manifest differs from the ledger.');
    attempts = db.prepare('SELECT value FROM attempts').all().map(row => JSON.parse(String(row.value)) as PaidAttempt).filter(a => a.runId.startsWith(manifest.id + ':'));
    const seen = new Set<string>();
    for (const run of report.perQuery) {
      if (seen.has(run.id)) throw new Error('Duplicate report run.'); seen.add(run.id);
      const saved = db.prepare('SELECT value FROM runs WHERE id=?').get(run.id);
      if (!saved) throw new Error('Missing ledger run.');
      const { metrics: _metrics, generation: _generation, generationError: _error, ...raw } = run;
      if (hashObject(raw) !== hashObject(JSON.parse(String(saved.value)))) throw new Error(`Report retrieval differs from ledger: ${run.id}`);
      if (run.generation || run.generationError) {
        const generated = db.prepare('SELECT value FROM immutable WHERE key=?').get(`${run.id}:generation-result`);
        if (!generated || hashObject(JSON.parse(String(generated.value))) !== hashObject(run.generation ? { generation: run.generation } : { generationError: run.generationError })) throw new Error('Generation differs from ledger.');
        if (run.generation?.contextManifest) {
          const context = db.prepare('SELECT value FROM immutable WHERE key=?').get(`${run.id}:generation-context`);
          if (!context || hashObject(JSON.parse(String(context.value))) !== hashObject(run.generation.contextManifest)) throw new Error('Generation context manifest differs from ledger.');
        }
      }
    }
    if (manifest.schedule.filter(s => !seen.has(s.id)).length !== report.missingScheduledRuns) throw new Error('Missing-run count differs.');
  } finally { db.close(); }
  let observed = new Decimal(0), unknown = 0;
  const costByOperation: Record<string, { calls: number; unknown: number; usd: string }> = {};
  for (const attempt of attempts!) {
    const cost = auditAttemptCost(attempt), group = costByOperation[attempt.operation] ??= { calls: 0, unknown: 0, usd: '0' };
    group.calls++;
    if (cost === null) { unknown++; group.unknown++; }
    else { observed = observed.add(cost); group.usd = new Decimal(group.usd).add(cost).toFixed(); }
  }
  if (!observed.eq(report.experimentObservedUsd)) throw new Error('Experiment total differs from audited ledger.');
  const costAudit = auditMethodCosts(report, manifest, attempts!);
  const prepared = new Map<string, PreparedDocument>(), retention = [];
  for (const run of report.perQuery.filter(r => r.round === 0 && r.method === 'jev-scan' && r.status === 'completed')) {
    const question = questions.get(run.questionId)!;
    if (question.unanswerable) continue;
    let document = prepared.get(run.documentId);
    if (!document) { document = await prepareDocument(documents.get(run.documentId)!, manifest.config.chunkTokens, manifest.config.overlapTokens, manifest.config.maxDocumentTokens); prepared.set(document.id, document); }
    const row = semanticRetention(run, document, question)!;
    if (Math.abs(row.phases.at(-1)!.coverage - run.metrics!.coverage) > 1e-12) throw new Error('Independent final coverage differs from reported EC@5.');
    retention.push(row);
  }
  const retentionSummary = [];
  for (const corpus of [...new Set(retention.map(r => r.corpus))]) for (const phase of ['initial-scan', 'first-selection', 'final-input', 'final-five']) {
    const own = retention.filter(r => r.corpus === corpus);
    const rows = own.map(r => ({ documentId: r.documentId, value: r.phases.find(p => p.phase === phase)!.coverage }));
    retentionSummary.push({ corpus, phase, ...clusterBootstrap(rows, manifest.config.bootstrapSamples, manifest.config.seed), nQuestions: rows.length, nDocuments: new Set(rows.map(r => r.documentId)).size });
  }
  const base = report.perQuery.filter(r => r.round === 0 && r.metrics && METHOD_IDS.includes(r.method as typeof METHOD_IDS[number]));
  const typeSummary = [];
  for (const corpus of [...new Set(base.map(r => r.corpus))]) for (const type of ['factual', 'explanatory', 'multi_section']) for (const method of manifest.config.methods) {
    const rows = base.filter(r => r.corpus === corpus && r.method === method && questions.get(r.questionId)?.questionType === type).map(r => ({ documentId: r.documentId, value: r.metrics!.coverage }));
    if (rows.length) typeSummary.push({ corpus, type, method, ...clusterBootstrap(rows, manifest.config.bootstrapSamples, manifest.config.seed), nQuestions: rows.length, nDocuments: new Set(rows.map(r => r.documentId)).size });
  }
  const aiOnly = base.filter(r => questions.get(r.questionId)?.annotation?.mode === 'model_generated');
  const generationInputs: GenerationInputFacts[] = [], tokenMaps = new Map<string, CanonicalTokens>();
  for (const scheduled of manifest.schedule.filter(s => s.generate)) {
    const run = report.perQuery.find(r => r.id === scheduled.id); if (!run?.generation) continue;
    let document = prepared.get(run.documentId);
    if (!document) { document = await prepareDocument(documents.get(run.documentId)!, manifest.config.chunkTokens, manifest.config.overlapTokens, manifest.config.maxDocumentTokens); prepared.set(document.id, document); }
    let tokens = tokenMaps.get(document.id); if (!tokens) { tokens = new CanonicalTokens(document.text); tokenMaps.set(document.id, tokens); }
    generationInputs.push(generationInputFacts(run, document, questions.get(run.questionId)!, manifest.config, attempts!, tokens)!);
  }
  const generationContextSummary = summarizeGenerationInputs(manifest.schedule, report.perQuery, generationInputs);
  const generationSummary = [];
  for (const corpus of [...new Set(manifest.schedule.map(s => s.corpus))]) for (const method of [...manifest.config.methods, 'oracle', 'closed-book']) {
    const scheduled = manifest.schedule.filter(s => s.corpus === corpus && s.method === method && s.generate);
    for (const answerable of [true, false]) {
      const own = scheduled.filter(s => !questions.get(s.questionId)!.unanswerable === answerable);
      if (!own.length) continue;
      const runs = own.map(s => report.perQuery.find(r => r.id === s.id));
      generationSummary.push({ corpus, method, answerable, scheduled: own.length, completed: runs.filter(r => r?.generation).length, abstained: runs.filter(r => r?.generation?.abstained).length, failedOrUnavailable: runs.filter(r => !r?.generation).length });
    }
  }
  const result = { schemaVersion: 1, kind: 'measured-study-readout', phase: manifest.phase, experimentId: manifest.id,
    hashes: { manifest: sha256(readFileSync(join(directory, 'manifest.json'))), report: sha256(readFileSync(join(directory, 'report.json'))), datasets: sha256(readFileSync(join(directory, 'datasets.json'))), ledgerSnapshot: sha256(readFileSync(ledgerPath)), analysis: sha256(readFileSync(new URL(import.meta.url))), generationBodyHelper: sha256(readFileSync(new URL('../ragas/export.ts', import.meta.url))) },
    protocol: { datasetHash: manifest.datasetHash, implementationHash: manifest.implementationHash, aggregation: 'document_macro', retention: 'Same completed positive base-run cohort at four semantic phases. One-window first selection is its final five.', bookReferences: manifest.bookAnnotation ?? null },
    counts: { questions: questions.size, documents: documents.size, scheduled: manifest.schedule.length, recorded: report.perQuery.length, missing: report.missingScheduledRuns, failed: report.perQuery.filter(r => r.status !== 'completed').length, humanBookQuestions: [...questions.values()].filter(q => /openstax/.test(sources.get(q.documentId)!.corpus) && q.annotation?.mode === 'single_annotator').length, modelBookQuestions: [...questions.values()].filter(q => q.annotation?.mode === 'model_generated').length },
    cost: { observedUsd: observed.toFixed(), unknownAttempts: unknown, byOperation: costByOperation }, costAudit,
    retentionSummary, retentionPerQuery: retention, typeSummary,
    modelAuthoredOnlySensitivity: studyStatistics(aiOnly, { iterations: manifest.config.bootstrapSamples, seed: manifest.config.seed }), generationSummary,
    generationContextSummary, generationInputPerQuery: generationInputs,
    generationContextPolicy: 'Successful inputs only, verified against full historical provider-payload hashes. Content tokens include excerpt separators but not labels/instructions; source-token unions use canonical document tokenization. Consumed source intervals exclude original block separators that are replaced while joining excerpts, so a raw source-union deficit need not imply omitted evidence. omittedSourceTokens and sourceTokenLossGenerations count only loss from omitted passage contributions. Omitted passages are distinguished from overlap deduplication. Unavailable/oversized oracle controls are counted, never assigned zero evidence or token means. Judge unscorability is reported by the separate RAGAS analysis.',
    documents: [...documents.values()].map(d => ({ id: d.id, title: d.title, corpus: sources.get(d.id)!.corpus, questions: [...questions.values()].filter(q => q.documentId === d.id).length, charactersUtf16: canonicalText(d).length, hash: d.hash })) };
  writeJson(output, result, true);
  return { output, counts: result.counts, observedUsd: observed.toFixed(), unknownAttempts: unknown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, ledger, output] = process.argv.slice(2);
  if (!directory || !ledger || !output) throw new Error('Usage: tsx study-readout.ts EXPERIMENT_DIR SQLITE_BACKUP OUTPUT_JSON');
  console.log(await readout(directory, ledger, output));
}
