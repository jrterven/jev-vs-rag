import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Operator setup only: configure projects, never author or confirm human annotations. */
export function configureSingleAnnotator(service, input) {
  const fields = ['schemaVersion', 'participantId', 'expectedName', 'practiceProjectId', 'expectedPracticeName', 'bookProjectNames'];
  if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Invalid setup payload.');
  for (const key of fields.slice(1, -1)) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200) throw new Error(`Invalid ${key}.`);
  if (!Array.isArray(input.bookProjectNames) || input.bookProjectNames.length !== 2 || new Set(input.bookProjectNames).size !== 2 || input.bookProjectNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 200)) throw new Error('Two distinct book project names are required.');
  const participant = service.participant(input.participantId); service.coordinator(participant);
  if (participant.name !== input.expectedName) throw new Error('Coordinator identity does not match expectedName.');
  const practice = service.store.get('project', input.practiceProjectId);
  if (!practice || practice.name !== input.expectedPracticeName) throw new Error('Practice project identity does not match.');
  const policy = { annotationMode: 'single_annotator', soleAnnotatorId: participant.id };
  const matching = input.bookProjectNames.map(name => service.store.all('project').filter(project => project.name === name));
  for (const matches of matching) if (matches.length > 1 || matches.some(project => project.annotationMode !== policy.annotationMode || project.soleAnnotatorId !== policy.soleAnnotatorId || project.id === practice.id)) throw new Error('Existing book project conflicts with this setup.');
  const markerId = createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.map(key => [key, input[key]])))).digest('hex');
  const previous = service.store.get('single-annotator-setup', markerId);
  if (previous) {
    for (const projectId of [previous.practiceProjectId, ...previous.bookProjectIds]) {
      const project = service.store.get('project', projectId);
      if (project?.annotationMode !== policy.annotationMode || project.soleAnnotatorId !== participant.id) throw new Error('Previous setup no longer matches the project policy.');
    }
    return { ...previous, reused: true };
  }
  // updateProject owns its transaction and rejects any reclassification of submitted work.
  // A later failure is resumable: this same policy update is an idempotent no-op.
  service.updateProject(practice.id, policy);
  return service.store.transaction(() => {
    const books = input.bookProjectNames.map((name, index) => matching[index][0] ?? service.createProject({ name, ...policy }));
    const receipt = { schemaVersion: 1, createdAt: new Date().toISOString(), participantId: participant.id, practiceProjectId: practice.id, bookProjectIds: books.map(project => project.id), bookProjectNames: books.map(project => project.name), annotationMode: policy.annotationMode, annotationsCreated: 0 };
    service.store.insert('single-annotator-setup', markerId, receipt);
    return { ...receipt, reused: false };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw new Error('Usage: node configure-single-annotator.mjs setup.json');
  const compiled = name => import(pathToFileURL(path.resolve('annotation/dist/runtime/server', `${name}.js`)).href);
  const [{ loadConfig }, { AnnotationStore }, { AnnotationService }] = await Promise.all([compiled('config'), compiled('store'), compiled('service')]);
  const config = loadConfig(), store = new AnnotationStore(config.dataDir);
  try { console.log(JSON.stringify(configureSingleAnnotator(new AnnotationService(store, config), JSON.parse(await readFile(filename, 'utf8'))), null, 2)); }
  finally { store.close(); }
}
