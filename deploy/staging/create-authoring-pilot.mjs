import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const markerKind = 'authoring-pilot-import';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}.`);
  return value;
}
function text(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label}: invalid text.`);
  return value;
}
function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label}: expected a lowercase SHA-256.`);
  return value;
}
function sourceUrl(value, label) {
  const result = text(value, 2000, label);
  let url; try { url = new URL(result); } catch { throw new Error(`${label}: invalid URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label}: expected an HTTP(S) URL without credentials.`);
  return result;
}

/** A strict allowlist prevents accidental import of existing questions/answers. */
export function validatePilotPayload(input) {
  const raw = record(input, ['schemaVersion', 'projectName', 'assigneeId', 'expectedName', 'parentDatasetHash', 'documents'], 'payload');
  if (raw.schemaVersion !== 1) throw new Error('Unsupported pilot payload schema.');
  const projectName = text(raw.projectName, 200, 'projectName');
  if (!/^Piloto(?:\s|[·:-])/i.test(projectName) || !/desarrollo/i.test(projectName)) throw new Error('Project must be explicitly labeled Piloto and desarrollo.');
  const assigneeId = text(raw.assigneeId, 100, 'assigneeId');
  const expectedName = text(raw.expectedName, 200, 'expectedName').normalize('NFC').trim();
  const parentDatasetHash = digest(raw.parentDatasetHash, 'parentDatasetHash');
  if (!Array.isArray(raw.documents) || !raw.documents.length || raw.documents.length > 20) throw new Error('Pilot requires 1–20 documents.');
  const ids = new Set(), hashes = new Set();
  const documents = raw.documents.map((value, index) => {
    const label = `documents[${index}]`;
    const doc = record(value, ['source', 'title', 'sourceUrl', 'blocks'], label);
    const title = text(doc.title, 2000, `${label}.title`);
    if (!/^Piloto(?:\s|[·:-])/i.test(title)) throw new Error(`${label}: title must be labeled Piloto.`);
    const rawSource = record(doc.source, ['documentId', 'corpus', 'split', 'url', 'license', 'licenseUrl', 'acquiredAt', 'rawSha256', 'textSha256', 'warnings'], `${label}.source`);
    if (rawSource.split !== 'development') throw new Error(`${label}: only development sources may be imported.`);
    const source = {
      documentId: text(rawSource.documentId, 200, `${label}.source.documentId`),
      corpus: text(rawSource.corpus, 200, `${label}.source.corpus`), split: 'development',
      url: sourceUrl(rawSource.url, `${label}.source.url`),
      license: text(rawSource.license, 2000, `${label}.source.license`),
      licenseUrl: sourceUrl(rawSource.licenseUrl, `${label}.source.licenseUrl`),
      acquiredAt: text(rawSource.acquiredAt, 100, `${label}.source.acquiredAt`),
      rawSha256: digest(rawSource.rawSha256, `${label}.source.rawSha256`),
      textSha256: digest(rawSource.textSha256, `${label}.source.textSha256`),
    };
    if (!Number.isFinite(Date.parse(source.acquiredAt))) throw new Error(`${label}: invalid acquisition date.`);
    if (rawSource.warnings !== undefined) {
      if (!Array.isArray(rawSource.warnings) || rawSource.warnings.length > 1000) throw new Error(`${label}: invalid source warnings.`);
      source.warnings = rawSource.warnings.map(item => text(item, 5000, `${label}.source.warning`));
    }
    if (ids.has(source.documentId) || hashes.has(source.textSha256)) throw new Error('Duplicate source document or text in pilot.');
    ids.add(source.documentId); hashes.add(source.textSha256);
    const url = sourceUrl(doc.sourceUrl, `${label}.sourceUrl`);
    if (url !== source.url) throw new Error(`${label}: document URL must match its source.`);
    if (!Array.isArray(doc.blocks) || !doc.blocks.length || doc.blocks.length > 100000) throw new Error(`${label}: invalid blocks.`);
    const blocks = doc.blocks.map((item, blockIndex) => {
      const blockLabel = `${label}.blocks[${blockIndex}]`;
      const block = record(item, ['text', 'heading', 'page'], blockLabel);
      const result = { text: text(block.text, 2_000_000, `${blockLabel}.text`) };
      if (block.heading !== undefined) result.heading = text(block.heading, 2000, `${blockLabel}.heading`);
      if (block.page !== undefined) {
        if (!Number.isSafeInteger(block.page) || block.page < 1 || block.page > 1_000_000) throw new Error(`${blockLabel}: invalid page.`);
        result.page = block.page;
      }
      return result;
    });
    const canonical = blocks.map(block => block.text).join('\n\n');
    if (canonical.length + 2 > 20_000_000) throw new Error(`${label}: document exceeds annotation limit.`);
    if (hash(canonical) !== source.textSha256) throw new Error(`${label}: canonical text hash does not match source.textSha256.`);
    return { title, sourceUrl: url, blocks, source };
  });
  return { schemaVersion: 1, projectName, assigneeId, expectedName, parentDatasetHash, documents };
}

/** Synchronous service operations share one SQLite transaction, including marker. */
export function createAuthoringPilot(service, input) {
  const payload = validatePilotPayload(input);
  const payloadHash = hash(JSON.stringify(stable(payload)));
  return service.store.transaction(() => {
    const participant = service.participant(payload.assigneeId);
    service.coordinator(participant);
    if (participant.name.normalize('NFC').trim() !== payload.expectedName) throw new Error('Existing coordinator does not match expectedName.');
    const previous = service.store.get(markerKind, payloadHash);
    if (previous) {
      if (previous.payloadHash !== payloadHash || !service.store.get('project', previous.projectId)) throw new Error('Existing pilot marker is inconsistent.');
      for (const item of previous.documents) {
        const document = service.store.get('document', item.documentId);
        const task = service.store.get('task', item.taskId)?.task;
        if (document?.info.hash !== item.source.textSha256 || task?.documentId !== item.documentId || task?.assigneeId !== payload.assigneeId || task?.kind !== 'author') throw new Error('Existing pilot records are inconsistent; refusing to duplicate them.');
      }
      return { ...previous, reused: true };
    }
    const project = service.createProject({ name: payload.projectName });
    const documents = payload.documents.map(({ source, ...inputDocument }) => {
      const document = service.createDocument({ projectId: project.id, ...inputDocument });
      if (document.hash !== source.textSha256) throw new Error('Persisted document hash differs from the source.');
      const task = service.createTask({ projectId: project.id, documentId: document.id, assigneeId: payload.assigneeId, kind: 'author' });
      return { documentId: document.id, title: document.title, taskId: task.id, source };
    });
    const marker = { schemaVersion: 1, purpose: 'authoring-practice-development', payloadHash, parentDatasetHash: payload.parentDatasetHash, projectId: project.id, projectName: project.name, assigneeId: participant.id, assigneeName: participant.name, createdAt: new Date().toISOString(), documents };
    service.store.insert(markerKind, payloadHash, marker);
    return { ...marker, reused: false };
  });
}

// Run from /app (container WORKDIR); import only the already compiled backend.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw new Error('Usage: node create-authoring-pilot.mjs /path/pilot-payload.json');
  if ((await stat(filename)).size > 32 * 1024 * 1024) throw new Error('Pilot payload exceeds 32 MB.');
  const payload = JSON.parse(await readFile(filename, 'utf8'));
  validatePilotPayload(payload);
  const compiled = name => import(pathToFileURL(path.resolve('annotation/dist/runtime/server', `${name}.js`)).href);
  const [{ loadConfig }, { AnnotationStore }, { AnnotationService }] = await Promise.all([compiled('config'), compiled('store'), compiled('service')]);
  const config = loadConfig(), store = new AnnotationStore(config.dataDir);
  try { console.log(JSON.stringify(createAuthoringPilot(new AnnotationService(store, config), payload), null, 2)); }
  finally { store.close(); }
}
