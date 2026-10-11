import { backup } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync, copyFileSync, constants, chmodSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { AnnotationStore } from './store.js';
import { AnnotationService } from './service.js';
import type { Participant } from '../shared/types.js';

const config = loadConfig(), [command, argument] = process.argv.slice(2);
if (command === 'restore') {
  if (!argument || !existsSync(argument)) throw new Error('Usage: restore path.sqlite');
  const filename = path.join(config.dataDir, 'annotation.sqlite');
  if (existsSync(filename)) throw new Error('Restore requires a new empty data directory. Stop the service before restoring.');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  copyFileSync(path.resolve(argument), filename, constants.COPYFILE_EXCL); chmodSync(filename, 0o600);
  const restored = new AnnotationStore(config.dataDir);
  try {
    const check = restored.db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error('Restored database failed integrity_check.');
    // Restoring a snapshot must not revive previously revoked sessions or invitation tokens.
    restored.db.prepare("DELETE FROM records WHERE kind IN ('invite','session')").run();
  } finally { restored.close(); }
  console.log('Restored. All sessions and invitations invalidated. Run invite with a coordinator ID to regain access.');
} else {
  const store = new AnnotationStore(config.dataDir), service = new AnnotationService(store, config);
  try {
    if (command === 'bootstrap') {
      if (store.all<Participant>('participant').some(participant => participant.role === 'coordinator' && participant.active)) throw new Error('A coordinator already exists. Use invite <participant-id> to issue another invitation.');
      const participant = service.createParticipant({ name: argument ?? 'Coordinación', role: 'coordinator', canAdjudicate: true });
      console.log(JSON.stringify({ participant, inviteUrl: service.invite(participant.id) }, null, 2));
    } else if (command === 'participants') {
      console.log(JSON.stringify(store.all<Participant>('participant'), null, 2));
    } else if (command === 'invite') {
      if (!argument) throw new Error('Usage: invite participant-id');
      console.log(JSON.stringify({ inviteUrl: service.invite(argument) }, null, 2));
    } else if (command === 'seed-demo') {
      if (store.all('project').length || store.all('participant').length) throw new Error('Demo seed requires an empty data directory.');
      const project = service.createProject({ name: 'Piloto' });
      const document = service.createDocument({ projectId: project.id, title: 'Documento de prueba', blocks: [
        { heading: 'Contexto', text: 'Un sistema de recuperación selecciona evidencia del documento. El texto conserva caracteres como café y 🔬.', page: 1 },
        { heading: 'Evaluación', text: 'La calidad se evalúa con preguntas y evidencia. Dos personas revisan cada respuesta de forma independiente.', page: 2 },
        { text: 'Los costos incluyen preparación y consultas. Los resultados se congelan antes de comparar métodos.', page: 2 },
      ] });
      const invitations = [];
      for (const [name, role, canAdjudicate] of [['Coordinación', 'coordinator', true], ['Autoría', 'collaborator', false], ['Revisión', 'collaborator', false], ['Adjudicación', 'collaborator', true]] as const) {
        const participant = service.createParticipant({ name, role, canAdjudicate });
        invitations.push({ participant, inviteUrl: service.invite(participant.id) });
        if (name === 'Autoría') service.createTask({ projectId: project.id, documentId: document.id, assigneeId: participant.id, kind: 'author' });
      }
      console.log(JSON.stringify({ project, document, invitations }, null, 2));
    } else if (command === 'import') {
      if (!argument) throw new Error('Usage: import path.json (document payload or {freezeId,answers,reviewerIds})');
      const data = JSON.parse(readFileSync(argument, 'utf8'));
      console.log(JSON.stringify(data.dataset ? service.importDataset(data) : data.freeze || (data.schemaVersion === 1 && data.questions) ? service.importDataset({ dataset: data }) : data.answers ? service.importResults(data) : service.createDocument(data), null, 2));
    } else if (command === 'backup') {
      if (!argument || existsSync(argument)) throw new Error('Usage: backup new-path.sqlite');
      const destination = path.resolve(argument);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      await backup(store.db, destination); chmodSync(destination, 0o600);
      console.log(`Backup created: ${destination}`);
    } else throw new Error('Commands: bootstrap [name], participants, invite participant-id, seed-demo, import path.json, backup new-path.sqlite, restore path.sqlite');
  } finally { store.close(); }
}
