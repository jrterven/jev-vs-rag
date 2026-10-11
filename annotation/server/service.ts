import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminOverview, AnnotationDraft, AnnotationMode, AnonymousAnswer, DocumentInfo, FrozenDataset, FrozenQuestion, Participant, Project, Task, TaskView, TextBlock } from '../shared/types.js';
import type { AnnotationConfig } from './config.js';
import { AnnotationStore } from './store.js';
import { hashDataset, sha256 } from './canonical.js';
import { validateImportedDataset } from './dataset-validation.js';
import { array, choice, fail, integer, object, string, validateAttribution, validateDraft, validateSpans } from './validation.js';

interface Secret { hash: string; participantId: string; expires: number }
interface DocumentRecord { info: DocumentInfo; blocks: TextBlock[] }
interface TaskRecord { task: Task; draft: AnnotationDraft | null; questionId?: string; answerId?: string; sortKey: string; verdict?: 'agree' | 'disagree'; verdictNote?: string; verdictAt?: string; submittedAt?: string; selfReview?: { participantId: string; reviewedAt: string; revision: number } }
interface ResultRecord { id: string; freezeId: string; questionId: string; method: string; runId: string; answer: AnonymousAnswer; reviewerIds: string[]; createdAt: string }
interface Submission { taskId: string; participantId: string; revision: number }
const id = (): string => randomUUID();
const timestamp = (): string => new Date().toISOString();

export class AnnotationService {
  constructor(readonly store: AnnotationStore, readonly config: AnnotationConfig) {}
  private must<T>(kind: string, key: string): T { return this.store.get<T>(kind, key) ?? fail(404, 'No encontrado.'); }
  participant(key: string): Participant { return this.must<Participant>('participant', key); }
  coordinator(actor: Participant): void { if (actor.role !== 'coordinator' || !actor.active) fail(403, 'Se requiere coordinación.'); }
  private active(key: string): Participant { const participant = this.participant(key); if (!participant.active) fail(400, 'Participante desactivado.'); return participant; }
  createParticipant(input: unknown): Participant {
    const body = object(input);
    const participant: Participant = { id: id(), name: string(body.name, 200).trim(), role: choice(body.role, ['coordinator', 'collaborator']), canAdjudicate: body.canAdjudicate === true, active: true };
    this.store.insert('participant', participant.id, participant);
    return participant;
  }
  invite(participantId: string): string {
    const participant = this.participant(participantId);
    participant.active = true;
    this.store.put('participant', participantId, participant);
    for (const invite of this.store.all<Secret>('invite')) if (invite.participantId === participantId) this.store.remove('invite', invite.hash);
    const token = randomBytes(32).toString('base64url'), hash = sha256(token);
    this.store.insert('invite', hash, { hash, participantId, expires: Date.now() + this.config.inviteDays * 86400000 });
    return `${this.config.origin}/#invite=${token}`;
  }
  redeem(token: unknown): { participant: Participant; session: string } {
    string(token, 200);
    return this.store.transaction(() => {
      const hash = sha256(token as string), invitation = this.store.get<Secret>('invite', hash);
      if (!invitation || invitation.expires < Date.now()) fail(401, 'Invitación inválida o vencida.');
      const participant = this.active(invitation.participantId);
      // The link keeps its original expiry. Each visit gets an independent session;
      // rotating or revoking the invitation remains the only way to remove it.
      const session = randomBytes(32).toString('base64url'), sessionHash = sha256(session);
      this.store.insert('session', sessionHash, { hash: sessionHash, participantId: participant.id, expires: Date.now() + this.config.sessionDays * 86400000 });
      return { participant, session };
    });
  }
  authenticate(token?: string): Participant | null {
    if (!token || token.length > 200) return null;
    const session = this.store.get<Secret>('session', sha256(token));
    if (!session || session.expires < Date.now()) return null;
    const participant = this.store.get<Participant>('participant', session.participantId);
    return participant?.active ? participant : null;
  }
  logout(token?: string): void { if (token) this.store.remove('session', sha256(token)); }
  revoke(participantId: string, actor: Participant): void {
    this.coordinator(actor);
    if (participantId === actor.id) fail(400, 'No puede revocar su propia sesión de coordinación.');
    const participant = this.participant(participantId);
    participant.active = false;
    this.store.transaction(() => {
      this.store.put('participant', participantId, participant);
      for (const kind of ['invite', 'session']) for (const secret of this.store.all<Secret>(kind)) if (secret.participantId === participantId) this.store.remove(kind, secret.hash);
    });
  }
  createProject(value: unknown): Project {
    const body = object(value), project: Project = { id: id(), name: string(body.name, 200).trim(), createdAt: timestamp(), ...this.projectMode(body) };
    this.store.insert('project', project.id, project); return project;
  }
  private projectMode(body: Record<string, unknown>): { annotationMode: AnnotationMode; soleAnnotatorId?: string } {
    const annotationMode = choice(body.annotationMode ?? 'independent_review', ['independent_review', 'single_annotator']);
    if (annotationMode === 'single_annotator') {
      const soleAnnotatorId = string(body.soleAnnotatorId, 100);
      this.active(soleAnnotatorId);
      return { annotationMode, soleAnnotatorId };
    }
    if (body.soleAnnotatorId !== undefined) fail(400, 'La revisión independiente no tiene anotador único.');
    return { annotationMode };
  }
  updateProject(projectId: string, value: unknown): Project {
    const body = object(value);
    if (body.annotationMode === undefined) fail(400, 'Indique el modo de anotación.');
    const mode = this.projectMode(body);
    return this.store.transaction(() => {
      const project = this.must<Project>('project', projectId);
      if ((project.annotationMode ?? 'independent_review') === mode.annotationMode && project.soleAnnotatorId === mode.soleAnnotatorId) return project;
      const tasks = this.store.all<TaskRecord>('task').filter(row => row.task.projectId === projectId);
      if (tasks.some(row => row.task.kind !== 'author' || row.submittedAt || row.selfReview || ['submitted', 'completed'].includes(row.task.status)) || this.store.all<FrozenDataset>('freeze').some(freeze => freeze.projectId === projectId)) fail(409, 'El modo no se puede cambiar después de un envío, revisión o versión congelada.');
      if (mode.annotationMode === 'single_annotator' && tasks.some(row => row.task.assigneeId !== mode.soleAnnotatorId)) fail(409, 'Todas las autorías existentes deben pertenecer al anotador único.');
      const { annotationMode: _oldMode, soleAnnotatorId: _oldAnnotator, ...base } = project;
      const updated: Project = { ...base, ...mode };
      this.store.put('project', projectId, updated); return updated;
    });
  }
  private requireAuthorAssignee(projectId: string, assigneeId: string): void {
    const project = this.must<Project>('project', projectId);
    if (project.annotationMode === 'single_annotator' && project.soleAnnotatorId !== assigneeId) fail(400, 'La autoría debe asignarse al anotador único del proyecto.');
  }
  createDocument(value: unknown): DocumentInfo {
    const body = object(value), projectId = string(body.projectId, 100);
    this.must<Project>('project', projectId);
    let offset = 0;
    const blocks: TextBlock[] = array(body.blocks, 100000).map((raw, index) => {
      const block = object(raw), text = string(block.text, 2_000_000);
      const result: TextBlock = { id: id(), index, text, start: offset, end: offset + text.length };
      offset = result.end + 2;
      if (block.heading !== undefined) result.heading = string(block.heading, 2000);
      if (block.page !== undefined) result.page = integer(block.page, 1, 1_000_000);
      return result;
    });
    if (!blocks.length || offset > 20_000_000) fail(400, 'Documento vacío o demasiado grande.');
    const info: DocumentInfo = { id: id(), projectId, title: string(body.title, 2000), hash: sha256(blocks.map(block => block.text).join('\n\n')), version: 1, blockCount: blocks.length, sections: blocks.filter(block => block.heading).map(block => ({ blockIndex: block.index, title: block.heading! })) };
    if (body.sourceUrl !== undefined && body.sourceUrl !== '') { const source = string(body.sourceUrl, 2000); let url: URL; try { url = new URL(source); } catch { fail(400, 'URL inválida.'); } if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'URL inválida.'); info.sourceUrl = source; }
    if (body.attribution !== undefined) info.attribution = validateAttribution(body.attribution);
    this.store.insert('document', info.id, { info, blocks });
    return info;
  }
  document(documentId: string, actor: Participant): DocumentRecord {
    if (actor.role !== 'coordinator' && !this.store.all<TaskRecord>('task').some(record => record.task.assigneeId === actor.id && record.task.documentId === documentId)) fail(403, 'Documento no asignado.');
    return this.must<DocumentRecord>('document', documentId);
  }
  private record(taskId: string, actor?: Participant): TaskRecord {
    const record = this.must<TaskRecord>('task', taskId);
    if (actor && actor.role !== 'coordinator' && record.task.assigneeId !== actor.id) fail(403, 'Tarea no asignada.');
    return record;
  }
  private editable(record: TaskRecord, actor: Participant): void {
    if (record.task.assigneeId !== actor.id) fail(403, 'Solo la persona asignada puede anotar.');
    if (!['assigned', 'draft'].includes(record.task.status)) fail(409, 'La anotación enviada es inmutable.');
  }
  private relatedReviews(authorId: string): TaskRecord[] { return this.store.all<TaskRecord>('task').filter(row => row.task.kind === 'review' && row.task.sourceTaskId === authorId); }
  private evaluation(record: TaskRecord): boolean { return record.task.kind === 'evaluate' || (record.task.kind === 'adjudicate' && !!record.answerId); }
  createTask(value: unknown): Task {
    const body = object(value), projectId = string(body.projectId, 100), documentId = string(body.documentId, 100), assigneeId = string(body.assigneeId, 100);
    const document = this.must<DocumentRecord>('document', documentId), assignee = this.active(assigneeId), kind = choice(body.kind, ['author', 'review', 'adjudicate'] as const);
    if (document.info.projectId !== projectId) fail(400, 'Documento de otro proyecto.');
    const task: Task = { id: id(), projectId, documentId, assigneeId, kind, status: 'assigned', revision: 0, title: document.info.title, createdAt: timestamp() };
    if (body.title !== undefined || body.assignedQuestionType !== undefined) {
      if (kind !== 'author') fail(400, 'El título y tipo de pregunta asignados solo se admiten en autorías.');
      if (body.title !== undefined) task.title = string(body.title, 2000);
      if (body.assignedQuestionType !== undefined) task.assignedQuestionType = choice(body.assignedQuestionType, ['factual', 'explanatory', 'multi_section'] as const);
    }
    const record: TaskRecord = { task, draft: null, sortKey: randomBytes(16).toString('hex') };
    if (kind === 'author') { this.requireAuthorAssignee(projectId, assigneeId); record.questionId = id(); }
    else {
      const source = this.record(string(body.sourceTaskId, 100));
      if (source.task.documentId !== documentId || source.task.projectId !== projectId) fail(400, 'La tarea de origen pertenece a otro documento.');
      if (this.must<Project>('project', projectId).annotationMode === 'single_annotator' && (kind === 'review' || source.task.kind === 'review')) fail(400, 'Este proyecto utiliza revisión propia de la autoría.');
      if (kind === 'review' && source.task.assigneeId === assigneeId) fail(400, 'No se permite la revisión propia.');
      task.sourceTaskId = source.task.id;
      const existing = this.store.all<TaskRecord>('task');
      if (kind === 'review') {
        if (source.task.kind !== 'author' || !['submitted', 'completed'].includes(source.task.status)) fail(400, 'La autoría debe estar enviada.');
        if (this.relatedReviews(source.task.id).length) fail(409, 'Esta pregunta ya tiene revisión.');
      } else {
        if (!assignee.canAdjudicate && assignee.role !== 'coordinator') fail(400, 'Participante sin permiso de adjudicación.');
        if (source.task.kind === 'review') {
          const author = this.record(source.task.sourceTaskId!);
          if (source.verdict !== 'disagree' || source.task.status !== 'completed') fail(400, 'La adjudicación requiere desacuerdo y permiso explícito.');
          if (existing.some(row => row.task.kind === 'adjudicate' && row.task.sourceTaskId === source.task.id)) fail(409, 'Ya existe una adjudicación.');
        } else if (source.task.kind === 'evaluate' && source.answerId) {
          const pair = existing.filter(row => row.task.kind === 'evaluate' && row.answerId === source.answerId);
          if (pair.length !== 2 || pair.some(row => row.task.status !== 'completed')) fail(400, 'Se requieren dos valoraciones enviadas.');
          if (existing.some(row => row.task.kind === 'adjudicate' && row.answerId === source.answerId)) fail(409, 'Ya existe una adjudicación.');
          record.answerId = source.answerId;
        } else fail(400, 'Origen de adjudicación inválido.');
      }
    }
    this.store.insert('task', task.id, record); return task;
  }
  amend(taskId: string, value: unknown): Task {
    const body = object(value), source = this.record(taskId);
    if (source.task.kind !== 'author' || !['submitted', 'completed'].includes(source.task.status)) fail(400, 'Solo se puede corregir una autoría enviada.');
    const note = string(body.note, 10000), assigneeId = body.assigneeId === undefined ? source.task.assigneeId : string(body.assigneeId, 100);
    this.active(assigneeId);
    this.requireAuthorAssignee(source.task.projectId, assigneeId);
    const versions = this.store.all<TaskRecord>('task').filter(row => row.task.kind === 'author' && row.questionId === source.questionId);
    if (versions.at(-1)?.task.id !== taskId) fail(409, 'Ya existe una revisión más reciente de esta pregunta.');
    const task: Task = { ...source.task, id: id(), sourceTaskId: taskId, assigneeId, status: 'assigned', revision: 0, createdAt: timestamp() };
    const record: TaskRecord = { task, draft: { ...source.draft!, note }, questionId: source.questionId, sortKey: randomBytes(16).toString('hex') };
    this.store.insert('task', task.id, record);
    this.store.insert('revision', `${task.id}:0`, { taskId: task.id, revision: 0, sourceTaskId: taskId, createdAt: timestamp(), draft: record.draft });
    return task;
  }
  tasks(actor: Participant): Task[] {
    const assigned = this.store.all<TaskRecord>('task').filter(record => record.task.assigneeId === actor.id).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const projects = new Map([...new Set(assigned.map(record => record.task.projectId))].map(projectId => [projectId, this.must<Project>('project', projectId).name]));
    const documents = new Map([...new Set(assigned.map(record => record.task.documentId))].map(documentId => [documentId, this.must<DocumentRecord>('document', documentId).info.title]));
    return assigned.map(({ task }) => ({ ...task, projectName: projects.get(task.projectId)!, documentTitle: documents.get(task.documentId)! }));
  }
  private frozenReference(record: TaskRecord): { result: ResultRecord; question: FrozenQuestion } {
    const result = this.must<ResultRecord>('result', record.answerId!);
    const freeze = this.must<FrozenDataset>('freeze', result.freezeId), question = freeze.questions.find(item => item.id === result.questionId)!;
    return { result, question };
  }
  view(taskId: string, actor: Participant): TaskView {
    const record = this.record(taskId, actor), document = this.must<DocumentRecord>('document', record.task.documentId);
    const view: TaskView = { task: record.task, document: document.info, draft: record.draft, annotationMode: this.must<Project>('project', record.task.projectId).annotationMode ?? 'independent_review' };
    if (record.task.kind === 'author' && record.task.assignedQuestionType) view.questionType = record.task.assignedQuestionType;
    if (record.selfReview) view.selfReview = { reviewedAt: record.selfReview.reviewedAt, revision: record.selfReview.revision };
    if (record.task.kind === 'review') {
      const original = this.record(record.task.sourceTaskId!).draft!;
      view.question = original.question; view.questionType = original.questionType;
      if (['submitted', 'completed'].includes(record.task.status)) view.comparison = { original, independent: record.draft!, ...(record.verdict ? { verdict: record.verdict, note: record.verdictNote } : {}) };
    } else if (this.evaluation(record)) {
      const { result, question } = this.frozenReference(record);
      view.question = question.question; view.questionType = question.questionType; view.reference = { answer: question.answer, evidenceSets: question.evidenceSets }; view.answer = result.answer;
      if (record.task.kind === 'adjudicate') view.adjudication = this.store.all<TaskRecord>('task').filter(row => row.task.kind === 'evaluate' && row.answerId === record.answerId).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((row, index) => ({ label: `Valoración ${index + 1}`, annotation: row.draft! }));
    } else if (record.task.kind === 'adjudicate') {
      const review = this.record(record.task.sourceTaskId!), author = this.record(review.task.sourceTaskId!);
      view.question = author.draft!.question; view.questionType = author.draft!.questionType;
      view.adjudication = [{ label: 'Anotación A', annotation: author.draft! }, { label: 'Anotación B', annotation: review.draft! }];
    }
    return view;
  }
  private validateAssignedType(record: TaskRecord, draft: AnnotationDraft): void {
    if (record.task.assignedQuestionType && draft.questionType !== record.task.assignedQuestionType) fail(400, 'El tipo de pregunta asignado es inmutable.');
  }
  saveDraft(taskId: string, actor: Participant, value: unknown): { revision: number } {
    const body = object(value);
    return this.store.transaction(() => {
      const record = this.record(taskId, actor); this.editable(record, actor);
      if (integer(body.revision) !== record.task.revision) fail(409, 'La anotación cambió. Recargue antes de guardar.');
      const blocks = this.must<DocumentRecord>('document', record.task.documentId).blocks;
      const draft = validateDraft(body.draft, blocks, false, this.evaluation(record));
      this.validateAssignedType(record, draft);
      const assigned = this.view(taskId, actor);
      const fixedQuestion = assigned.question;
      if (assigned.questionType) draft.questionType = assigned.questionType;
      if (fixedQuestion && draft.question !== fixedQuestion) fail(400, 'La pregunta asignada es inmutable.');
      record.draft = draft; record.task.revision++; record.task.status = 'draft';
      this.store.insert('revision', `${taskId}:${record.task.revision}`, { taskId, revision: record.task.revision, actorId: actor.id, createdAt: timestamp(), draft });
      this.store.put('task', taskId, record); return { revision: record.task.revision };
    });
  }
  submit(taskId: string, actor: Participant, value: unknown): TaskView {
    const body = object(value), submissionId = string(body.submissionId, 100), revision = integer(body.revision);
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(submissionId)) fail(400, 'submissionId debe ser UUID.');
    this.store.transaction(() => {
      const prior = this.store.get<Submission>('submission', submissionId);
      if (prior) { if (prior.taskId !== taskId || prior.participantId !== actor.id || prior.revision !== revision) fail(409, 'Identificador de envío ya utilizado.'); return; }
      const record = this.record(taskId, actor); this.editable(record, actor);
      if (revision !== record.task.revision) fail(409, 'Revisión desactualizada.');
      const blocks = this.must<DocumentRecord>('document', record.task.documentId).blocks;
      record.draft = validateDraft(record.draft, blocks, true, this.evaluation(record));
      this.validateAssignedType(record, record.draft);
      if (record.task.kind === 'adjudicate' && !record.draft.note?.trim()) fail(400, 'La adjudicación requiere una justificación.');
      record.task.status = ['evaluate', 'adjudicate'].includes(record.task.kind) ? 'completed' : 'submitted'; record.submittedAt = timestamp();
      this.store.put('task', taskId, record);
      this.store.insert('submission', submissionId, { taskId, participantId: actor.id, revision });
      if (record.task.kind === 'adjudicate' && !record.answerId) {
        const review = this.record(record.task.sourceTaskId!), author = this.record(review.task.sourceTaskId!);
        author.task.status = 'completed'; this.store.put('task', author.task.id, author);
      }
    });
    return this.view(taskId, actor);
  }
  verdict(taskId: string, actor: Participant, value: unknown): TaskView {
    const body = object(value), verdict = choice(body.verdict, ['agree', 'disagree']), note = string(body.note ?? '', 10000, true);
    this.store.transaction(() => {
      const record = this.record(taskId, actor);
      if (record.task.assigneeId !== actor.id || record.task.kind !== 'review') fail(403, 'Solo la persona revisora puede decidir.');
      if (record.verdict) { if (record.verdict !== verdict || record.verdictNote !== note) fail(409, 'El dictamen es inmutable.'); return; }
      if (record.task.status !== 'submitted') fail(409, 'Envíe primero su respuesta independiente.');
      if (verdict === 'disagree' && !note.trim()) fail(400, 'Describa el desacuerdo.');
      record.verdict = verdict; record.verdictNote = note; record.verdictAt = timestamp(); record.task.status = 'completed'; this.store.put('task', taskId, record);
      if (verdict === 'agree') { const author = this.record(record.task.sourceTaskId!); author.task.status = 'completed'; this.store.put('task', author.task.id, author); }
    });
    return this.view(taskId, actor);
  }
  selfReview(taskId: string, actor: Participant, value: unknown): TaskView {
    const body = object(value), revision = integer(body.revision);
    if (body.confirmed !== true) fail(400, 'Confirme la revisión de la pregunta, respuesta y evidencia.');
    this.store.transaction(() => {
      const record = this.record(taskId, actor), project = this.must<Project>('project', record.task.projectId);
      if (!actor.active || record.task.kind !== 'author' || record.task.assigneeId !== actor.id || project.annotationMode !== 'single_annotator' || project.soleAnnotatorId !== actor.id) fail(403, 'Solo el anotador único asignado puede revisar su autoría.');
      if (revision !== record.task.revision) fail(409, 'Revisión desactualizada.');
      if (record.selfReview) {
        if (record.selfReview.revision !== revision || record.selfReview.participantId !== actor.id || record.task.status !== 'completed') fail(409, 'La revisión propia no coincide con la anotación.');
        return;
      }
      if (record.task.status !== 'submitted') fail(409, 'Envíe primero la autoría.');
      this.validateAssignedType(record, validateDraft(record.draft, this.must<DocumentRecord>('document', record.task.documentId).blocks, true, false));
      record.selfReview = { participantId: actor.id, reviewedAt: timestamp(), revision };
      record.task.status = 'completed';
      this.store.put('task', taskId, record);
    });
    return this.view(taskId, actor);
  }
  private pseudonym(participantId: string): string {
    let salt = this.store.get<{ value: string }>('setting', 'pseudonym-salt');
    if (!salt) { salt = { value: randomBytes(32).toString('hex') }; this.store.insert('setting', 'pseudonym-salt', salt); }
    return sha256(`${salt.value}:${participantId}`).slice(0, 20);
  }
  freeze(projectId: string): FrozenDataset {
    const project = this.must<Project>('project', projectId);
    const records = this.store.all<TaskRecord>('task'), questions: FrozenQuestion[] = [];
    const latest = new Map<string, TaskRecord>();
    for (const row of records) if (row.task.projectId === projectId && row.task.kind === 'author') latest.set(row.questionId!, row);
    for (const author of latest.values()) {
      if (project.annotationMode === 'single_annotator') {
        if (author.task.status !== 'completed' || !author.selfReview || author.selfReview.revision !== author.task.revision || author.selfReview.participantId !== author.task.assigneeId || author.task.assigneeId !== project.soleAnnotatorId) continue;
        const draft = validateDraft(author.draft, this.must<DocumentRecord>('document', author.task.documentId).blocks, true, false);
        questions.push({ id: author.questionId!, documentId: author.task.documentId, question: draft.question, questionType: draft.questionType, answer: draft.answer, evidenceSets: draft.evidenceSets, ...(draft.unanswerable !== undefined ? { unanswerable: draft.unanswerable } : {}), annotation: { mode: 'single_annotator', annotatorIds: [this.pseudonym(author.task.assigneeId)], reviewedAt: author.selfReview.reviewedAt } });
        continue;
      }
      const review = records.find(row => row.task.kind === 'review' && row.task.sourceTaskId === author.task.id && row.task.status === 'completed');
      if (!review) continue;
      const adjudication = records.find(row => row.task.kind === 'adjudicate' && !row.answerId && row.task.sourceTaskId === review.task.id && row.task.status === 'completed');
      const draft = adjudication?.draft ?? (review.verdict === 'agree' ? author.draft : null);
      if (!draft) continue;
      const annotatorIds = [...new Set([author.task.assigneeId, review.task.assigneeId, ...(adjudication ? [adjudication.task.assigneeId] : [])])].map(participantId => this.pseudonym(participantId));
      const reviewedAt = adjudication?.submittedAt ?? review.verdictAt ?? review.submittedAt;
      questions.push({ id: author.questionId!, documentId: author.task.documentId, question: draft.question, questionType: draft.questionType, answer: draft.answer, evidenceSets: draft.evidenceSets, ...(draft.unanswerable !== undefined ? { unanswerable: draft.unanswerable } : {}), ...(reviewedAt ? { annotation: { mode: 'independent_review' as const, annotatorIds, reviewedAt } } : {}) });
    }
    if (!questions.length) fail(409, 'No hay preguntas revisadas y aceptadas para congelar.');
    const documents = this.store.all<DocumentRecord>('document').filter(record => questions.some(question => question.documentId === record.info.id)).map(record => ({ ...record.info, blocks: record.blocks }));
    const version = Math.max(0, ...this.store.all<FrozenDataset>('freeze').filter(freeze => freeze.projectId === projectId).map(freeze => freeze.version)) + 1;
    const freeze: FrozenDataset = { schemaVersion: 1, id: id(), projectId, version, createdAt: timestamp(), hash: '', documents, questions };
    freeze.hash = hashDataset(freeze); this.store.insert('freeze', freeze.id, freeze); return freeze;
  }
  importDataset(value: unknown): FrozenDataset {
    const body = object(value), imported = object(body.dataset);
    const dataset = validateImportedDataset(imported.freeze ?? imported);
    const name = body.name === undefined ? dataset.projectId : string(body.name, 200);
    return this.store.transaction(() => {
      const sameId = this.store.get<FrozenDataset>('freeze', dataset.id);
      if (sameId) { if (sameId.hash !== dataset.hash) fail(409, 'El ID congelado ya tiene otro contenido.'); return sameId; }
      const projectFreezes = this.store.all<FrozenDataset>('freeze').filter(item => item.projectId === dataset.projectId);
      const sameHash = projectFreezes.find(item => item.hash === dataset.hash);
      if (sameHash) return sameHash;
      if (projectFreezes.some(item => item.version === dataset.version)) fail(409, 'La versión del proyecto ya tiene otro contenido.');
      for (const document of dataset.documents) {
        const { blocks, ...info } = document;
        const existing = this.store.get<DocumentRecord>('document', document.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify({ info, blocks })) fail(409, 'Un ID de documento ya tiene otro contenido.');
      }
      if (!this.store.get('project', dataset.projectId)) this.store.insert('project', dataset.projectId, { id: dataset.projectId, name, createdAt: dataset.createdAt } satisfies Project);
      for (const document of dataset.documents) {
        const { blocks, ...info } = document;
        if (!this.store.get('document', document.id)) this.store.insert('document', document.id, { info, blocks });
      }
      this.store.insert('freeze', dataset.id, dataset);
      this.store.insert('freeze-provenance', dataset.id, { kind: 'external', importedAt: timestamp(), source: imported.freeze ? { sources: imported.sources, provenance: imported.provenance } : null });
      return dataset;
    });
  }
  getFreeze(freezeId: string): FrozenDataset { return this.must<FrozenDataset>('freeze', freezeId); }
  importResults(value: unknown): { tasks: Task[] } {
    const body = object(value), freeze = this.getFreeze(string(body.freezeId, 100));
    const reviewerIds = array(body.reviewerIds, 2).map(value => string(value, 100));
    if (reviewerIds.length !== 2 || new Set(reviewerIds).size !== 2) fail(400, 'Se requieren exactamente dos personas revisoras distintas.');
    reviewerIds.forEach(key => this.active(key));
    const answers = array(body.answers, 10000);
    if (!answers.length) fail(400, 'No hay respuestas.');
    return this.store.transaction(() => {
      const tasks: Task[] = [];
      for (const raw of answers) {
        const answer = object(raw), questionId = string(answer.questionId, 100), question = freeze.questions.find(item => item.id === questionId);
        if (!question) fail(400, 'Pregunta fuera de la versión congelada.');
        const method = string(answer.method, 200), runId = string(answer.runId, 200);
        const unique = sha256(JSON.stringify([freeze.id, questionId, method, runId]));
        if (this.store.get('result-key', unique)) fail(409, 'La respuesta ya fue importada; no se permite sobrescribirla.');
        const blocks = freeze.documents.find(document => document.id === question.documentId)!.blocks;
        const labels = new Set<string>();
        const citations = array(answer.citations, 1000).map(rawCitation => {
          const citation = object(rawCitation), label = string(citation.label, 200);
          if (!/^C[1-9][0-9]*$/.test(label) || labels.has(label)) fail(400, 'Las etiquetas de citas deben ser neutrales y únicas: C1, C2, …');
          labels.add(label); return { label, spans: validateSpans(citation.spans, blocks) };
        });
        const result: ResultRecord = { id: id(), freezeId: freeze.id, questionId, method, runId, reviewerIds, createdAt: timestamp(), answer: { text: string(answer.text, 500000, true), citations } };
        this.store.insert('result', result.id, result); this.store.insert('result-key', unique, { id: result.id });
        for (const assigneeId of reviewerIds) {
          const task: Task = { id: id(), projectId: freeze.projectId, documentId: question.documentId, assigneeId, kind: 'evaluate', status: 'assigned', revision: 0, title: freeze.documents.find(document => document.id === question.documentId)!.title, createdAt: timestamp() };
          this.store.insert('task', task.id, { task, draft: null, answerId: result.id, sortKey: randomBytes(16).toString('hex') } satisfies TaskRecord); tasks.push(task);
        }
      }
      return { tasks };
    });
  }
  ratings(freezeId: string): unknown {
    this.getFreeze(freezeId);
    const tasks = this.store.all<TaskRecord>('task');
    return { schemaVersion: 1, freezeId, answers: this.store.all<ResultRecord>('result').filter(result => result.freezeId === freezeId).map(result => ({ questionId: result.questionId, method: result.method, runId: result.runId, answer: result.answer,
      raw: tasks.filter(record => record.task.kind === 'evaluate' && record.answerId === result.id && record.task.status === 'completed').map(record => ({ taskId: record.task.id, participant: this.pseudonym(record.task.assigneeId), revision: record.task.revision, submittedAt: record.submittedAt, rating: record.draft!.rating })),
      adjudicated: tasks.filter(record => record.task.kind === 'adjudicate' && record.answerId === result.id && record.task.status === 'completed').map(record => ({ participant: this.pseudonym(record.task.assigneeId), revision: record.task.revision, rating: record.draft!.rating, note: record.draft!.note })) })) };
  }
  overview(): AdminOverview {
    const tasks = this.store.all<TaskRecord>('task');
    return { participants: this.store.all<Participant>('participant'), projects: this.store.all<Project>('project'), documents: this.store.all<DocumentRecord>('document').map(record => record.info), tasks: tasks.map(record => record.task), freezes: this.store.all<FrozenDataset>('freeze').map(({ id, projectId, version, hash, createdAt }) => ({ id, projectId, version, hash, createdAt })), issues: tasks.filter(record => record.draft?.rating?.issue.trim()).map(record => ({ taskId: record.task.id, issue: record.draft!.rating!.issue })) };
  }
}
