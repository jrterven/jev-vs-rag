import { canonicalText, makeFreeze, prepareDocument, validateFreeze } from './datasets.js';
import { METHOD_IDS, type DatasetBundle, type ResearchConfig } from './types.js';
import { hashObject, shuffled } from './util.js';

/** Development-only integration exercise. Selection never reads model outputs. */
export async function prepareDevelopmentSmoke(source: DatasetBundle, base: ResearchConfig, options: { python: string; questions?: number }) {
  validateFreeze(source.freeze);
  const count = options.questions ?? 3;
  if (!Number.isInteger(count) || count < 3 || count > 5) throw new Error('Technical smoke requires 3–5 questions.');
  if (!options.python.trim()) throw new Error('An explicit remote Python executable is required.');
  if (source.provenance.dataset !== 'QASPER' || source.provenance.mock || source.sources.length !== source.freeze.documents.length || source.sources.some(s => s.split !== 'development' || s.corpus !== 'qasper-development')) throw new Error('Technical smoke accepts only real QASPER development/train data.');
  const seen = new Set<string>();
  const questions = shuffled([...source.freeze.questions].sort((a, b) => a.id.localeCompare(b.id, 'en')), base.seed).filter(q => {
    if (seen.has(q.documentId)) return false;
    seen.add(q.documentId); return true;
  }).slice(0, count).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (questions.length !== count) throw new Error('Insufficient distinct development documents; criteria were not relaxed.');
  const ids = new Set(questions.map(q => q.documentId));
  const documents = source.freeze.documents.filter(d => ids.has(d.id)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const freeze = makeFreeze(source.freeze.projectId, documents, questions, source.freeze.version);
  freeze.createdAt = source.freeze.createdAt;
  const bundle: DatasetBundle = { schemaVersion: 1, freeze, sources: source.sources.filter(s => ids.has(s.documentId)).sort((a, b) => a.documentId.localeCompare(b.documentId, 'en')), provenance: {
    ...source.provenance, purpose: 'technical-development-smoke', parentDatasetHash: source.freeze.hash,
    selection: { seed: base.seed, questions: count, distinctDocuments: count, rule: 'Shuffle question IDs; take first question from each new document; retain complete documents.' },
    limitation: 'Pipeline compatibility exercise, not a full pilot, corpus comparison or scientific result.',
  } };
  const config = structuredClone(base);
  config.methods = [...METHOD_IDS]; config.local = { ...config.local, python: options.python, device: 'cuda', precision: 'fp32' };
  config.timing = { questions: count, rounds: 3 }; config.generation = { ...config.generation, questions: 0 };
  delete config.structure; delete config.chunkOrderSeed;
  const inventory = [];
  for (const document of documents) {
    const prepared = await prepareDocument(document, config.chunkTokens, config.overlapTokens, config.maxDocumentTokens);
    inventory.push({ documentId: document.id, title: document.title, tokens: prepared.tokenCount, chunks: prepared.chunks.length, characters: canonicalText(document).length });
  }
  return { schemaVersion: 1 as const, kind: 'technical-development-smoke-plan' as const, bundle, config,
    selection: { sourceDatasetHash: source.freeze.hash, datasetHash: freeze.hash, configHash: hashObject(config), seed: config.seed, questionIds: questions.map(q => q.id), documents: inventory,
      retrievalRuns: count * 3 * METHOD_IDS.length, generationCalls: 0, budgetLedger: 'data/research/study-budget.sqlite', paidCallsMade: false,
      limitation: 'Not representative; no publication-quality comparisons or budget forecast from this tiny smoke alone.' } };
}
