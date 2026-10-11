import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BOOK_PLAN = [
  ['U.S. History', 'development', 'us-history'],
  ['Introduction to Anthropology', 'development', 'introduction-anthropology'],
  ['Astronomy 2e', 'test', 'astronomy-2e'],
  ['Biology 2e', 'test', 'biology-2e'],
  ['Psychology 2e', 'test', 'psychology-2e'],
  ['Principles of Economics 3e', 'test', 'principles-economics-3e'],
  ['American Government 3e', 'test', 'american-government-3e'],
  ['Introduction to Business', 'test', 'introduction-business'],
  ['Introduction to Sociology 3e', 'test', 'introduction-sociology-3e'],
  ['Introduction to Philosophy', 'test', 'introduction-philosophy'],
];
const projectNames = { development: 'Libros · desarrollo', test: 'Libros · evaluación' };
const questionPlan = [['factual', 'Factual', 4], ['explanatory', 'Explicativa', 3], ['multi_section', 'Multisección', 3]];
const markerKind = 'books-authoring-import';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const jsonHash = value => hash(JSON.stringify(stable(value)) ?? 'null');
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}.`);
  return value;
}
function text(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label}: invalid text.`);
  return value;
}
function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label}: expected lowercase SHA-256.`);
  return value;
}
function url(value, label) {
  const raw = text(value, 2000, label);
  let parsed; try { parsed = new URL(raw); } catch { throw new Error(`${label}: invalid URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label}: expected HTTP(S) without credentials.`);
  return raw;
}
function date(value, label) {
  const raw = text(value, 100, label), time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== raw) throw new Error(`${label}: expected an ISO timestamp.`);
  return raw;
}
function blocksHash(blocks) {
  return jsonHash(blocks.map(({ text, heading, page }) => ({ text, ...(heading === undefined ? {} : { heading }), ...(page === undefined ? {} : { page }) })));
}

/** Only source text and acquisition provenance are accepted; never gold or answers. */
export function validateBooksPayload(value) {
  const input = object(value, ['schemaVersion', 'assigneeId', 'expectedName', 'projects', 'documents'], 'payload');
  if (input.schemaVersion !== 1) throw new Error('Unsupported books import schema.');
  const assigneeId = text(input.assigneeId, 100, 'assigneeId'), expectedName = text(input.expectedName, 200, 'expectedName').normalize('NFC').trim();
  if (expectedName !== 'Juan Terven') throw new Error('This import requires the approved annotator Juan Terven.');
  const rawProjects = object(input.projects, ['development', 'test'], 'projects'), projects = {};
  for (const split of ['development', 'test']) {
    const project = object(rawProjects[split], ['id', 'name'], `projects.${split}`);
    const id = text(project.id, 100, `projects.${split}.id`), name = text(project.name, 200, `projects.${split}.name`);
    if (name !== projectNames[split]) throw new Error(`projects.${split}: expected the approved project name.`);
    projects[split] = { id, name };
  }
  if (projects.development.id === projects.test.id) throw new Error('Development and test require distinct projects.');
  if (!Array.isArray(input.documents) || input.documents.length !== BOOK_PLAN.length) throw new Error('Exactly ten approved books are required.');
  const titles = new Set(), sourceIds = new Set(), textHashes = new Set(), rawHashes = new Set(), urls = new Set();
  let totalCharacters = 0;
  const documents = input.documents.map((raw, index) => {
    const label = `documents[${index}]`, doc = object(raw, ['title', 'sourceUrl', 'attribution', 'blocks', 'source'], label);
    const title = text(doc.title, 2000, `${label}.title`), approved = BOOK_PLAN.find(book => book[0] === title);
    if (!approved || titles.has(title)) throw new Error(`${label}: unexpected or duplicate book title.`);
    titles.add(title);
    const sourceInput = object(doc.source, ['documentId', 'corpus', 'split', 'url', 'license', 'licenseUrl', 'acquiredAt', 'rawSha256', 'textSha256', 'warnings'], `${label}.source`);
    if (sourceInput.split !== approved[1] || sourceInput.documentId !== `openstax:${approved[2]}` || sourceInput.corpus !== (approved[1] === 'development' ? 'openstax-development' : 'openstax-books')) throw new Error(`${label}: source ID, corpus or split conflicts with the approved book plan.`);
    const source = { documentId: sourceInput.documentId, corpus: sourceInput.corpus, split: sourceInput.split,
      url: url(sourceInput.url, `${label}.source.url`), license: text(sourceInput.license, 2000, `${label}.source.license`),
      licenseUrl: url(sourceInput.licenseUrl, `${label}.source.licenseUrl`), acquiredAt: date(sourceInput.acquiredAt, `${label}.source.acquiredAt`),
      rawSha256: digest(sourceInput.rawSha256, `${label}.source.rawSha256`), textSha256: digest(sourceInput.textSha256, `${label}.source.textSha256`) };
    if (sourceInput.warnings !== undefined) {
      if (!Array.isArray(sourceInput.warnings) || sourceInput.warnings.length > 1000) throw new Error(`${label}: invalid source warnings.`);
      source.warnings = sourceInput.warnings.map(warning => text(warning, 5000, `${label}.source.warning`));
    }
    const sourceUrl = url(doc.sourceUrl, `${label}.sourceUrl`);
    if (sourceUrl !== source.url) throw new Error(`${label}: sourceUrl differs from acquisition URL.`);
    const normalizedUrl = new URL(source.url); normalizedUrl.hash = '';
    if (sourceIds.has(source.documentId) || textHashes.has(source.textSha256) || rawHashes.has(source.rawSha256) || urls.has(normalizedUrl.href)) throw new Error('Duplicate source, text, raw content or URL across books/splits.');
    sourceIds.add(source.documentId); textHashes.add(source.textSha256); rawHashes.add(source.rawSha256); urls.add(normalizedUrl.href);
    const attributionInput = object(doc.attribution, ['text', 'url', 'license', 'licenseUrl', 'notice'], `${label}.attribution`);
    const attribution = { text: text(attributionInput.text, 10000, `${label}.attribution.text`), url: url(attributionInput.url, `${label}.attribution.url`), license: text(attributionInput.license, 2000, `${label}.attribution.license`), licenseUrl: url(attributionInput.licenseUrl, `${label}.attribution.licenseUrl`) };
    if (attribution.url !== source.url || attribution.license !== source.license || attribution.licenseUrl !== source.licenseUrl) throw new Error(`${label}: attribution must match source URL and license.`);
    if (attributionInput.notice !== undefined) attribution.notice = text(attributionInput.notice, 10000, `${label}.attribution.notice`);
    if (!Array.isArray(doc.blocks) || !doc.blocks.length || doc.blocks.length > 100000) throw new Error(`${label}: invalid blocks.`);
    const blocks = doc.blocks.map((value, blockIndex) => {
      const blockLabel = `${label}.blocks[${blockIndex}]`, block = object(value, ['text', 'heading', 'page'], blockLabel);
      const result = { text: text(block.text, 2_000_000, `${blockLabel}.text`) };
      if (block.heading !== undefined) result.heading = text(block.heading, 2000, `${blockLabel}.heading`);
      if (block.page !== undefined) {
        if (!Number.isSafeInteger(block.page) || block.page < 1 || block.page > 1_000_000) throw new Error(`${blockLabel}: invalid page.`);
        result.page = block.page;
      }
      return result;
    });
    const canonical = blocks.map(block => block.text).join('\n\n'); totalCharacters += canonical.length;
    if (canonical.length + 2 > 20_000_000 || totalCharacters > 100_000_000) throw new Error('Book text exceeds import limits.');
    if (hash(canonical) !== source.textSha256) throw new Error(`${label}: canonical text hash does not match source.textSha256.`);
    return { title, sourceUrl, attribution, blocks, source };
  }).sort((a, b) => BOOK_PLAN.findIndex(book => book[0] === a.title) - BOOK_PLAN.findIndex(book => book[0] === b.title));
  return { schemaVersion: 1, assigneeId, expectedName, projects, documents };
}

function checkStoredDocument(service, entry, input, assigneeId, projectId) {
  if (entry.projectId !== projectId || entry.sourceDocumentId !== input.source.documentId || jsonHash(entry.source) !== jsonHash({ ...input.source, documentId: entry.documentId })) throw new Error('Existing provenance mapping conflicts with the payload.');
  const document = service.store.get('document', entry.documentId);
  if (!document || document.info.projectId !== entry.projectId || document.info.hash !== input.source.textSha256 || document.info.title !== input.title || document.info.sourceUrl !== input.sourceUrl || blocksHash(document.blocks) !== blocksHash(input.blocks) || jsonHash(document.info.attribution) !== jsonHash(input.attribution)) throw new Error('Existing book document conflicts with the import receipt.');
  if (!Array.isArray(entry.tasks) || entry.tasks.length !== 10 || new Set(entry.tasks.map(task => task.taskId)).size !== 10) throw new Error('Invalid task mapping in import receipt.');
  const counts = { factual: 0, explanatory: 0, multi_section: 0 };
  for (const item of entry.tasks) {
    const task = service.store.get('task', item.taskId)?.task;
    if (!task || task.documentId !== entry.documentId || task.projectId !== entry.projectId || task.assigneeId !== assigneeId || task.kind !== 'author' || task.assignedQuestionType !== item.assignedQuestionType || task.title !== item.title || !Object.hasOwn(counts, item.assignedQuestionType)) throw new Error('Existing book task conflicts with the import receipt.');
    counts[item.assignedQuestionType]++;
  }
  if (counts.factual !== 4 || counts.explanatory !== 3 || counts.multi_section !== 3) throw new Error('Existing question allocation is not 4/3/3.');
}

/** Everything, including provenance and the retry marker, commits in one transaction. */
export function importBooks(service, input) {
  const payload = validateBooksPayload(input), payloadHash = jsonHash(payload);
  const markerId = jsonHash({ schemaVersion: 1, projectIds: [payload.projects.development.id, payload.projects.test.id] });
  return service.store.transaction(() => {
    const participant = service.participant(payload.assigneeId); service.coordinator(participant);
    if (participant.name.normalize('NFC').trim() !== payload.expectedName) throw new Error('Existing coordinator identity does not match expectedName.');
    for (const split of ['development', 'test']) {
      const expected = payload.projects[split], actual = service.store.get('project', expected.id);
      if (!actual || actual.name !== expected.name || actual.annotationMode !== 'single_annotator' || actual.soleAnnotatorId !== participant.id) throw new Error(`Existing ${split} project identity or annotation policy does not match.`);
    }
    const previous = service.store.get(markerKind, markerId);
    if (previous) {
      if (previous.payloadHash !== payloadHash || previous.documents.length !== 10) throw new Error('This project pair already has a different books import; refusing overwrite or duplication.');
      for (const [index, entry] of previous.documents.entries()) checkStoredDocument(service, entry, payload.documents[index], participant.id, payload.projects[payload.documents[index].source.split].id);
      return { ...previous, reused: true };
    }
    const targetProjects = new Set([payload.projects.development.id, payload.projects.test.id]);
    if (service.store.all('document').some(record => targetProjects.has(record.info.projectId)) || service.store.all('task').some(record => targetProjects.has(record.task.projectId)) || service.store.all('freeze').some(freeze => targetProjects.has(freeze.projectId))) throw new Error('Target projects already contain data without this import marker.');
    const sources = new Set(payload.documents.map(doc => doc.source.documentId)), hashes = new Set(payload.documents.map(doc => doc.source.textSha256));
    if (service.store.all('document').some(record => hashes.has(record.info.hash)) || service.store.all(markerKind).some(marker => marker.documents.some(doc => sources.has(doc.sourceDocumentId) || hashes.has(doc.source.textSha256)))) throw new Error('Book source or text is already imported elsewhere; refusing possible split leakage.');
    const documents = payload.documents.map(({ source, ...inputDocument }) => {
      const projectId = payload.projects[source.split].id;
      const document = service.createDocument({ projectId, ...inputDocument });
      if (document.hash !== source.textSha256 || jsonHash(document.attribution) !== jsonHash(inputDocument.attribution)) throw new Error('Persisted book hash or attribution differs from the source.');
      const tasks = questionPlan.flatMap(([assignedQuestionType, label, count]) => Array.from({ length: count }, (_, index) => {
        const title = `${document.title} · ${label} ${index + 1}/${count}`;
        const task = service.createTask({ projectId, documentId: document.id, assigneeId: participant.id, kind: 'author', title, assignedQuestionType });
        if (task.assignedQuestionType !== assignedQuestionType || task.title !== title) throw new Error('Backend does not support assigned authoring types/titles. Deploy the matching application first.');
        return { taskId: task.id, title, assignedQuestionType };
      }));
      return { sourceDocumentId: source.documentId, documentId: document.id, projectId, split: source.split, title: document.title, blockCount: document.blockCount, source: { ...source, documentId: document.id }, tasks };
    });
    const marker = { schemaVersion: 1, purpose: 'openstax-single-annotator-authoring', markerId, payloadHash, assigneeId: participant.id, assigneeName: participant.name, projects: payload.projects, createdAt: new Date().toISOString(), documents,
      sourcesBySplit: { development: documents.filter(doc => doc.split === 'development').map(doc => doc.source), test: documents.filter(doc => doc.split === 'test').map(doc => doc.source) }, tasksCreated: 100, humanAnnotationsCreated: 0 };
    service.store.insert(markerKind, markerId, marker);
    return { ...marker, reused: false };
  });
}

// Run in the application's WORKDIR, with the exact matching compiled backend.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw new Error('Usage: node import-books.mjs /path/books-payload.json');
  if ((await stat(filename)).size > 256 * 1024 * 1024) throw new Error('Books payload exceeds 256 MiB.');
  const input = JSON.parse(await readFile(filename, 'utf8'));
  const compiled = name => import(pathToFileURL(path.resolve('annotation/dist/runtime/server', `${name}.js`)).href);
  const [{ loadConfig }, { AnnotationStore }, { AnnotationService }] = await Promise.all([compiled('config'), compiled('store'), compiled('service')]);
  const config = loadConfig(), store = new AnnotationStore(config.dataDir);
  try { console.log(JSON.stringify(importBooks(new AnnotationService(store, config), input), null, 2)); }
  finally { store.close(); }
}
