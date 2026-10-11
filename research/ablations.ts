import type { DatasetBundle, ResearchConfig } from './types.js';
import { makeFreeze, validateFreeze } from './datasets.js';
import { hashObject, shuffled } from './util.js';

export interface AblationVariant {
  id: string;
  factor: 'baseline' | 'window' | 'retention' | 'order' | 'structure';
  referenceId: string | null;
  config: ResearchConfig;
}
export interface AblationPlan {
  schemaVersion: 1;
  kind: 'ablation-plan';
  seed: number;
  sourceDatasetHashes: string[];
  subsetHash: string;
  subsetQuestionIds: string[];
  subsetCounts: { qasper: 40; books: 40 };
  bundles: DatasetBundle[];
  variants: AblationVariant[];
}

/** Freeze a paired, answerable-only subset before any ablation outputs are inspected.
 * This creates a plan only. Execution retains the shared study ledger and paid-call gate.
 */
export function planAblations(bundles: DatasetBundle[], base: ResearchConfig): AblationPlan {
  if (!Number.isSafeInteger(base.seed) || base.seed < 0) throw new Error('Ablation seed must be a nonnegative integer.');
  if (!bundles.length) throw new Error('Ablations require frozen test datasets.');
  const questionIds = new Set<string>(), documentIds = new Set<string>();
  const pools: Record<'qasper' | 'books', string[]> = { qasper: [], books: [] };
  for (const bundle of bundles) {
    validateFreeze(bundle.freeze);
    const sources = new Map(bundle.sources.map(source => [source.documentId, source]));
    if (sources.size !== bundle.sources.length) throw new Error('Duplicate source records.');
    for (const document of bundle.freeze.documents) {
      if (documentIds.has(document.id)) throw new Error('Duplicate document across ablation inputs.');
      documentIds.add(document.id);
      const source = sources.get(document.id);
      if (!source || source.textSha256 !== document.hash || source.split !== 'test' || !source.license) throw new Error('Ablations require verified, licensed test sources; development inputs are excluded.');
      if (!['qasper-test', 'openstax-books'].includes(source.corpus)) throw new Error('Ablation corpora must be qasper-test and openstax-books.');
    }
    for (const question of bundle.freeze.questions) {
      if (questionIds.has(question.id)) throw new Error('Duplicate question across ablation inputs.');
      questionIds.add(question.id);
      if (question.unanswerable) continue;
      const source = sources.get(question.documentId)!;
      pools[source.corpus === 'qasper-test' ? 'qasper' : 'books'].push(question.id);
    }
  }
  if (pools.qasper.length < 40 || pools.books.length < 40) throw new Error('Ablations require at least 40 answerable QASPER and 40 answerable book questions; criteria are not relaxed.');
  // Sort before shuffling, so input file and question ordering cannot change selection.
  const selectedIds = [
    ...shuffled(pools.qasper.sort(), base.seed).slice(0, 40),
    ...shuffled(pools.books.sort(), base.seed + 1).slice(0, 40),
  ].sort();
  const selected = new Set(selectedIds);
  const sourceDatasetHashes = bundles.map(bundle => bundle.freeze.hash).sort();
  const subsetHash = hashObject({ seed: base.seed, sourceDatasetHashes, questionIds: selectedIds });
  const subsetBundles = bundles.flatMap(bundle => {
    const questions = bundle.freeze.questions.filter(question => selected.has(question.id)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (!questions.length) return [];
    const usedDocuments = new Set(questions.map(question => question.documentId));
    const documents = bundle.freeze.documents.filter(document => usedDocuments.has(document.id)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const freeze = makeFreeze(bundle.freeze.projectId, documents, questions, bundle.freeze.version);
    // The subset derives from this immutable parent snapshot. A wall-clock timestamp
    // here would make an identical plan impossible to resume through immutable files.
    freeze.createdAt = bundle.freeze.createdAt;
    validateFreeze(freeze);
    return [{ ...bundle, freeze, sources: bundle.sources.filter(source => usedDocuments.has(source.documentId)).sort((a, b) => a.documentId.localeCompare(b.documentId, 'en')),
      provenance: { ...bundle.provenance, ablation: { parentFreezeId: bundle.freeze.id, parentFreezeHash: bundle.freeze.hash, subsetHash, seed: base.seed, selection: '40 answerable QASPER + 40 answerable books; fixed before outputs; no model-dependent selection' } } }];
  });
  subsetBundles.sort((a, b) => a.freeze.id.localeCompare(b.freeze.id, 'en'));
  const baseline: ResearchConfig = structuredClone(base);
  baseline.methods = ['jev-scan']; baseline.jevWindowTokens = 12000; baseline.jevRetain = 10;
  baseline.structure = false; delete baseline.chunkOrderSeed;
  baseline.timing = { questions: 80, rounds: 1 };
  baseline.generation = { ...baseline.generation, questions: 0 };
  const baselineId = 'baseline-12k-retain10';
  const variants: AblationVariant[] = [{ id: baselineId, factor: 'baseline', referenceId: null, config: structuredClone(baseline) }];
  function variant(id: string, factor: AblationVariant['factor'], changes: Partial<ResearchConfig>, referenceId = baselineId): void {
    variants.push({ id, factor, referenceId, config: { ...structuredClone(baseline), ...changes } });
  }
  variant('window-8k', 'window', { jevWindowTokens: 8000 });
  variant('window-20k', 'window', { jevWindowTokens: 20000 });
  variant('retain-5', 'retention', { jevRetain: 5 });
  variant('retain-20', 'retention', { jevRetain: 20 });
  for (const seed of [42, 43, 44]) variant(`order-${seed}`, 'order', { chunkOrderSeed: seed });
  variant('structure-control', 'structure', { methods: ['jev-scan', 'openai-dense'], structure: false });
  variant('structure-inferred', 'structure', { methods: ['jev-scan', 'openai-dense'], structure: true }, 'structure-control');
  return { schemaVersion: 1, kind: 'ablation-plan', seed: base.seed, sourceDatasetHashes, subsetHash, subsetQuestionIds: selectedIds, subsetCounts: { qasper: 40, books: 40 }, bundles: subsetBundles, variants };
}
