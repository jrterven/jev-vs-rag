import type { DatasetBundle, QueryRun } from './types.js';
import type { ExperimentManifest } from './runner.js';
import { shuffled } from './util.js';
import { Ledger } from './ledger.js';
import { implementationSnapshot } from './implementation.js';

export function annotationExports(manifest: ExperimentManifest, bundles: DatasetBundle[], ledger: Ledger, reviewerIds: string[]) {
  if (implementationSnapshot().hash !== manifest.implementationHash) throw new Error('Annotation export implementation differs from the frozen experiment; restore its source snapshot.');
  if (reviewerIds.length !== 2 || new Set(reviewerIds).size !== 2 || reviewerIds.some(id => !id.trim())) throw new Error('Two distinct reviewer IDs are required.');
  const questions = bundles.flatMap(b => b.freeze.questions), sources = new Map(bundles.flatMap(b => b.sources).map(s => [s.documentId, s.corpus]));
  const generatedIds = new Set(manifest.schedule.filter(r => r.generate).map(r => r.questionId));
  const eligible = questions.filter(q => generatedIds.has(q.id));
  const selected = manifest.kind === 'mock' ? eligible : [
    ...shuffled(eligible.filter(q => sources.get(q.documentId) === 'qasper-test' && !q.unanswerable), manifest.config.seed).slice(0, 30),
    ...shuffled(eligible.filter(q => sources.get(q.documentId) === 'qasper-test' && q.unanswerable), manifest.config.seed + 1).slice(0, 10),
    ...shuffled(eligible.filter(q => sources.get(q.documentId) === 'openstax-books'), manifest.config.seed + 2).slice(0, 20),
  ];
  if (manifest.kind === 'measured' && selected.length !== 60) throw new Error('Human evaluation requires 30 QASPER positive, 10 negative, 20 book questions from the generated set.');
  const arms = new Set(['jev-scan', 'openai-dense', 'hybrid-bge']), ids = new Set(selected.map(q => q.id));
  const runs = ledger.runs().filter(r => r.id.startsWith(manifest.id + ':') && r.round === 0 && ids.has(r.questionId) && arms.has(r.method));
  const answers = runs.flatMap(run => { const result = ledger.get<{ generation?: QueryRun['generation']; generationError?: string }>(`${run.id}:generation-result`); if (run.status !== 'completed' || !result?.generation) return []; return [{ questionId: run.questionId, method: run.method, runId: run.id, text: result.generation.text, citations: result.generation.citations }]; });
  if (answers.length !== selected.length * 3) throw new Error(`Human export incomplete: ${answers.length}/${selected.length * 3} successful answers. Failed/missing answers were not fabricated.`);
  return bundles.map(bundle => ({ freezeId: bundle.freeze.id, answers: answers.filter(a => bundle.freeze.questions.some(q => q.id === a.questionId)), reviewerIds })).filter(body => body.answers.length);
}
