/** Select the two predeclared extreme retrieval contrasts; offline, no references edited.
 * tsx research/scripts/qualitative-cases.ts SNAPSHOT_DIR READOUT_JSON NEW_OUTPUT_JSON
 * A verified snapshot-stage.json must authorize complete base-run quality analysis.
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareDocument } from '../datasets.js';
import { CanonicalTokens, intersectionSize } from '../metrics.js';
import { combineBundles, type ExperimentManifest } from '../runner.js';
import { METHOD_IDS, type DatasetBundle, type FrozenQuestion, type PreparedDocument, type QueryRun, type ResearchReport, type RetrievalMetrics } from '../types.js';
import { hashObject, mean, sha256 } from '../util.js';
import { semanticRetention } from './study-readout.js';

export const RULE_SHA256 = '145a7af294128b07209ef2d8f4445a602a78c0d8c00944af866860acefea7644';
const RULE_PATH = new URL('../../output/paper-protocol-20261004/qualitative-selection.json', import.meta.url);
type ScoredRun = QueryRun & { metrics: RetrievalMetrics | null; generate?: boolean };
type Retention = NonNullable<ReturnType<typeof semanticRetention>>;
type Report = ResearchReport & { experimentId: string; configHash: string; implementationHash: string; missingScheduledRuns: number; perQuery: ScoredRun[] };
type Readout = { kind: string; experimentId: string; phase: string; hashes: Record<string, string>; protocol: { datasetHash: string; implementationHash: string }; counts: { scheduled: number; recorded: number; missing: number }; retentionPerQuery: Retention[] };
type Pair = { questionId: string; documentId: string; difference: number; jev: ScoredRun; dense: ScoredRun };
const lex = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Eligibility and exact tie-breaking follow the frozen rule, not observed outcomes. */
export function selectContrasts(runs: ScoredRun[], questions: FrozenQuestion[]) {
  const questionMap = new Map(questions.map(q => [q.id, q]));
  const byQuestion = new Map<string, Map<string, ScoredRun>>();
  for (const run of runs.filter(r => r.round === 0 && r.corpus === 'openstax-books' && ['jev-scan', 'openai-dense'].includes(r.method))) {
    const question = questionMap.get(run.questionId);
    check(question && question.documentId === run.documentId, 'Unknown or mismatched book question.');
    const own = byQuestion.get(run.questionId) ?? new Map<string, ScoredRun>();
    check(!own.has(run.method), 'Duplicate comparison base run.');
    own.set(run.method, run); byQuestion.set(run.questionId, own);
  }
  const eligible: Pair[] = [];
  for (const [questionId, own] of byQuestion) {
    const jev = own.get('jev-scan'), dense = own.get('openai-dense');
    if (questionMap.get(questionId)!.unanswerable || jev?.status !== 'completed' || dense?.status !== 'completed') continue;
    check(jev.metrics && dense.metrics && [jev.metrics.coverage, dense.metrics.coverage].every(x => Number.isFinite(x) && x >= 0 && x <= 1), 'Invalid EC@5.');
    eligible.push({ questionId, documentId: jev.documentId, difference: jev.metrics.coverage - dense.metrics.coverage, jev, dense });
  }
  const positive = eligible.filter(p => p.difference > 0).sort((a, b) => b.difference - a.difference || lex(a.questionId, b.questionId))[0] ?? null;
  const negative = eligible.filter(p => p.difference < 0).sort((a, b) => a.difference - b.difference || lex(a.questionId, b.questionId))[0] ?? null;
  return { eligible, selections: [
    { label: 'largest_positive_coverage_difference', pair: positive },
    { label: 'largest_negative_coverage_difference', pair: negative },
  ] };
}

/** Verify every assigned primary row; later timing/control runs may be missing. */
export function validateBaseRuns(manifest: ExperimentManifest, report: Report) {
  const scheduled = new Map(manifest.schedule.map(row => [row.id, row]));
  check(scheduled.size === manifest.schedule.length, 'Duplicate scheduled IDs.');
  const byId = new Map<string, ScoredRun>();
  for (const run of report.perQuery) {
    const original = scheduled.get(run.id);
    check(original && !byId.has(run.id), 'Duplicate or unscheduled report row.');
    for (const key of ['questionId', 'documentId', 'corpus', 'method', 'round', 'timingSample', 'generate'] as const) {
      check(run[key] === original[key], `Report row differs from schedule: ${key}`);
    }
    byId.set(run.id, run);
  }
  check(manifest.schedule.filter(row => !byId.has(row.id)).length === report.missingScheduledRuns, 'Missing scheduled count differs.');
  const base = manifest.schedule.filter(row => row.round === 0 && METHOD_IDS.includes(row.method as typeof METHOD_IDS[number]));
  check(base.length > 0, 'No primary retrieval rows.');
  for (const row of base) check(['completed', 'failed'].includes(byId.get(row.id)?.status ?? ''), 'Primary base retrieval is incomplete.');
  return { scheduled: base.length, completed: base.filter(row => byId.get(row.id)!.status === 'completed').length,
    failed: base.filter(row => byId.get(row.id)!.status === 'failed').length, missing: 0 };
}

function coverage(document: PreparedDocument, question: FrozenQuestion, run: QueryRun) {
  const tokens = new CanonicalTokens(document.text), chunks = new Map(document.chunks.map(c => [c.id, c]));
  check(run.ranking.length <= 5 && new Set(run.ranking.map(r => r.chunkId)).size === run.ranking.length, 'Invalid top-five ranking.');
  const retrieved = run.ranking.map(row => { const chunk = chunks.get(row.chunkId); check(chunk, 'Unknown ranked passage.'); return tokens.span(chunk); });
  return Math.max(...question.evidenceSets.map(set => mean(set.map(span => {
    const unit = tokens.span(span); return intersectionSize([unit], retrieved) / (unit.end - unit.start);
  }))));
}

function safeQuestion(question: FrozenQuestion) {
  const annotation = question.annotation?.mode === 'model_generated' ? question.annotation : question.annotation ?
    { mode: question.annotation.mode, reviewedAt: question.annotation.reviewedAt, humanOrigin: true, accountIdentifiersOmitted: true } : null;
  return { id: question.id, documentId: question.documentId, question: question.question, questionType: question.questionType,
    answer: question.answer, unanswerable: question.unanswerable ?? false, evidenceSets: question.evidenceSets,
    annotation, frozenQuestionSha256: hashObject(question) };
}

export async function buildCase(pair: Pair, bundle: DatasetBundle, config: ExperimentManifest['config'], auditedRetention: Retention) {
  const question = bundle.freeze.questions.find(q => q.id === pair.questionId)!, original = bundle.freeze.documents.find(d => d.id === pair.documentId)!;
  check(question && original, 'Selected question/document absent from frozen bundle.');
  const document = await prepareDocument(original, config.chunkTokens, config.overlapTokens, config.maxDocumentTokens);
  const retention = semanticRetention(pair.jev, document, question);
  check(retention && hashObject(retention) === hashObject(auditedRetention), 'Reconstructed semantic phases differ from audited readout.');
  const rankings = [pair.jev, pair.dense].map(run => {
    const measured = coverage(document, question, run);
    check(Math.abs(measured - run.metrics!.coverage) <= 1e-12, 'Reconstructed EC@5 differs from report.');
    return { method: run.method, runId: run.id, status: run.status, round: run.round,
      coverage: measured, returnedRankingSha256: hashObject(run.ranking), traceSha256: hashObject(run.traces),
      payloadHashes: [...new Set(run.traces.map(trace => trace.payloadHash))],
      traces: run.traces,
      passages: run.ranking.map((ranked, index) => {
        const chunk = document.chunks.find(c => c.id === ranked.chunkId)!;
        check(document.text.slice(chunk.start, chunk.end) === chunk.text, 'Passage text is not the full canonical interval.');
        return { rank: index + 1, ...ranked, text: chunk.text, textSha256: sha256(chunk.text), start: chunk.start, end: chunk.end,
          references: chunk.references, path: chunk.path };
      }) };
  });
  check(Math.abs(rankings[0].coverage - rankings[1].coverage - pair.difference) <= 1e-12, 'Selected difference changed.');
  return { question: safeQuestion(question), document: { id: original.id, title: original.title, version: original.version,
    hash: original.hash, sourceUrl: original.sourceUrl, attribution: original.attribution },
    source: bundle.sources.find(source => source.documentId === original.id), freezeHash: bundle.freeze.hash,
    differenceJevMinusDense: pair.difference, semanticRetention: retention, rankings,
    interpretation: 'Extreme reference-coverage contrast. Full retrieved passages are supplied for inspection; this export makes no claim about answer correctness or representative error prevalence. Frozen references are unchanged.' };
}

export async function qualitativeCases(directory: string, readoutPath: string, outputPath: string) {
  const dir = resolve(directory), output = resolve(outputPath);
  check(!existsSync(output) && !lstatExists(output), 'Output must be new; existing files are never replaced.');
  check(existsSync(dirname(output)), 'Output parent must already exist.');
  // The stage marker is the only experiment file read before primary-completeness authorization.
  const stageBytes = readFileSync(join(dir, 'snapshot-stage.json'));
  const stage = JSON.parse(stageBytes.toString());
  check(stage.schemaVersion === 1 && stage.kind === 'halted-study-snapshot' &&
    stage.stage === 'halted-http402-primary-quality-complete' && stage.retrievalQualityComplete === true &&
    stage.timingComplete === false && stage.ragasEligible === false && stage.primaryBase?.remaining === 0 &&
    stage.primaryBase?.interrupted === 0,
    'Snapshot does not authorize completed primary retrieval analysis.');
  check(stage.snapshotScriptSha256 === sha256(readFileSync(new URL('./snapshot-halted-report.ts', import.meta.url))) &&
    stage.qualityHelperSha256 === sha256(readFileSync(new URL('./study-readout.ts', import.meta.url))), 'Snapshot producer/helper hash differs.');
  const bytes = Object.fromEntries(['manifest.json', 'datasets.json', 'source-snapshot.json', 'report.json'].map(name => [name, readFileSync(join(dir, name))]));
  check(stage.reportSha256 === sha256(bytes['report.json']), 'Snapshot report hash mismatch.');
  for (const name of ['manifest.json', 'datasets.json', 'source-snapshot.json']) check(stage.source?.hashes?.[name] === sha256(bytes[name]), `Snapshot metadata hash mismatch: ${name}`);
  const manifest = JSON.parse(bytes['manifest.json'].toString()) as ExperimentManifest;
  const report = JSON.parse(bytes['report.json'].toString()) as Report;
  const bundles = JSON.parse(bytes['datasets.json'].toString()) as DatasetBundle[];
  const snapshot = JSON.parse(bytes['source-snapshot.json'].toString()) as { hash: string; files: Record<string, string> };
  check(manifest.kind === 'measured' && report.kind === 'measured', 'Only audited measured snapshots are eligible.');
  check(manifest.id === stage.experimentId && manifest.id === report.experimentId && manifest.datasetHash === stage.datasetHash &&
    report.datasetHash === manifest.datasetHash && report.implementationHash === manifest.implementationHash &&
    snapshot.hash === manifest.implementationHash && hashObject(snapshot.files) === snapshot.hash &&
    manifest.configHash === hashObject(manifest.config) && report.configHash === manifest.configHash, 'Snapshot identities differ.');
  check(hashObject([...manifest.config.methods].sort()) === hashObject([...METHOD_IDS].sort()), 'All seven frozen retrieval methods are required.');
  const combined = combineBundles(bundles);
  check(combined.datasetHash === manifest.datasetHash, 'Frozen dataset differs from manifest.');
  const base = validateBaseRuns(manifest, report), readoutBytes = readFileSync(readoutPath), readout = JSON.parse(readoutBytes.toString()) as Readout;
  check(stage.primaryBase.scheduled === base.scheduled && stage.primaryBase.recorded === base.scheduled &&
    stage.primaryBase.completed === base.completed && stage.primaryBase.failed === base.failed &&
    stage.allScheduled?.scheduled === manifest.schedule.length && stage.allScheduled?.recorded === report.perQuery.length &&
    stage.allScheduled?.remaining === report.missingScheduledRuns, 'Snapshot primary/run counts differ.');
  check(readout.kind === 'measured-study-readout' && readout.experimentId === manifest.id && readout.phase === manifest.phase &&
    readout.hashes.report === sha256(bytes['report.json']) && readout.hashes.datasets === sha256(bytes['datasets.json']) &&
    readout.hashes.manifest === sha256(bytes['manifest.json']) && readout.hashes.ledgerSnapshot === stage.ledgerSnapshot?.sha256 &&
    readout.protocol.datasetHash === manifest.datasetHash && readout.protocol.implementationHash === manifest.implementationHash &&
    readout.counts.scheduled === manifest.schedule.length && readout.counts.recorded === report.perQuery.length &&
    readout.counts.missing === report.missingScheduledRuns, 'Readout does not audit these snapshot inputs.');
  const qualityBytes = readFileSync(join(dir, 'primary-quality.json')), quality = JSON.parse(qualityBytes.toString());
  check(stage.primaryQualityFileSha256 === sha256(qualityBytes) && stage.primaryQualitySha256 === hashObject(quality) &&
    quality.kind === 'halted-study-primary-quality' && quality.experimentId === manifest.id &&
    quality.datasetHash === manifest.datasetHash && quality.implementationHash === manifest.implementationHash,
    'Primary quality artifact hash or identity differs.');
  const baseRows = report.perQuery.filter(run => run.round === 0 && METHOD_IDS.includes(run.method as typeof METHOD_IDS[number]))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, questionId, documentId, corpus, method, round, status, ranking, metrics }) =>
      ({ id, questionId, documentId, corpus, method, round, status, ranking, metrics }));
  check(hashObject(quality.perQueryBase) === hashObject(baseRows), 'Primary quality rows differ from report.');
  const ruleBytes = readFileSync(RULE_PATH);
  check(sha256(ruleBytes) === RULE_SHA256, 'Predeclared selection rule changed.');
  const rule = JSON.parse(ruleBytes.toString()), selected = selectContrasts(report.perQuery, combined.questions);
  const retention = new Map(readout.retentionPerQuery.map(row => [row.runId, row]));
  check(retention.size === readout.retentionPerQuery.length, 'Duplicate retention audit row.');
  const orderedRetention = (rows: Retention[]) => [...rows].sort((a, b) => lex(a.runId, b.runId));
  check(hashObject(orderedRetention(quality.semanticRetentionPerQuery)) === hashObject(orderedRetention(readout.retentionPerQuery)),
    'Semantic retention differs between the two audited artifacts.');
  for (const pair of selected.eligible) {
    const audited = retention.get(pair.jev.id);
    check(audited && audited.questionId === pair.questionId && audited.documentId === pair.documentId &&
      Math.abs(audited.phases.find(p => p.phase === 'final-five')!.coverage - pair.jev.metrics!.coverage) <= 1e-12,
      'Eligible Jev result lacks matching semantic audit.');
  }
  const cases = [];
  for (const selection of selected.selections) {
    cases.push({ label: selection.label, result: selection.pair ? await buildCase(selection.pair,
      bundles.find(bundle => bundle.freeze.questions.some(q => q.id === selection.pair!.questionId))!, manifest.config,
      retention.get(selection.pair.jev.id)!) : null });
  }
  const result = { schemaVersion: 1, kind: 'predeclared-extreme-qualitative-contrasts', experimentId: manifest.id, phase: manifest.phase,
    primaryBaseRuns: base, timingComplete: stage.timingComplete, ragasEligible: false, eligiblePairs: selected.eligible.length,
    rule, hashes: { rule: RULE_SHA256, snapshotStage: sha256(stageBytes), report: sha256(bytes['report.json']),
      datasets: sha256(bytes['datasets.json']), manifest: sha256(bytes['manifest.json']), readout: sha256(readoutBytes),
      implementation: manifest.implementationHash, sourceSnapshot: sha256(bytes['source-snapshot.json']),
      primaryQualityFile: sha256(qualityBytes), primaryQuality: stage.primaryQualitySha256,
      ledgerSnapshot: stage.ledgerSnapshot.sha256, script: sha256(readFileSync(new URL(import.meta.url))),
      semanticRetentionHelper: sha256(readFileSync(new URL('./study-readout.ts', import.meta.url))) },
    eligibleDifferences: selected.eligible.map(pair => ({ questionId: pair.questionId, difference: pair.difference })).sort((a, b) => lex(a.questionId, b.questionId)),
    cases };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output, eligiblePairs: selected.eligible.length, selectedQuestionIds: cases.map(row => row.result?.question.id ?? null), sha256: sha256(readFileSync(output)) };
}

function lstatExists(path: string) { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, readout, output, extra] = process.argv.slice(2);
  if (!directory || !readout || !output || extra) throw new Error('Usage: tsx qualitative-cases.ts SNAPSHOT_DIR READOUT_JSON NEW_OUTPUT_JSON');
  console.log(await qualitativeCases(directory, readout, output));
}
