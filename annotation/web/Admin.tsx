import { useEffect, useRef, useState } from 'react';
import type { AdminOverview, AnnotationMode, DocumentInfo, Participant, Project, Task } from '../shared/types';
import { api, downloadJson, errorMessage, kindLabels, prefix, shortDate, statusLabels } from './api';

const empty: AdminOverview = { participants: [], projects: [], documents: [], tasks: [], freezes: [] };
const tabs = [{ id: 'corpus', title: 'Documentos' }, { id: 'people', title: 'Personas e invitaciones' }, { id: 'assignments', title: 'Asignaciones' }, { id: 'versions', title: 'Versiones y evaluación' }] as const;
function ProjectModeFields({ id, mode, annotatorId, people, onMode, onAnnotator, disabled = false }: {
  id: string; mode: AnnotationMode; annotatorId: string; people: Participant[]; onMode: (value: AnnotationMode) => void; onAnnotator: (value: string) => void; disabled?: boolean;
}) {
  return <><div className="field"><label htmlFor={`${id}-mode`}>Modo de anotación</label><select id={`${id}-mode`} value={mode} onChange={event => onMode(event.target.value as AnnotationMode)} disabled={disabled}><option value="independent_review">Revisión independiente</option><option value="single_annotator">Un anotador</option></select><p className="field-help">{mode === 'single_annotator' ? 'La misma persona crea las preguntas y confirma su revisión personal.' : 'Una persona crea las preguntas y otra las revisa de forma independiente.'}</p></div>{mode === 'single_annotator' && <div className="field"><label htmlFor={`${id}-annotator`}>Un anotador</label><select id={`${id}-annotator`} value={annotatorId} onChange={event => onAnnotator(event.target.value)} required disabled={disabled}><option value="">Seleccionar persona</option>{annotatorId && !people.some(person => person.id === annotatorId) && <option value={annotatorId} disabled>Persona no disponible</option>}{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div>}</>;
}
export default function Admin({ path, navigate }: { path: string; navigate: (path: string) => void }) {
  const [data, setData] = useState<AdminOverview>(empty);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [projectId, setProjectId] = useState('');
  const tab = tabs.find(item => path.replace(/\/$/, '') === `/admin/${item.id}`)?.id ?? 'corpus';
  const [projectName, setProjectName] = useState('');
  const [newMode, setNewMode] = useState<AnnotationMode>('independent_review');
  const [newAnnotator, setNewAnnotator] = useState('');
  const [projectMode, setProjectMode] = useState<AnnotationMode>('independent_review');
  const [projectAnnotator, setProjectAnnotator] = useState('');
  const [personName, setPersonName] = useState('');
  const [role, setRole] = useState<Participant['role']>('collaborator');
  const [canAdjudicate, setCanAdjudicate] = useState(false);
  const [invite, setInvite] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const inviteField = useRef<HTMLTextAreaElement>(null);
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentSource, setDocumentSource] = useState('');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [kind, setKind] = useState<Task['kind']>('author');
  const [sourceTaskId, setSourceTaskId] = useState('');
  const [freezeId, setFreezeId] = useState('');
  const [reviewer1, setReviewer1] = useState('');
  const [reviewer2, setReviewer2] = useState('');
  const [resultsFile, setResultsFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [datasetName, setDatasetName] = useState('');
  const [amendTask, setAmendTask] = useState<Task | null>(null);
  const [amendNote, setAmendNote] = useState('');
  const [amendAssignee, setAmendAssignee] = useState('');

  async function refresh() {
    const next = await api<AdminOverview>('/admin'); setData(next);
    setProjectId(current => next.projects.some(project => project.id === current) ? current : next.projects[0]?.id ?? '');
  }
  useEffect(() => { void refresh().catch(error => setError(errorMessage(error))).finally(() => setLoading(false)); }, []);
  useEffect(() => { setCopyNotice(''); }, [invite]);
  useEffect(() => { setError(''); setNotice(''); }, [tab]);
  async function action(work: () => Promise<void>) { setPending(true); setError(''); setNotice(''); try { await work(); await refresh(); } catch (error) { setError(errorMessage(error)); } finally { setPending(false); } }
  const documents = data.documents.filter(document => document.projectId === projectId);
  const tasks = data.tasks.filter(task => task.projectId === projectId);
  const freezes = data.freezes.filter(freeze => freeze.projectId === projectId);
  const people = data.participants.filter(person => person.active);
  const project = data.projects.find(item => item.id === projectId);
  const singleAnnotator = project?.annotationMode === 'single_annotator';
  const modeLocked = freezes.length > 0 || tasks.some(task => task.kind === 'review' || ['submitted', 'completed'].includes(task.status));
  const modeChanged = projectMode !== (project?.annotationMode ?? 'independent_review') || (projectMode === 'single_annotator' && projectAnnotator !== project?.soleAnnotatorId);
  const authorMismatch = projectMode === 'single_annotator' && !!projectAnnotator && tasks.some(task => task.kind === 'author' && task.assigneeId !== projectAnnotator);
  const sources = tasks.filter(task => kind === 'review' ? !singleAnnotator && task.kind === 'author' && ['submitted', 'completed'].includes(task.status) : (singleAnnotator ? task.kind === 'evaluate' : ['review', 'evaluate'].includes(task.kind)) && task.status === 'completed');
  const selectedSource = sources.find(task => task.id === sourceTaskId);
  const assignedDocument = kind === 'author' ? documentId : selectedSource?.documentId ?? '';
  const assignmentAssignee = singleAnnotator && kind === 'author' ? project?.soleAnnotatorId ?? '' : assigneeId;
  const eligiblePeople = people.filter(person => (!singleAnnotator || kind !== 'author' || person.id === project?.soleAnnotatorId) && (kind !== 'adjudicate' || person.canAdjudicate || person.role === 'coordinator') && (kind !== 'review' || person.id !== selectedSource?.assigneeId));
  const eligibleAssignee = eligiblePeople.some(person => person.id === assignmentAssignee);
  const amendPeople = people.filter(person => !singleAnnotator || person.id === project?.soleAnnotatorId);
  const amendmentAssignee = singleAnnotator ? project?.soleAnnotatorId ?? '' : amendAssignee;
  const canAssign = !!projectId && documents.length > 0 && people.length > 0;

  useEffect(() => { setProjectMode(project?.annotationMode ?? 'independent_review'); setProjectAnnotator(project?.soleAnnotatorId ?? ''); }, [project?.id, project?.annotationMode, project?.soleAnnotatorId]);
  useEffect(() => { if (singleAnnotator && kind === 'review') { setKind('author'); setSourceTaskId(''); } }, [singleAnnotator, kind]);

  async function copyInvite() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(invite);
      setCopyNotice('Enlace copiado. Compártelo con esta persona.');
    } catch {
      inviteField.current?.focus(); inviteField.current?.select();
      setCopyNotice('Enlace seleccionado. Cópialo y compártelo con esta persona.');
    }
  }

  async function importDocument() {
    if (!documentFile || !projectId) return;
    const text = await documentFile.text();
    let title = documentTitle.trim() || documentFile.name.replace(/\.(json|txt)$/i, '');
    let sourceUrl = documentSource.trim();
    let blocks: Array<{ text: string; heading?: string; page?: number }>;
    if (documentFile.name.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(text);
      const rawBlocks = Array.isArray(parsed) ? parsed : parsed.blocks;
      if (!Array.isArray(rawBlocks) || !rawBlocks.length) throw new Error('El JSON debe contener blocks: [{text, heading?, page?}].');
      if (!documentTitle.trim() && parsed.title) title = parsed.title;
      if (!sourceUrl && parsed.sourceUrl) sourceUrl = parsed.sourceUrl;
      blocks = rawBlocks.map((block: unknown, index: number) => {
        if (typeof block === 'string') return { text: block };
        if (!block || typeof block !== 'object' || !('text' in block) || typeof block.text !== 'string') throw new Error(`El bloque ${index + 1} no contiene texto.`);
        const item = block as { text: string; heading?: string; page?: number };
        return { text: item.text, ...(typeof item.heading === 'string' ? { heading: item.heading } : {}), ...(typeof item.page === 'number' ? { page: item.page } : {}) };
      });
    } else {
      blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(paragraph => ({ text: paragraph.trim() })).filter(block => block.text);
    }
    if (!blocks.length) throw new Error('El documento no contiene texto.');
    const imported = await api<DocumentInfo>('/admin/documents', 'POST', { projectId, title, ...(sourceUrl ? { sourceUrl } : {}), blocks });
    setDocumentId(imported.id); setDocumentTitle(''); setDocumentSource(''); setDocumentFile(null); setNotice(`Documento importado · ${imported.blockCount} bloques.`);
  }
  async function importResults() {
    if (!resultsFile) return;
    const parsed = JSON.parse(await resultsFile.text());
    const answers = Array.isArray(parsed) ? parsed : parsed.answers;
    if (!Array.isArray(answers)) throw new Error('El archivo debe contener un arreglo answers.');
    if (!reviewer1 || !reviewer2 || reviewer1 === reviewer2) throw new Error('Selecciona dos evaluadores diferentes.');
    const result = await api<{ tasks: Task[] }>('/admin/results', 'POST', { freezeId, answers, reviewerIds: [reviewer1, reviewer2] });
    setResultsFile(null); setNotice(`${result.tasks.length} tareas de evaluación asignadas.`);
  }
  function exampleDocument() { downloadJson('documento-ejemplo.json', { title: 'Título del documento', sourceUrl: 'https://example.com/documento.pdf', blocks: [{ text: 'Capítulo 1', heading: 'Capítulo 1', page: 1 }, { text: 'Texto exacto del párrafo.', page: 1 }] }); }
  function exampleResults() { downloadJson('respuestas-ejemplo.json', { answers: [{ questionId: 'ID de pregunta en la versión congelada', method: 'Identificador interno del método', runId: 'Identificador interno de ejecución', text: 'Respuesta a evaluar', citations: [{ label: 'C1', spans: [{ blockId: 'ID del bloque fuente', start: 0, end: 5, quote: 'Texto' }] }] }] }); }

  return <>
    <header className="page-heading"><div><span className="eyebrow">Coordinación</span><h1>Administración</h1></div><div className="field compact"><label htmlFor="admin-project">Proyecto</label><select id="admin-project" value={projectId} onChange={event => { setProjectId(event.target.value); setDocumentId(''); setSourceTaskId(''); setFreezeId(''); setAmendTask(null); }}><option value="">Seleccionar proyecto</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div></header>
    {error && <p className="message error" role="alert">{error}</p>}{notice && <p className="message" role="status">{notice}</p>}
    <nav className="admin-tabs" aria-label="Administración">{tabs.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => navigate(`/admin/${item.id}`)}>{item.title}</button>)}</nav>
    {loading ? <p className="empty" role="status">Cargando…</p> : <>
      {tab === 'corpus' && <div className="admin-grid"><section className="card"><h2>Nuevo proyecto</h2><form onSubmit={event => { event.preventDefault(); void action(async () => { const project = await api<Project>('/admin/projects', 'POST', { name: projectName.trim(), annotationMode: newMode, ...(newMode === 'single_annotator' ? { soleAnnotatorId: newAnnotator } : {}) }); setProjectName(''); setProjectId(project.id); setDocumentId(''); setSourceTaskId(''); setNotice('Proyecto creado.'); }); }}>
          <div className="field"><label htmlFor="project-name">Nombre</label><input id="project-name" value={projectName} onChange={event => setProjectName(event.target.value)} required maxLength={200} /></div>
          <ProjectModeFields id="new-project" mode={newMode} annotatorId={newAnnotator} people={people} onMode={setNewMode} onAnnotator={setNewAnnotator} disabled={pending} />
          <button className="button primary" disabled={pending || !projectName.trim() || (newMode === 'single_annotator' && !people.some(person => person.id === newAnnotator))}>Crear proyecto</button>
        </form></section>
        <section className="card"><h2>Importar documento</h2>{!projectId && <p className="section-help">Crea o selecciona un proyecto para importar documentos.</p>}<form onSubmit={event => { event.preventDefault(); void action(importDocument); }}><div className="field"><label htmlFor="document-title">Título</label><input id="document-title" value={documentTitle} onChange={event => setDocumentTitle(event.target.value)} placeholder="Nombre del archivo si se deja vacío" /></div><div className="field"><label htmlFor="document-source">Enlace al original (opcional)</label><input id="document-source" type="url" value={documentSource} onChange={event => setDocumentSource(event.target.value)} /></div><div className="field"><label htmlFor="document-file">Archivo JSON o TXT</label><input id="document-file" type="file" accept=".json,.txt" onChange={event => setDocumentFile(event.target.files?.[0] ?? null)} /><p className="field-help">JSON conserva bloques, secciones y páginas. TXT separa párrafos por líneas vacías.</p><button className="text-button" type="button" onClick={exampleDocument}>Descargar formato JSON</button></div><button className="button primary" disabled={pending || !projectId || !documentFile}>Importar</button></form></section>
        {project && <section className="card wide"><h2>Modo del proyecto</h2><form onSubmit={event => { event.preventDefault(); void action(async () => { await api<Project>(`/admin/projects/${project.id}`, 'PATCH', { annotationMode: projectMode, ...(projectMode === 'single_annotator' ? { soleAnnotatorId: projectAnnotator } : {}) }); setSourceTaskId(''); setAssigneeId(''); setAmendTask(null); setNotice('Modo del proyecto actualizado.'); }); }}>
          <div className="fields two"><ProjectModeFields id="current-project" mode={projectMode} annotatorId={projectAnnotator} people={people} onMode={setProjectMode} onAnnotator={setProjectAnnotator} disabled={pending || modeLocked} /></div>
          {modeLocked ? <p className="field-help">El modo y la persona no pueden cambiarse: este proyecto ya tiene envíos, revisiones o versiones congeladas.</p> : <><p className="field-help">Puedes cambiar el modo antes del primer envío, revisión o versión congelada.</p>{authorMismatch && <p className="field-help">Para elegir un anotador, todas las autorías existentes deben estar asignadas a esa persona.</p>}<button className="button secondary" disabled={pending || !modeChanged || authorMismatch || (projectMode === 'single_annotator' && !people.some(person => person.id === projectAnnotator))}>Guardar modo</button></>}
        </form></section>}
        <section className="card wide"><h2>Documentos del proyecto</h2>{documents.length ? <ul className="admin-list">{documents.map(document => <li key={document.id}><div><strong>{document.title}</strong><span className="subtle">{document.blockCount} bloques · versión {document.version}</span><code>{document.hash.slice(0, 16)}</code></div></li>)}</ul> : <p className="empty">{projectId ? 'Este proyecto aún no tiene documentos. Importa un archivo JSON o TXT.' : 'Crea o selecciona un proyecto para ver sus documentos.'}</p>}</section></div>}
      {tab === 'people' && <div className="admin-grid"><section className="card"><h2>Invitar persona</h2><p className="section-help">Crea la persona, copia su enlace y asígnale una tarea.</p><form onSubmit={event => { event.preventDefault(); void action(async () => { const result = await api<{ participant: Participant; inviteUrl: string }>('/admin/participants', 'POST', { name: personName.trim(), role, canAdjudicate }); setInvite(result.inviteUrl); setAssigneeId(result.participant.id); setPersonName(''); }); }}><div className="field"><label htmlFor="person-name">Nombre</label><input id="person-name" value={personName} onChange={event => setPersonName(event.target.value)} required maxLength={160} /></div><div className="field"><label htmlFor="person-role">Rol</label><select id="person-role" value={role} onChange={event => setRole(event.target.value as Participant['role'])}><option value="collaborator">Colaborador</option><option value="coordinator">Coordinador</option></select></div><label className="checkbox"><input type="checkbox" checked={canAdjudicate} onChange={event => setCanAdjudicate(event.target.checked)} />Puede adjudicar desacuerdos</label><button className="button primary" disabled={pending || !personName.trim()}>Crear invitación</button></form>{invite && <div className="invite-box"><label htmlFor="invite-url">Enlace personal de acceso</label><textarea id="invite-url" ref={inviteField} readOnly value={invite} rows={3} aria-describedby="invite-help" onFocus={event => event.currentTarget.select()} /><p id="invite-help" className="field-help">Compártelo sólo con esta persona. Puede volver con el mismo enlace durante 7 días, salvo reemplazo o revocación; la sesión dura 30 días.</p><div className="row wrap"><button type="button" className="button secondary small" onClick={() => void copyInvite()}>Copiar enlace</button><button type="button" className="text-button" onClick={() => navigate('/admin/assignments')}>Asignar tarea</button></div>{copyNotice && <p className="copy-notice" role="status">{copyNotice}</p>}</div>}</section>
        <section className="card"><h2>Personas e invitaciones</h2><p className="section-help">«Nueva invitación» reemplaza el enlace anterior. Úsala si venció o si la persona tenía una invitación anterior de un solo uso.</p><ul className="admin-list">{data.participants.map(person => <li key={person.id}><div><strong>{person.name}</strong><span className="subtle">{person.role === 'coordinator' ? 'Coordinador' : 'Colaborador'}{person.canAdjudicate ? ' · Adjudicación' : ''} · {person.active ? 'Activo' : 'Revocado'}</span></div>{person.active && <div className="row wrap"><button className="text-button" disabled={pending} onClick={() => void action(async () => { const result = await api<{ inviteUrl: string }>(`/admin/participants/${person.id}/invite`, 'POST'); setInvite(result.inviteUrl); setAssigneeId(person.id); })}>Nueva invitación</button><button className="text-button" disabled={pending} onClick={() => { if (window.confirm(`Revocar el acceso de ${person.name}?`)) void action(async () => { await api(`/admin/participants/${person.id}/revoke`, 'POST'); setNotice('Acceso revocado.'); }); }}>Revocar acceso</button></div>}</li>)}</ul></section></div>}
      {tab === 'assignments' && <div className="admin-grid"><section className="card"><h2>Asignar tarea</h2>{singleAnnotator && <p className="section-help">Una persona crea las preguntas y confirma su revisión personal después de enviarlas.</p>}
        {!canAssign ? <div className="prerequisites">
          {!projectId ? <p>Crea o selecciona un proyecto e importa un documento.</p> : !documents.length && <p>Este proyecto aún no tiene documentos. Importa uno para asignar tareas.</p>}
          {(!projectId || !documents.length) && <button type="button" className="button secondary" onClick={() => navigate('/admin/corpus')}>Ir a documentos</button>}
          {!people.length && <><p>Crea una persona para asignarle tareas.</p><button type="button" className="button secondary" onClick={() => navigate('/admin/people')}>Invitar personas</button></>}
        </div> : <form onSubmit={event => { event.preventDefault(); void action(async () => { await api<Task>('/admin/tasks', 'POST', { projectId, documentId: assignedDocument, assigneeId: assignmentAssignee, kind, ...(kind !== 'author' ? { sourceTaskId } : {}) }); setNotice('Tarea asignada.'); }); }}>
          <div className="field"><label htmlFor="task-kind">Tipo</label><select id="task-kind" value={kind} onChange={event => { setKind(event.target.value as Task['kind']); setSourceTaskId(''); }}><option value="author">Autoría</option>{!singleAnnotator && <option value="review">Revisión</option>}<option value="adjudicate">{singleAnnotator ? 'Adjudicación de evaluaciones' : 'Adjudicación'}</option></select></div>
          {kind === 'author' ? <div className="field"><label htmlFor="task-document">Documento</label><select id="task-document" value={documentId} onChange={event => setDocumentId(event.target.value)} required><option value="">Seleccionar</option>{documents.map(document => <option key={document.id} value={document.id}>{document.title}</option>)}</select></div> : sources.length ? <div className="field"><label htmlFor="source-task">{kind === 'review' ? 'Autoría enviada' : singleAnnotator ? 'Evaluación a resolver' : 'Revisión o evaluación a resolver'}</label><select id="source-task" value={sourceTaskId} onChange={event => setSourceTaskId(event.target.value)} required><option value="">Seleccionar tarea de origen</option>{sources.map(task => <option key={task.id} value={task.id}>{kindLabels[task.kind]} · {task.title} · {data.participants.find(person => person.id === task.assigneeId)?.name}</option>)}</select></div> : <div className="prerequisites">
            <p>{kind === 'review' ? 'Para asignar una revisión, primero debe enviarse una autoría.' : singleAnnotator ? 'Para adjudicar, primero debe completarse una evaluación ciega.' : 'Para adjudicar, primero debe completarse una revisión o evaluación.'}</p>
            {!singleAnnotator && <button type="button" className="text-button" onClick={() => { setKind(kind === 'review' ? 'author' : 'review'); setSourceTaskId(''); }}>{kind === 'review' ? 'Asignar autoría' : 'Asignar revisión'}</button>}
            {kind === 'adjudicate' && <button type="button" className="text-button" onClick={() => navigate('/admin/versions')}>Ir a evaluación ciega</button>}
          </div>}
          {eligiblePeople.length ? <div className="field"><label htmlFor="assignee">Responsable</label><select id="assignee" value={eligibleAssignee ? assignmentAssignee : ''} onChange={event => setAssigneeId(event.target.value)} required disabled={singleAnnotator && kind === 'author'}><option value="">Seleccionar</option>{eligiblePeople.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div> : <div className="prerequisites"><p>{kind === 'review' ? 'La revisión requiere una persona distinta de la autora.' : kind === 'author' && singleAnnotator ? 'El anotador del proyecto no está disponible. Revisa su acceso en Personas e invitaciones.' : 'Se necesita una persona con permiso para adjudicar.'}</p><button type="button" className="text-button" onClick={() => navigate('/admin/people')}>Ir a personas e invitaciones</button></div>}
          {(!assignedDocument || !eligibleAssignee) && (kind === 'author' || sources.length > 0) && eligiblePeople.length > 0 && <p className="field-help">Selecciona {kind === 'author' ? 'el documento' : 'la tarea de origen'} y la persona responsable.</p>}
          <div className="row wrap"><button className="button primary" disabled={pending || !assignedDocument || !eligibleAssignee}>Asignar</button><button type="button" className="text-button" onClick={() => navigate('/admin/people')}>Invitar personas</button></div>
        </form>}</section>
        <section className="card"><h2>Tareas del proyecto</h2>{tasks.length ? <ul className="admin-list">{tasks.map(task => <li key={task.id}><div><strong>{task.title}</strong><span className="subtle">{kindLabels[task.kind]} · {data.participants.find(person => person.id === task.assigneeId)?.name} · {statusLabels[task.status]}</span></div>{task.kind === 'author' && ['submitted', 'completed'].includes(task.status) && <button type="button" className="text-button" onClick={() => { setAmendTask(task); setAmendAssignee(singleAnnotator ? project?.soleAnnotatorId ?? '' : task.assigneeId); setAmendNote(''); }}>Corregir</button>}</li>)}</ul> : <p className="empty">{projectId ? 'Aún no hay tareas en este proyecto.' : 'Selecciona un proyecto para ver sus tareas.'}</p>}</section>{amendTask && <section className="card wide"><h2>Corregir anotación</h2><p className="field-help">{singleAnnotator ? 'Crea una nueva autoría para la misma persona, que deberá confirmar otra revisión personal.' : 'Crea una nueva autoría que debe volver a revisarse.'} Las versiones congeladas conservan sus datos.</p><form onSubmit={event => { event.preventDefault(); void action(async () => { await api(`/admin/tasks/${amendTask.id}/amend`, 'POST', { assigneeId: amendmentAssignee, note: amendNote }); setAmendTask(null); setNotice('Corrección asignada.'); }); }}><div className="field"><label htmlFor="amend-assignee">Responsable de la corrección</label><select id="amend-assignee" value={amendmentAssignee} onChange={event => setAmendAssignee(event.target.value)} disabled={singleAnnotator}>{amendPeople.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div><div className="field"><label htmlFor="amend-note">Motivo de la corrección</label><textarea id="amend-note" rows={3} required value={amendNote} onChange={event => setAmendNote(event.target.value)} /></div><div className="row"><button className="button primary" disabled={pending || !amendNote.trim() || !amendPeople.some(person => person.id === amendmentAssignee)}>Asignar corrección</button><button className="text-button" type="button" onClick={() => setAmendTask(null)}>Cancelar</button></div></form></section>}</div>}
      {tab === 'versions' && <div className="admin-grid"><section className="card wide"><h2>Importar conjunto congelado</h2><form onSubmit={event => { event.preventDefault(); void action(async () => { if (!datasetFile) return; const parsed = JSON.parse(await datasetFile.text()); const result = await api<{ projectId: string; id: string }>('/admin/datasets', 'POST', { dataset: parsed, ...(datasetName.trim() ? { name: datasetName.trim() } : {}) }); setProjectId(result.projectId); setFreezeId(result.id); setDatasetFile(null); setDatasetName(''); setNotice('Conjunto importado.'); }); }}><div className="fields two"><div className="field"><label htmlFor="dataset-name">Nombre del proyecto (opcional)</label><input id="dataset-name" value={datasetName} onChange={event => setDatasetName(event.target.value)} /></div><div className="field"><label htmlFor="dataset-file">Dataset o bundle de investigación (JSON)</label><input id="dataset-file" type="file" accept=".json" onChange={event => setDatasetFile(event.target.files?.[0] ?? null)} /></div></div><button className="button primary" disabled={pending || !datasetFile}>Importar conjunto</button></form></section><section className="card"><h2>Congelar versión</h2><p className="field-help">{singleAnnotator ? 'Incluye las preguntas cuya revisión personal confirmó la misma persona autora. No representa una revisión independiente.' : 'Publica una versión inmutable de las preguntas aprobadas y sus fuentes.'}</p><button type="button" className="button primary" disabled={pending || !projectId} onClick={() => void action(async () => { const result = await api<{ id: string; version: number }>(`/admin/projects/${projectId}/freeze`, 'POST'); setFreezeId(result.id); setNotice(`Versión ${result.version} congelada.`); })}>Congelar versión</button><ul className="admin-list">{freezes.map(freeze => <li key={freeze.id}><div><strong>Versión {freeze.version}</strong><span className="subtle">{shortDate(freeze.createdAt)}</span><code>{freeze.hash.slice(0, 16)}</code></div><div className="row wrap"><a className="small-link" href={`${prefix}/admin/freezes/${freeze.id}/export`} download>Exportar dataset</a><a className="small-link" href={`${prefix}/admin/freezes/${freeze.id}/ratings/export`} download>Exportar valoraciones</a></div></li>)}</ul></section>
        <section className="card"><h2>Asignar evaluación ciega</h2>{singleAnnotator && <p className="section-help">La evaluación de respuestas requiere dos personas distintas, también en este modo.</p>}<form onSubmit={event => { event.preventDefault(); void action(importResults); }}><div className="field"><label htmlFor="evaluation-freeze">Versión congelada</label><select id="evaluation-freeze" value={freezeId} onChange={event => setFreezeId(event.target.value)} required><option value="">Seleccionar</option>{freezes.map(freeze => <option key={freeze.id} value={freeze.id}>Versión {freeze.version} · {shortDate(freeze.createdAt)}</option>)}</select></div><div className="field"><label htmlFor="results-file">Respuestas del experimento (JSON)</label><input id="results-file" type="file" accept=".json" onChange={event => setResultsFile(event.target.files?.[0] ?? null)} /><button className="text-button" type="button" onClick={exampleResults}>Descargar formato JSON</button></div><div className="fields two">{[{ value: reviewer1, set: setReviewer1, id: 'reviewer-one', label: 'Evaluador 1' }, { value: reviewer2, set: setReviewer2, id: 'reviewer-two', label: 'Evaluador 2' }].map(field => <div className="field" key={field.id}><label htmlFor={field.id}>{field.label}</label><select id={field.id} value={field.value} onChange={event => field.set(event.target.value)} required><option value="">Seleccionar</option>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div>)}</div><button className="button primary" disabled={pending || !freezeId || !resultsFile || !reviewer1 || !reviewer2 || reviewer1 === reviewer2}>Importar y asignar</button></form></section>
        {!!data.issues?.length && <section className="card wide"><h2>Incidencias reportadas</h2><ul className="admin-list">{data.issues.map((issue, index) => <li key={`${issue.taskId}-${index}`}><div><strong>{issue.issue}</strong><span className="subtle">Tarea {issue.taskId}</span></div></li>)}</ul></section>}
      </div>}
    </>}
  </>;
}
