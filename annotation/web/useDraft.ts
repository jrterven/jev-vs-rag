import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationDraft, Participant, TaskView } from '../shared/types';
import { api, ApiError, errorMessage, downloadJson } from './api';
import { saveLatestDraft } from './saveLatestDraft';

export function initialDraft(view: TaskView): AnnotationDraft {
  if (view.draft) return structuredClone(view.draft);
  const source = view.adjudication?.[0]?.annotation;
  return {
    question: view.question ?? source?.question ?? '', questionType: (view.task.kind === 'author' ? view.task.assignedQuestionType : undefined) ?? view.questionType ?? source?.questionType ?? 'factual',
    answer: source?.answer ?? '', evidenceSets: source?.evidenceSets ? structuredClone(source.evidenceSets) : [[]],
    unanswerable: source?.unanswerable ?? false,
    note: '',
    ...(view.answer || view.task.kind === 'evaluate' ? { rating: source?.rating ? structuredClone(source.rating) : { correctness: null, unsupported: 'uncertain', citations: 'not_applicable', abstention: 'not_applicable', comment: '', issue: '' } as const } : {}),
  };
}
interface Backup { hash: string; revision: number; draft: AnnotationDraft; savedAt: string }
export function useDraft(view: TaskView, participant: Participant) {
  const editable = view.task.status === 'assigned' || view.task.status === 'draft';
  const key = `annotation:draft:${participant.id}:${view.task.id}`;
  const canonical = initialDraft(view);
  const [draft, setDraftState] = useState<AnnotationDraft>(canonical);
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'offline' | 'error' | 'conflict'>('saved');
  const [saveError, setSaveError] = useState('');
  const [recovered, setRecovered] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const revision = useRef(view.task.revision);
  const current = useRef(draft);
  const lastSaved = useRef(JSON.stringify(canonical));
  const chain = useRef<Promise<void>>(Promise.resolve());
  const blocked = useRef(false);
  const submission = useRef<{ id: string; revision: number } | undefined>(undefined);
  const mounted = useRef(true);
  const editableRef = useRef(editable); editableRef.current = editable;

  function backup(value = current.current) {
    try { localStorage.setItem(key, JSON.stringify({ hash: view.document.hash, revision: revision.current, draft: value, savedAt: new Date().toISOString() } satisfies Backup)); }
    catch { /* The UI still reports server save failures when local storage is unavailable. */ }
  }

  useEffect(() => {
    mounted.current = true;
    if (editable) {
      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          const parsed = JSON.parse(stored) as Backup;
          if (parsed.hash === view.document.hash && parsed.draft && JSON.stringify(parsed.draft) !== lastSaved.current) {
            current.current = parsed.draft; setDraftState(parsed.draft); setRecovered(true);
            if (parsed.revision !== revision.current) {
              blocked.current = true; setSaveState('conflict'); setSaveError('La versión guardada cambió. Tu borrador local sigue disponible.');
            } else setSaveState('pending');
          }
        }
      } catch { /* An invalid local cache never replaces the authoritative draft. */ }
    }
    return () => { mounted.current = false; };
  }, []); // Remount the editor when the server version is explicitly reloaded.

  const flush = useCallback(async () => {
    const attempt = chain.current.catch(() => {}).then(async () => {
      await saveLatestDraft(() => {
        if (!editableRef.current) return null;
        if (blocked.current) throw new ApiError('Resuelve el conflicto antes de continuar.', 409);
        const serialized = JSON.stringify(current.current);
        return serialized === lastSaved.current ? null : serialized;
      }, async serialized => {
        if (!navigator.onLine) {
          backup(); if (mounted.current) setSaveState('offline'); throw new Error('Sin conexión. Conservamos el borrador local.');
        }
        if (mounted.current) { setSaveState('saving'); setSaveError(''); }
        try {
          const result = await api<{ revision: number }>(`/tasks/${view.task.id}/draft`, 'PUT', { revision: revision.current, draft: JSON.parse(serialized) });
          revision.current = result.revision; lastSaved.current = serialized; backup();
          if (mounted.current) setSaveState(JSON.stringify(current.current) === serialized ? 'saved' : 'pending');
        } catch (error) {
          backup();
          if (error instanceof ApiError && error.status === 409) blocked.current = true;
          if (mounted.current) { setSaveState(blocked.current ? 'conflict' : navigator.onLine ? 'error' : 'offline'); setSaveError(errorMessage(error)); }
          throw error;
        }
      });
    });
    chain.current = attempt;
    return attempt;
  }, [view.task.id, key]);

  function update(next: AnnotationDraft | ((old: AnnotationDraft) => AnnotationDraft)) {
    if (!editableRef.current) return;
    const value = typeof next === 'function' ? next(current.current) : next;
    current.current = value; setDraftState(value); backup(value);
    if (!blocked.current) setSaveState(navigator.onLine ? 'pending' : 'offline');
  }

  useEffect(() => {
    if (saveState !== 'pending' || !editable) return;
    const timeout = window.setTimeout(() => void flush().catch(() => {}), 700);
    return () => window.clearTimeout(timeout);
  }, [draft, saveState, editable, flush]);

  useEffect(() => {
    const onOnline = () => { setOnline(true); if (!blocked.current) void flush().catch(() => {}); };
    const onOffline = () => { setOnline(false); if (JSON.stringify(current.current) !== lastSaved.current && !blocked.current) setSaveState('offline'); };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (editableRef.current && JSON.stringify(current.current) !== lastSaved.current) { backup(); event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('beforeunload', onUnload); };
  }, [flush]);

  async function submit(): Promise<TaskView> {
    await flush();
    if (JSON.stringify(current.current) !== lastSaved.current) await flush();
    const submissionKey = `${key}:submission`;
    if (submission.current?.revision !== revision.current) submission.current = { id: crypto.randomUUID(), revision: revision.current };
    let submissionId = submission.current!.id;
    try {
      const previous = JSON.parse(localStorage.getItem(submissionKey) || 'null');
      if (previous?.revision === revision.current) submissionId = previous.id;
      submission.current = { id: submissionId, revision: revision.current };
      localStorage.setItem(submissionKey, JSON.stringify({ id: submissionId, revision: revision.current }));
    } catch { /* The in-memory request remains valid without local storage. */ }
    const result = await api<TaskView>(`/tasks/${view.task.id}/submit`, 'POST', { revision: revision.current, submissionId });
    editableRef.current = false;
    try { localStorage.removeItem(key); localStorage.removeItem(submissionKey); } catch { /* nonessential cleanup */ }
    return result;
  }

  function archiveBeforeReload() {
    try { localStorage.setItem(`${key}:recovered:${Date.now()}`, JSON.stringify({ hash: view.document.hash, revision: revision.current, draft: current.current, savedAt: new Date().toISOString() })); localStorage.removeItem(key); } catch { /* Download remains available. */ }
  }
  return { draft, update, flush, submit, saveState, saveError, recovered, online, editable,
    download: () => downloadJson(`borrador-${view.task.id}.json`, { taskId: view.task.id, hash: view.document.hash, revision: revision.current, draft: current.current }),
    archiveBeforeReload,
  };
}
