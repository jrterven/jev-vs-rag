import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, Task, TaskView } from '../shared/types';
import { api, errorMessage, kindLabels, shortDate, statusLabels } from './api';
import Admin from './Admin';
import TaskEditor from './TaskEditor';
import { selectTasks, taskFilterOptions, type TaskFilters } from './taskFilters';

const initialInvite = new URLSearchParams(window.location.hash.slice(1)).get('invite') ?? '';
if (initialInvite) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
let authentication: Promise<Participant | null> | null = null;
function bootstrap() {
  if (!authentication) authentication = (initialInvite
    ? api<{ participant: Participant }>('/auth/redeem', 'POST', { token: initialInvite })
    : api<{ participant: Participant | null }>('/me')).then(result => result.participant);
  return authentication;
}

function Access({ onAuthenticated, initialError }: { onAuthenticated: (participant: Participant) => void; initialError: string }) {
  const [token, setToken] = useState(''); const [error, setError] = useState(initialError); const [pending, setPending] = useState(false);
  async function enter() {
    setPending(true); setError('');
    let value = token.trim();
    try { const link = new URL(value); value = new URLSearchParams(link.hash.slice(1)).get('invite') || value; } catch { /* Raw invite tokens are also accepted. */ }
    try { const result = await api<{ participant: Participant }>('/auth/redeem', 'POST', { token: value }); setToken(''); onAuthenticated(result.participant); }
    catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }
  return <main className="access-page"><section className="card"><span className="eyebrow">Anotación</span><h1>Acceso por invitación</h1>{error && <p className="message error" role="alert">{error}</p>}<form onSubmit={event => { event.preventDefault(); void enter(); }}><div className="field"><label htmlFor="access-token">Enlace o código personal</label><input id="access-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required autoFocus aria-describedby="access-help" /><p id="access-help" className="field-help">Puedes volver con el mismo enlace durante 7 días, salvo que sea reemplazado o revocado. Compártelo sólo con su destinatario.</p></div><button className="button primary" disabled={pending || !token.trim()}>{pending ? 'Entrando…' : 'Entrar'}</button></form><details className="access-help"><summary>Volver a entrar</summary><p>La sesión dura 30 días, salvo que cierres sesión o se revoque el acceso. Si tu enlace venció, fue reemplazado o era una invitación anterior de un solo uso, pide uno nuevo al coordinador.</p></details></section></main>;
}

function TaskHome({ navigate, coordinator }: { navigate: (path: string) => void; coordinator: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [filter, setFilter] = useState<TaskFilters['status']>('pending'); const [kind, setKind] = useState<TaskFilters['kind']>('all');
  const [projectId, setProjectId] = useState(''); const [documentId, setDocumentId] = useState('');
  useEffect(() => { let cancelled = false; api<Task[]>('/tasks').then(result => !cancelled && setTasks(result)).catch(error => !cancelled && setError(errorMessage(error))).finally(() => !cancelled && setLoading(false)); return () => { cancelled = true; }; }, []);
  const selection = selectTasks(tasks, { status: filter, kind, projectId, documentId });
  const { visible } = selection;
  const options = taskFilterOptions(tasks, projectId);
  return <><header className="page-heading"><div><span className="eyebrow">Trabajo asignado</span><h1>Mis tareas</h1></div><span className="subtle">{selection.pending} pendientes</span></header>
    {coordinator && <nav className="coordinator-actions row wrap" aria-label="Coordinación"><button type="button" className="button secondary" onClick={() => navigate('/admin/people')}>Invitar personas</button><button type="button" className="button secondary" onClick={() => navigate('/admin/assignments')}>Asignar tareas</button></nav>}
    <details className="quick-guide"><summary>Cómo trabajar</summary><ol><li>Abre una tarea y sigue sus instrucciones; en autoría, cada tarea corresponde a una pregunta.</li><li>El borrador se autoguarda. Espera «Guardado» o usa «Guardar y salir» para retomarlo después.</li><li>Usa «Enviar» cuando termines tu versión; no hace falta enviar para pausar.</li></ol></details>
    <div className="task-scope-filters"><div className="field"><label htmlFor="task-project-filter">Proyecto</label><select id="task-project-filter" value={projectId} onChange={event => { setProjectId(event.target.value); setDocumentId(''); }}><option value="">Todos los proyectos</option>{options.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div><div className="field"><label htmlFor="task-book-filter">Libro o documento</label><select id="task-book-filter" value={documentId} onChange={event => setDocumentId(event.target.value)}><option value="">Todos los libros y documentos</option>{options.documents.map(document => <option key={document.id} value={document.id}>{document.title}{projectId ? '' : ` · ${document.projectName}`}</option>)}</select></div></div>
    <div className="task-filters"><div className="segmented" role="group" aria-label="Estado de las tareas">{([{ value: 'pending', label: 'Pendientes' }, { value: 'completed', label: 'Completadas' }, { value: 'all', label: 'Todas' }] as const).map(item => <button key={item.value} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div><label className="visually-hidden" htmlFor="kind-filter">Tipo de tarea</label><select id="kind-filter" value={kind} onChange={event => setKind(event.target.value as TaskFilters['kind'])}><option value="all">Todos los tipos</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {!loading && !error && <p className="task-filter-summary" role="status">{visible.length} de {selection.total} tareas en esta selección</p>}
    {error && <p className="message error" role="alert">{error}</p>}{loading ? <p className="empty" role="status">Cargando tareas…</p> : error ? null : visible.length ? <ul className="task-list">{visible.map(task => <li key={task.id}><button type="button" onClick={() => navigate(`/tasks/${task.id}`)}><span className="task-kind">{kindLabels[task.kind]}</span><span className="task-description"><strong>{task.title}</strong><span className="subtle">{task.projectName ? `${task.projectName} · ` : ''}{shortDate(task.createdAt)}</span></span><span className={`task-status status-${task.status}`}>{statusLabels[task.status]}</span><span className="task-arrow" aria-hidden="true">→</span></button></li>)}</ul> : <div className="card empty empty-state">{tasks.length ? <><h2>No hay tareas con estos filtros.</h2><button type="button" className="button secondary" onClick={() => { setFilter('all'); setKind('all'); setProjectId(''); setDocumentId(''); }}>Mostrar todas</button></> : <><h2>Aún no tienes tareas asignadas.</h2><p>{coordinator ? 'Importa documentos y asigna tareas a ti o a otras personas.' : 'El coordinador puede asignarte una tarea.'}</p>{coordinator && <button type="button" className="button secondary" onClick={() => navigate('/admin/corpus')}>Ver documentos</button>}</>}</div>}
  </>;
}

export default function App() {
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [path, setPath] = useState(window.location.pathname);
  const currentPath = useRef(path); currentPath.current = path;
  const [taskView, setTaskView] = useState<TaskView | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const flush = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((next: (() => Promise<void>) | null) => { flush.current = next; }, []);
  const taskId = path.match(/^\/tasks\/([^/]+)\/?$/)?.[1];

  useEffect(() => {
    let cancelled = false;
    bootstrap().then(person => !cancelled && setParticipant(person)).catch(error => !cancelled && setError(errorMessage(error))).finally(() => !cancelled && setInitializing(false));
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const pop = () => {
      const next = window.location.pathname;
      void (async () => {
        try { await flush.current?.(); setPath(next); setError(''); }
        catch (error) { history.pushState(null, '', currentPath.current); setError(errorMessage(error)); }
      })();
    };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const acceptInvite = async () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get('invite');
      if (!token) return;
      history.replaceState(null, '', window.location.pathname + window.location.search);
      try {
        await flush.current?.();
        const result = await api<{ participant: Participant }>('/auth/redeem', 'POST', { token });
        authentication = Promise.resolve(result.participant); setParticipant(result.participant); setError('');
        history.replaceState(null, '', '/'); setPath('/');
      } catch (error) { setError(errorMessage(error)); }
    };
    window.addEventListener('hashchange', acceptInvite);
    return () => window.removeEventListener('hashchange', acceptInvite);
  }, []);
  async function navigate(next: string) {
    try { await flush.current?.(); } catch (error) { setError(errorMessage(error)); return false; }
    history.pushState(null, '', next); setPath(next); setError(''); window.scrollTo(0, 0);
    return true;
  }
  const loadTask = useCallback(async () => {
    if (!taskId) return;
    setTaskLoading(true); setError('');
    try { setTaskView(await api<TaskView>(`/tasks/${encodeURIComponent(taskId)}`)); setVersion(value => value + 1); }
    catch (error) { setError(errorMessage(error)); } finally { setTaskLoading(false); }
  }, [taskId]);
  useEffect(() => {
    if (!participant || !taskId) { setTaskView(null); return; }
    let cancelled = false; setTaskView(null); setTaskLoading(true);
    api<TaskView>(`/tasks/${encodeURIComponent(taskId)}`).then(result => { if (!cancelled) { setTaskView(result); setVersion(value => value + 1); } }).catch(error => !cancelled && setError(errorMessage(error))).finally(() => !cancelled && setTaskLoading(false));
    return () => { cancelled = true; };
  }, [participant?.id, taskId]);
  async function logout() {
    setPending(true);
    try { await flush.current?.(); await api('/auth/logout', 'POST'); authentication = null; setParticipant(null); setTaskView(null); }
    catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }
  if (initializing) return <div className="initial-loading" role="status">Cargando…</div>;
  if (!participant) return <Access initialError={error} onAuthenticated={person => { setParticipant(person); setError(''); }} />;
  return <div className="annotation-shell">
    <a href="#main-content" className="skip-link">Ir al contenido</a>
    <header className="app-header"><button type="button" className="wordmark" onClick={() => void navigate('/')}>Anotación</button><nav aria-label="Principal"><button aria-current={!path.startsWith('/admin') ? 'page' : undefined} onClick={() => void navigate('/')}>Mis tareas</button>{participant.role === 'coordinator' && <button aria-current={path.startsWith('/admin') ? 'page' : undefined} onClick={() => void navigate('/admin')}>Administración</button>}</nav><div className="account"><span>{participant.name}</span><button type="button" className="text-button" disabled={pending} onClick={() => void logout()}>Salir</button></div></header>
    <main id="main-content">{error && <p className="message error" role="alert">{error}</p>}{taskId ? <><button type="button" className="back-link text-button" onClick={() => void navigate('/')}>← Mis tareas</button>{taskLoading ? <p className="empty" role="status">Cargando tarea…</p> : taskView && <TaskEditor key={`${taskView.task.id}:${version}`} view={taskView} participant={participant} registerFlush={registerFlush} onLeave={() => navigate('/')} onReload={loadTask} onUpdated={result => { setTaskView(result); setVersion(value => value + 1); }} />}</> : path.startsWith('/admin') && participant.role === 'coordinator' ? <Admin path={path} navigate={next => void navigate(next)} /> : <TaskHome key={`${participant.id}:${path}`} navigate={next => void navigate(next)} coordinator={participant.role === 'coordinator'} />}</main>
  </div>;
}
