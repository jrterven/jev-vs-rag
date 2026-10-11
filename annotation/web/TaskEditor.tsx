import { useEffect, useRef, useState } from 'react';
import type { AnnotationDraft, AnswerRating, EvidenceSpan, Participant, TaskView } from '../shared/types';
import { api, errorMessage, kindLabels, statusLabels } from './api';
import { useDraft } from './useDraft';
import DocumentReader, { type Jump } from './DocumentReader';
import TaskGuide from './TaskGuide';

const questionTypes = { factual: 'Dato puntual', explanatory: 'Explicación', multi_section: 'Varias secciones' };
const savedLabels = { saved: 'Guardado', pending: 'Cambios sin guardar', saving: 'Guardando…', offline: 'Sin conexión · copia local', error: 'No se pudo guardar', conflict: 'Conflicto de versión' };

function EvidenceGroups({ sets, activeSet, onActive, onChange, onJump, editable = false }: {
  sets: EvidenceSpan[][]; activeSet?: number; onActive?: (index: number) => void; onChange?: (sets: EvidenceSpan[][]) => void; onJump: (span: EvidenceSpan) => void; editable?: boolean;
}) {
  return <div className="evidence-groups">
    {sets.map((set, index) => <section key={index} className={`evidence-set${index === activeSet ? ' active-set' : ''}`} aria-label={`Conjunto de evidencia ${index + 1}`}>
      <header><button type="button" className="evidence-set-label" aria-pressed={index === activeSet} disabled={!editable} onClick={() => onActive?.(index)}>Conjunto {index + 1}{index === activeSet && editable ? ' · activo' : ''}</button>{editable && sets.length > 1 && <button type="button" className="text-button" onClick={() => { onChange?.(sets.filter((_, i) => i !== index)); onActive?.(0); }} aria-label={`Eliminar conjunto ${index + 1}`}>Eliminar</button>}</header>
      {set.length ? <ol>{set.map((span, spanIndex) => <li key={`${span.blockId}-${span.start}-${span.end}-${spanIndex}`}><button className="evidence-quote" type="button" onClick={() => onJump(span)}>{span.quote}<span>Ver en el documento ↗</span></button>{editable && <button className="remove-span" type="button" aria-label={`Quitar evidencia ${spanIndex + 1} del conjunto ${index + 1}`} onClick={() => onChange?.(sets.map((value, i) => i === index ? value.filter((_, j) => j !== spanIndex) : value))}>Quitar</button>}</li>)}</ol> : <p className="subtle empty-evidence">Selecciona texto en el documento.</p>}
    </section>)}
    {editable && <button type="button" className="text-button" onClick={() => { onChange?.([...sets, []]); onActive?.(sets.length); }}>+ Añadir un conjunto alternativo</button>}
  </div>;
}

function AnnotationPreview({ title, annotation, onJump, onUse }: { title: string; annotation: AnnotationDraft; onJump: (span: EvidenceSpan) => void; onUse?: () => void }) {
  return <details className="annotation-preview"><summary>{title}</summary><div>{annotation.rating ? <dl className="rating-summary"><dt>Corrección</dt><dd>{annotation.rating.correctness == null ? 'Sin valoración' : annotation.rating.correctness === 2 ? 'Correcta' : annotation.rating.correctness === 1 ? 'Parcial' : 'Incorrecta'}</dd><dt>Afirmaciones sin respaldo</dt><dd>{{yes:'Sí',no:'No',uncertain:'No determinado'}[annotation.rating.unsupported]}</dd><dt>Citas</dt><dd>{{supported:'Respaldan la respuesta',partial:'Respaldo parcial',unsupported:'Sin respaldo',not_applicable:'No aplica'}[annotation.rating.citations]}</dd><dt>Abstención</dt><dd>{{justified:'Justificada',unjustified:'Debió responder',not_applicable:'No aplica'}[annotation.rating.abstention]}</dd>{annotation.rating.comment && <><dt>Comentario</dt><dd>{annotation.rating.comment}</dd></>}{annotation.rating.issue && <><dt>Incidencia</dt><dd>{annotation.rating.issue}</dd></>}</dl> : <p className="source-answer">{annotation.unanswerable ? 'Sin respuesta en el documento.' : annotation.answer}</p>}<EvidenceGroups sets={annotation.evidenceSets} onJump={onJump} />{annotation.note && <p className="subtle">{annotation.note}</p>}{onUse && <button type="button" className="button small secondary" onClick={onUse}>Usar esta versión</button>}</div></details>;
}

export default function TaskEditor({ view, participant, onReload, onUpdated, registerFlush, onLeave }: {
  view: TaskView; participant: Participant; onReload: () => Promise<void>; onUpdated: (view: TaskView) => void; registerFlush: (flush: (() => Promise<void>) | null) => void; onLeave: () => Promise<boolean>;
}) {
  const editor = useDraft(view, participant);
  const { draft, update, editable } = editor;
  const [activeSet, setActiveSet] = useState(0);
  const [jump, setJump] = useState<Jump>();
  const [mobileTab, setMobileTab] = useState<'document' | 'annotation'>('annotation');
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');
  const [error, setError] = useState('');
  const [verdictNote, setVerdictNote] = useState('');
  const [selfReviewConfirmed, setSelfReviewConfirmed] = useState(false);
  const positions = useRef({ document: 0, annotation: 0 });
  const submitting = useRef(false);
  const isEvaluation = !!view.answer || view.task.kind === 'evaluate';
  const singleAuthor = view.annotationMode === 'single_annotator' && view.task.kind === 'author';
  const awaitingSelfReview = singleAuthor && view.task.status === 'submitted' && !view.selfReview;
  const busy = pending || leaving;
  const allEvidence = [...draft.evidenceSets.flat(), ...(view.reference?.evidenceSets.flat() ?? [])];
  useEffect(() => { registerFlush(editor.flush); return () => registerFlush(null); }, [editor.flush, registerFlush]);
  function switchTab(tab: typeof mobileTab) {
    positions.current[mobileTab] = window.scrollY; setMobileTab(tab);
    requestAnimationFrame(() => window.scrollTo({ top: positions.current[tab], behavior: 'instant' }));
  }
  function goToSpan(span: EvidenceSpan) { positions.current[mobileTab] = window.scrollY; setMobileTab('document'); setJump({ blockId: span.blockId, serial: Date.now() }); }
  function addEvidence(spans: EvidenceSpan[]) {
    if (!editable || isEvaluation || busy || draft.unanswerable) return;
    update(current => {
      const sets = current.evidenceSets.length ? current.evidenceSets.map(set => [...set]) : [[]];
      const index = Math.min(activeSet, sets.length - 1);
      for (const span of spans) if (!sets[index].some(existing => existing.blockId === span.blockId && existing.start === span.start && existing.end === span.end)) sets[index].push(span);
      sets[index].sort((a, b) => a.start - b.start);
      return { ...current, evidenceSets: sets };
    });
  }
  function setRating<K extends keyof AnswerRating>(key: K, value: AnswerRating[K]) {
    if (draft.rating) update({ ...draft, rating: { ...draft.rating, [key]: value } });
  }
  async function submit() {
    if (submitting.current) return;
    setError('');
    if (isEvaluation && draft.rating?.correctness == null && !draft.rating?.issue.trim()) { setError('Valora la corrección o registra una incidencia que impida evaluarla.'); return; }
    if (!isEvaluation && (!draft.question.trim() || (!draft.unanswerable && (!draft.answer.trim() || !draft.evidenceSets.some(set => set.length))))) { setError('Completa la pregunta, la respuesta y al menos un conjunto de evidencia.'); return; }
    if (!isEvaluation && !draft.unanswerable && draft.evidenceSets.some(set => !set.length)) { setError('Completa o elimina los conjuntos de evidencia vacíos.'); return; }
    if (view.task.kind === 'adjudicate' && !draft.note?.trim()) { setError('Añade el motivo de la decisión.'); return; }
    submitting.current = true; setPending(true);
    try { onUpdated(await editor.submit()); } catch (error) { setError(errorMessage(error)); }
    finally { submitting.current = false; setPending(false); }
  }
  async function verdict(value: 'agree' | 'disagree') {
    if (value === 'disagree' && !verdictNote.trim()) { setError('Describe el desacuerdo.'); return; }
    setPending(true); setError('');
    try { onUpdated(await api<TaskView>(`/tasks/${view.task.id}/verdict`, 'POST', { verdict: value, note: verdictNote })); }
    catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }
  async function leave() {
    if (busy) return;
    setLeaving(true); setLeaveError('');
    try {
      if (!await onLeave()) setLeaveError('No se pudo guardar. La tarea sigue abierta; reintenta cuando se resuelva el error.');
    } catch (error) { setLeaveError(errorMessage(error)); }
    finally { setLeaving(false); }
  }
  async function confirmSelfReview() {
    if (busy || !selfReviewConfirmed || !awaitingSelfReview) return;
    setPending(true); setError('');
    try { onUpdated(await api<TaskView>(`/tasks/${view.task.id}/self-review`, 'POST', { revision: view.task.revision, confirmed: true })); }
    catch (error) { setError(errorMessage(error)); } finally { setPending(false); }
  }

  return <>
    <header className="task-heading"><div><span className="eyebrow">{kindLabels[view.task.kind]}{singleAuthor ? ' · Un anotador' : ''}</span><h1>{view.task.title}</h1><span className="subtle">{awaitingSelfReview ? 'Pendiente de revisión personal' : statusLabels[view.task.status]}</span></div><div className="save-indicator" role="status">{editable ? editor.online ? savedLabels[editor.saveState] : 'Sin conexión · copia local' : 'Solo lectura'}</div></header>
    <TaskGuide kind={view.task.kind} evaluation={isEvaluation} comparing={!!view.comparison} singleAuthor={singleAuthor} awaitingSelfReview={awaitingSelfReview} selfReviewed={!!view.selfReview} />
    <div className="mobile-tabs" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'document' : event.key === 'End' ? 'annotation' : mobileTab === 'document' ? 'annotation' : 'document'; const list = event.currentTarget; switchTab(next); requestAnimationFrame(() => list.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })); }} role="tablist" aria-label="Vista de la tarea"><button role="tab" tabIndex={mobileTab === 'document' ? 0 : -1} aria-selected={mobileTab === 'document'} aria-controls="document-panel" onClick={() => switchTab('document')}>Documento</button><button role="tab" tabIndex={mobileTab === 'annotation' ? 0 : -1} aria-selected={mobileTab === 'annotation'} aria-controls="annotation-panel" onClick={() => switchTab('annotation')}>{isEvaluation ? 'Evaluación' : 'Anotación'}</button></div>
    {editor.recovered && editable && <p className="message">Borrador recuperado de este dispositivo.</p>}
    {['error', 'conflict', 'offline'].includes(editor.saveState) && <div className="message error" role="alert"><p>{editor.saveError || 'El borrador se conserva en este dispositivo.'}</p><div className="row wrap"><button type="button" className="text-button" onClick={editor.download}>Descargar mi borrador</button>{editor.saveState === 'conflict' ? <button type="button" className="text-button" onClick={() => { editor.archiveBeforeReload(); void onReload(); }}>Recargar versión guardada</button> : <button type="button" className="text-button" disabled={!editor.online} onClick={() => void editor.flush().catch(() => {})}>Reintentar guardado</button>}</div></div>}
    {error && <p className="message error" role="alert">{error}</p>}
    <div className="editor-grid">
      <div id="document-panel" className={`document-panel ${mobileTab === 'document' ? 'mobile-active' : ''}`}><DocumentReader document={view.document} evidence={allEvidence} editable={editable && !isEvaluation && !busy && !draft.unanswerable} onAdd={addEvidence} jump={jump} /></div>
      <section id="annotation-panel" className={`annotation-panel ${mobileTab === 'annotation' ? 'mobile-active' : ''}`} aria-label={isEvaluation ? 'Evaluación de respuesta' : 'Formulario de anotación'}>
        {view.adjudication && <section className="card comparisons"><h2>Versiones a resolver</h2>{view.adjudication.map((item, index) => <AnnotationPreview key={index} title={item.label} annotation={item.annotation} onJump={goToSpan} onUse={editable ? () => update({ ...structuredClone(item.annotation), note: draft.note }) : undefined} />)}</section>}
        <section className="card form-card">
          <div className="field"><label htmlFor="question">Pregunta</label>{view.task.kind === 'author' ? <textarea id="question" rows={3} value={draft.question} maxLength={4000} disabled={!editable || busy} onChange={event => update({ ...draft, question: event.target.value })} /> : <p id="question" className="fixed-question">{view.question ?? draft.question}</p>}</div>
          {!isEvaluation && <>
            <div className="field"><label htmlFor="question-type">Tipo</label><select id="question-type" value={draft.questionType} disabled={!editable || busy || view.task.kind !== 'author' || !!view.task.assignedQuestionType} aria-describedby={view.task.assignedQuestionType ? 'assigned-type-help' : undefined} onChange={event => update({ ...draft, questionType: event.target.value as AnnotationDraft['questionType'] })}>{Object.entries(questionTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{view.task.assignedQuestionType && <p id="assigned-type-help" className="field-help">Tipo asignado. Escribe una pregunta propia; no copies los ejercicios del libro. Usa evidencia textual, no información exclusivamente visual.</p>}</div>
            <label className="checkbox"><input type="checkbox" checked={draft.unanswerable ?? false} disabled={!editable || busy} onChange={event => update({ ...draft, unanswerable: event.target.checked, answer: event.target.checked ? '' : draft.answer, evidenceSets: event.target.checked ? [] : [[]] })} />Sin respuesta en el documento</label>
            {!draft.unanswerable && <><div className="field"><label htmlFor="answer">{view.task.kind === 'review' ? 'Tu respuesta independiente' : 'Respuesta de referencia'}</label><textarea id="answer" rows={6} value={draft.answer} disabled={!editable || busy} onChange={event => update({ ...draft, answer: event.target.value })} /></div>
            <div className="field"><label>Evidencia</label>{editable && <p className="field-help">Cada conjunto debe ser suficiente por sí solo. Sus fragmentos se utilizan juntos.</p>}<EvidenceGroups sets={draft.evidenceSets} activeSet={activeSet} onActive={setActiveSet} onChange={sets => update({ ...draft, evidenceSets: sets })} onJump={goToSpan} editable={editable && !busy} /></div></>}
            <div className="field"><label htmlFor="annotation-note">{view.task.kind === 'adjudicate' ? 'Motivo de la decisión' : 'Nota (opcional)'}</label><textarea id="annotation-note" rows={3} value={draft.note ?? ''} disabled={!editable || busy} onChange={event => update({ ...draft, note: event.target.value })} /></div>
          </>}
          {isEvaluation && <>
            {view.reference && <details className="reference-answer"><summary>Respuesta de referencia y evidencia</summary><p className="source-answer">{view.reference.answer || 'Sin respuesta en el documento.'}</p><EvidenceGroups sets={view.reference.evidenceSets} onJump={goToSpan} /></details>}
            <div className="anonymous-answer"><h2>Respuesta a evaluar</h2><p>{view.answer?.text || 'Sin respuesta.'}</p>{view.answer?.citations.length ? <details><summary>Citas</summary>{view.answer.citations.map((citation, index) => <div key={index} className="citation"><strong>{citation.label}</strong>{citation.spans.map((span, i) => <button type="button" key={i} className="evidence-quote" onClick={() => goToSpan(span)}>{span.quote}<span>Ver origen ↗</span></button>)}</div>)}</details> : <span className="subtle">Sin citas</span>}</div>
            <fieldset className="rating-fieldset" disabled={!editable || busy}><legend>Corrección</legend><div className="radio-cards">{[{ value: 0, label: 'Incorrecta' }, { value: 1, label: 'Parcial' }, { value: 2, label: 'Correcta' }, { value: null, label: 'Sin valoración' }].map(item => <label key={String(item.value)}><input type="radio" name="correctness" checked={draft.rating?.correctness === item.value} onChange={() => setRating('correctness', item.value as 0 | 1 | 2 | null)} /><span>{item.label}</span></label>)}</div></fieldset>
            <div className="field"><label htmlFor="unsupported">¿Contiene afirmaciones sin respaldo?</label><select id="unsupported" value={draft.rating?.unsupported} disabled={!editable || busy} onChange={event => setRating('unsupported', event.target.value as AnswerRating['unsupported'])}><option value="uncertain">No puedo determinarlo</option><option value="no">No</option><option value="yes">Sí</option></select></div>
            <div className="field"><label htmlFor="citations">Apoyo de las citas</label><select id="citations" value={draft.rating?.citations} disabled={!editable || busy} onChange={event => setRating('citations', event.target.value as AnswerRating['citations'])}><option value="not_applicable">No aplica</option><option value="supported">Respaldan la respuesta</option><option value="partial">Respaldo parcial</option><option value="unsupported">No la respaldan</option></select></div>
            <div className="field"><label htmlFor="abstention">Si se abstiene de responder</label><select id="abstention" value={draft.rating?.abstention} disabled={!editable || busy} onChange={event => setRating('abstention', event.target.value as AnswerRating['abstention'])}><option value="not_applicable">No aplica</option><option value="justified">Abstención justificada</option><option value="unjustified">Debió responder</option></select></div>
            <div className="field"><label htmlFor="rating-comment">Comentario (opcional)</label><textarea id="rating-comment" rows={3} value={draft.rating?.comment ?? ''} disabled={!editable || busy} onChange={event => setRating('comment', event.target.value)} /></div>
            <div className="field"><label htmlFor="rating-issue">Incidencia de la pregunta o referencia (opcional)</label><textarea id="rating-issue" rows={2} value={draft.rating?.issue ?? ''} disabled={!editable || busy} onChange={event => setRating('issue', event.target.value)} /></div>
          </>}
          {isEvaluation && view.task.kind === 'adjudicate' && <div className="field"><label htmlFor="adjudication-note">Motivo de la decisión</label><textarea id="adjudication-note" rows={3} value={draft.note ?? ''} disabled={!editable || busy} onChange={event => update({ ...draft, note: event.target.value })} /></div>}
          {awaitingSelfReview && <section className="self-review" aria-labelledby="self-review-title"><h2 id="self-review-title">Revisión personal</h2>
            <ul><li>La pregunta es clara y se entiende por sí sola.</li><li>{draft.unanswerable ? 'Comprobé que el documento no contiene una respuesta.' : 'La respuesta contesta la pregunta y coincide con el documento.'}</li><li>{draft.unanswerable ? 'No añadí una respuesta ni evidencia inventadas.' : 'Cada conjunto de evidencia basta por sí solo y contiene sólo lo necesario.'}</li></ul>
            {view.task.assigneeId === participant.id ? <><label className="checkbox"><input type="checkbox" checked={selfReviewConfirmed} onChange={event => setSelfReviewConfirmed(event.target.checked)} disabled={busy} />Revisé pregunta, respuesta y evidencia con el documento</label><button type="button" className="button primary" disabled={busy || !selfReviewConfirmed || !editor.online} onClick={() => void confirmSelfReview()}>{pending ? 'Confirmando…' : 'Confirmar revisión'}</button></> : <p className="field-help">La revisión debe confirmarla la misma persona autora.</p>}
            <p className="field-help">Si encuentras un error, coordinación puede asignar una corrección antes de confirmar.</p>
          </section>}
          {singleAuthor && view.selfReview && <p className="message" role="status">Revisión personal confirmada. Esta pregunta puede incluirse en una versión congelada.</p>}
          <div className="form-footer">
            {editable && <button type="button" className="button primary" disabled={busy || !editor.online || editor.saveState === 'conflict'} onClick={() => void submit()}>{pending ? 'Enviando…' : view.task.kind === 'review' ? 'Enviar revisión independiente' : 'Enviar'}</button>}
            <button type="button" className="button secondary" disabled={busy} onClick={() => void leave()}>{leaving ? 'Guardando…' : editable ? 'Guardar y salir' : 'Volver a Mis tareas'}</button>
            {editable && <span className="subtle">{singleAuthor ? 'Para pausar, guarda y sal. Después de enviar, confirma tu revisión personal.' : 'Para pausar, guarda y sal. Enviar fija tu versión.'}</span>}
          </div>
          {leaveError && <p className="leave-error" role="alert">{leaveError}</p>}
        </section>
        {view.comparison && <section className="card comparisons"><h2>Comparación de anotaciones</h2><AnnotationPreview title="Anotación original" annotation={view.comparison.original} onJump={goToSpan} /><AnnotationPreview title="Tu revisión independiente" annotation={view.comparison.independent} onJump={goToSpan} />{view.comparison.verdict ? <p className="message">{view.comparison.verdict === 'agree' ? 'Anotación aceptada.' : 'Desacuerdo enviado a coordinación.'}{view.comparison.note ? ` ${view.comparison.note}` : ''}</p> : <><div className="field"><label htmlFor="verdict-note">Observación</label><textarea id="verdict-note" rows={3} value={verdictNote} onChange={event => setVerdictNote(event.target.value)} /></div><div className="row wrap"><button type="button" className="button primary" disabled={busy} onClick={() => void verdict('agree')}>Aceptar anotación</button><button type="button" className="button secondary" disabled={busy} onClick={() => void verdict('disagree')}>Enviar desacuerdo</button></div></>}</section>}
      </section>
    </div>
  </>;
}
