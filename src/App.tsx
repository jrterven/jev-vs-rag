import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Decimal from 'decimal.js';
import type {
  Block, Chunk, Comparison, CostSummary, DocumentRecord, Engine, EngineRun, Hit,
  Job, Overview, Progress, PublicConfig, Rating,
} from '../shared/types';
import { api, json } from './api';
import { active, date, elapsed, money, number, statusLabel, sumCosts } from './format';

const engines: Engine[] = ['jev', 'rag'];
const engineName = { jev: 'Jev', rag: 'RAG' };
const ratingLabels: Record<Rating['value'], string> = { useful: 'Útil', partial: 'Parcial', irrelevant: 'No útil' };
const reference = (refs: Hit['references']) => {
  const pages = [...new Set(refs.flatMap(ref => ref.page === undefined ? [] : [ref.page]))];
  if (pages.length) return `Pág. ${pages.join(', ')}`;
  const paragraphs = [...new Set(refs.map(ref => ref.paragraph))];
  return `Párr. ${paragraphs.slice(0, 4).join(', ')}${paragraphs.length > 4 ? '…' : ''}`;
};

function Icon({ name }: { name: 'upload' | 'search' | 'close' | 'arrow' | 'file' }) {
  const paths = {
    upload: <><path d="M12 16V4m-4 4 4-4 4 4" /><path d="M4 15v5h16v-5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    file: <><path d="M14 3H5v18h14V8zM14 3v5h5" /><path d="M8 12h8m-8 4h6" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Cost({ cost }: { cost?: CostSummary }) {
  if (!cost) return <span>—</span>;
  return <span>{money(cost.knownUsd)}{cost.unknownAttempts > 0 && <span className="incomplete" title={`${cost.unknownAttempts} llamadas sin costo confirmado`}> + desconocido</span>}</span>;
}

function ProgressLine({ progress, status }: { progress: Progress; status?: string }) {
  return <div className="progress-line" role="status">
    <span className="activity-dot" aria-hidden="true" />
    <span>{progress.phase || status || 'Procesando'}{progress.total > 0 && <> · {number(progress.current)}/{number(progress.total)}</>}</span>
    {progress.total > 0 && <progress value={progress.current} max={progress.total} aria-label={progress.phase || 'Progreso'} />}
  </div>;
}

function Fold({ title, meta, children, onToggle }: { title: string; meta?: ReactNode; children: ReactNode; onToggle?: (open: boolean) => void }) {
  return <details className="fold" onToggle={event => onToggle?.(event.currentTarget.open)}>
    <summary><span>{title}</span><span className="fold-meta">{meta}</span><span className="chevron" aria-hidden="true" /></summary>
    <div className="fold-body">{children}</div>
  </details>;
}

function ResultCard({ run, overview, comparison, engine, onContext, onRating }: {
  run?: EngineRun; overview: Overview | null; comparison?: Comparison; engine: Engine;
  onContext: (hit: Hit) => void; onRating: (rating: Rating) => void;
}) {
  const preparation = overview?.document.engines[engine];
  const busy = active(run?.status);
  return <section className="engine-card" aria-labelledby={`title-${engine}`} aria-busy={busy}>
    <div className="engine-heading">
      <div><h2 id={`title-${engine}`}>{engineName[engine]}</h2><span className="engine-subtitle">{engine === 'jev' ? 'Búsqueda por estructura' : 'Búsqueda vectorial'}</span></div>
      {run && <span className={`status ${run.status}`}>{statusLabel[run.status]}</span>}
    </div>
    <div className="metrics">
      <div><span className="metric-label">Tiempo</span><strong>{elapsed(run?.elapsedMs)}</strong></div>
      <div><span className="metric-label">Costo · USD</span><strong><Cost cost={run?.cost} /></strong></div>
      <div><span className="metric-label">Resultados</span><strong>{run ? run.hits.length : '—'}</strong></div>
    </div>
    {busy && run && <ProgressLine progress={run.progress} />}
    {!run && preparation && active(preparation.status) && <ProgressLine progress={preparation.progress} />}
    {run?.error && <p className="inline-error" role="alert">{run.error}</p>}
    {!run && preparation?.error && <p className="inline-error">{preparation.error}</p>}
    {run && run.metrics.windowsTotal > 0 && run.metrics.windowsCompleted < run.metrics.windowsTotal && !busy && <p className="inline-error">Cobertura incompleta · {run.metrics.windowsCompleted}/{run.metrics.windowsTotal} ventanas</p>}
    {run?.existence !== undefined && <p className="existence">Señal de respuesta: {(run.existence * 100).toFixed(1)} % <span>{run.existenceScope === 'finalists' ? 'en los fragmentos finalistas' : 'en el documento'}</span></p>}
    {run?.hits.length ? <ol className="results">{run.hits.map((hit, index) => {
      const rating = overview?.ratings.find(item => item.runId === run.id && item.chunkId === hit.chunkId);
      return <li key={hit.chunkId} className="result">
        <div className="result-top"><span className="rank">{String(index + 1).padStart(2, '0')}</span><button type="button" className="reference-button" onClick={() => onContext(hit)}>{reference(hit.references)} <Icon name="arrow" /></button></div>
        {hit.path.length > 0 && <p className="section-path" title={hit.path.join(' / ')}>{hit.path.join(' / ')}</p>}
        <p className="hit-text">{hit.text}</p>
        <div className="result-bottom">
          <div className="rating-group" role="group" aria-label={`Valorar resultado ${index + 1} de ${engineName[engine]}`}>
            {(Object.keys(ratingLabels) as Rating['value'][]).map(value => <button type="button" key={value} aria-pressed={rating?.value === value} onClick={() => comparison && onRating({ comparisonId: comparison.id, runId: run.id, chunkId: hit.chunkId, value })}>{ratingLabels[value]}</button>)}
          </div>
          <details className="score"><summary>Puntuación</summary><span>{hit.scoreKind === 'choice_probability' ? 'Probabilidad Choice' : 'Similitud coseno'}: {hit.score.toFixed(5)}</span></details>
        </div>
      </li>;
    })}</ol> : <div className="empty-results"><Icon name="search" /><p>{busy ? 'Buscando' : run?.status === 'completed' ? 'Sin resultados' : !overview ? 'Carga un documento' : preparation?.status === 'completed' ? 'Sin consulta' : active(preparation?.status) ? 'Preparando documento' : 'Preparación pendiente'}</p></div>}
    {run && <details className="run-details"><summary>Detalles de la ejecución</summary><dl className="compact-dl">
      <div><dt>Modelo</dt><dd>{run.model}</dd></div>
      <div><dt>Llamadas</dt><dd>{number(run.cost.calls)}</dd></div>
      <div><dt>Tokens de entrada</dt><dd>{number(run.cost.inputTokens)}</dd></div>
      <div><dt>Concurrencia</dt><dd>{run.metrics.concurrency}</dd></div>
      {engine === 'jev' && <><div><dt>Ventanas</dt><dd>{run.metrics.windowsCompleted}/{run.metrics.windowsTotal}</dd></div><div><dt>Fragmentos evaluados</dt><dd>{run.metrics.chunksCovered}/{run.metrics.chunksTotal}</dd></div><div><dt>Fases de reducción</dt><dd>{run.metrics.reductionLevels}</dd></div></>}
      {engine === 'rag' && <><div><dt>Embedding de consulta</dt><dd>{elapsed(run.metrics.embeddingMs)}</dd></div><div><dt>Búsqueda local</dt><dd>{elapsed(run.metrics.searchMs)}</dd></div></>}
    </dl></details>}
  </section>;
}

function Benchmark({ comparison }: { comparison: Comparison }) {
  return <div className="benchmark-summary"><div className="section-header"><h3>5 repeticiones</h3><span className="muted">Sin caché de consultas</span></div>
    <div className="table-wrap"><table><thead><tr><th>Método</th><th>Mediana</th><th>Mín.</th><th>Máx.</th><th>Fallos</th><th>Costo · USD</th></tr></thead><tbody>{engines.map(engine => {
      const runs = comparison.runs.filter(run => run.engine === engine);
      const times = runs.filter(run => run.status === 'completed' && run.elapsedMs !== undefined).map(run => run.elapsedMs!).sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      const median = times.length ? times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 : undefined;
      return <tr key={engine}><th>{engineName[engine]}</th><td>{elapsed(median)}</td><td>{elapsed(times[0])}</td><td>{elapsed(times.at(-1))}</td><td>{runs.filter(run => ['failed', 'cancelled', 'interrupted'].includes(run.status)).length}</td><td><Cost cost={sumCosts(runs.map(run => run.cost))} /></td></tr>;
    })}</tbody></table></div>
  </div>;
}

function CostPanel({ overview, config, comparison }: { overview: Overview; config: PublicConfig | null; comparison?: Comparison }) {
  const lastSingle = overview.comparisons.find(item => item.rounds === 1);
  const lastBenchmark = overview.comparisons.find(item => item.rounds === 5);
  return <Fold title="Costos" meta="USD"><div className="table-wrap"><table><thead><tr><th>Uso</th><th>Jev</th><th>RAG</th></tr></thead><tbody>
    <tr><th>Preparación</th>{engines.map(engine => <td key={engine}><Cost cost={overview.costs[engine].preparation} /></td>)}</tr>
    <tr><th>Última consulta</th>{engines.map(engine => <td key={engine}><Cost cost={lastSingle?.runs.find(run => run.engine === engine)?.cost} /></td>)}</tr>
    <tr><th>Últimas 5 repeticiones</th>{engines.map(engine => <td key={engine}><Cost cost={lastBenchmark ? sumCosts(lastBenchmark.runs.filter(run => run.engine === engine).map(run => run.cost)) : undefined} /></td>)}</tr>
    <tr className="total-row"><th>Acumulado del documento</th>{engines.map(engine => <td key={engine}><Cost cost={overview.costs[engine].total} /></td>)}</tr>
    <tr><th>Llamadas / tokens</th>{engines.map(engine => <td key={engine}>{number(overview.costs[engine].total.calls)} / {number(overview.costs[engine].total.inputTokens)}</td>)}</tr>
  </tbody></table></div>
    <div className="section-header spaced"><h3>Proyección</h3><span className="muted">Preparación + consultas similares</span></div>
    <div className="table-wrap"><table><thead><tr><th>Consultas</th><th>Jev · total / consulta</th><th>RAG · total / consulta</th></tr></thead><tbody>{[100, 1000].map(count => <tr key={count}><th>{number(count)}</th>{engines.map(engine => {
      const projection = overview.costs[engine].projections.find(item => item.queries === count);
      return <td key={engine}>{projection ? <>{money(projection.totalUsd)} / {money(projection.amortizedUsd)}</> : 'Pendiente'}</td>;
    })}</tr>)}<tr><th>Muestra completa</th>{engines.map(engine => <td key={engine}>{number(overview.costs[engine].sampleSize)} consultas</td>)}</tr></tbody></table></div>
    {config && <div className="rates">{engines.map(engine => <p key={engine}><strong>{engineName[engine]}</strong> · {config.rates[engine].usdPerMillion === null ? 'Tarifa no configurada' : `${money(config.rates[engine].usdPerMillion)} / millón de tokens`} · <a href={config.rates[engine].source} target="_blank" rel="noreferrer">{config.rates[engine].date}</a></p>)}</div>}
    <p className="footnote">Estimaciones de API según consumo reportado. Recursos locales sin valorar. Sin impuestos, créditos ni descuentos. Tarifas históricas conservadas.</p>
    {comparison && <a className="text-link export" href={`/api/documents/${overview.document.id}/export`} download>Exportar registros JSON</a>}
  </Fold>;
}

export default function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [comparisonId, setComparisonId] = useState('');
  const [round, setRound] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [structureOpen, setStructureOpen] = useState(false);
  const [structurePage, setStructurePage] = useState(0);
  const [structure, setStructure] = useState<{ blocks: Block[]; total: number } | null>(null);
  const [structureLoading, setStructureLoading] = useState(false);
  const [context, setContext] = useState<{ chunk: Chunk; blocks: Block[] } | null>(null);
  const [contextError, setContextError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const isBusy = !!overview?.jobs.some(job => active(job.status));
  const activeJobs = overview?.jobs.filter(job => active(job.status)) ?? [];
  const comparison = overview?.comparisons.find(item => item.id === comparisonId) ?? overview?.comparisons[0];
  const selectedRound = round ?? Math.max(1, ...(comparison?.runs.filter(run => run.status !== 'queued').map(run => run.round) ?? [1]));
  const ready = !!overview && engines.some(engine => overview.document.engines[engine].status === 'completed');

  useEffect(() => {
    let disposed = false;
    Promise.all([api<PublicConfig>('/api/config'), api<DocumentRecord[]>('/api/documents')]).then(([configuration, docs]) => {
      if (disposed) return;
      setConfig(configuration); setDocuments(docs);
      if (docs.length) setSelectedId(docs[0].id);
    }).catch(error => !disposed && setError(error.message)).finally(() => !disposed && setLoading(false));
    return () => { disposed = true; };
  }, []);

  const refresh = useCallback(async (id: string) => {
    const result = await api<Overview>(`/api/documents/${id}`);
    if (selectedRef.current === id) {
      setOverview(result);
      setDocuments(current => current.map(doc => doc.id === id ? result.document : doc));
    }
    return result;
  }, []);

  useEffect(() => {
    setOverview(null); setComparisonId(''); setRound(null); setQuery(''); setStructure(null); setStructurePage(0);
    if (!selectedId) return;
    const controller = new AbortController();
    setLoading(true);
    api<Overview>(`/api/documents/${selectedId}`, { signal: controller.signal }).then(result => {
      setOverview(result);
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !isBusy) return;
    let fetching = false;
    const timer = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try { await refresh(selectedId); } catch (error) { setError((error as Error).message); }
      finally { fetching = false; }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedId, isBusy, refresh]);

  const structureStatus = overview?.document.engines.jev.status;
  useEffect(() => {
    if (!selectedId || !structureOpen || !overview?.document.extractionComplete) return;
    const controller = new AbortController();
    setStructureLoading(true);
    api<{ blocks: Block[]; total: number }>(`/api/documents/${selectedId}/structure?offset=${structurePage * 100}&limit=100`, { signal: controller.signal }).then(setStructure).catch(error => { if (error.name !== 'AbortError') setError(error.message); }).finally(() => { if (!controller.signal.aborted) setStructureLoading(false); });
    return () => controller.abort();
  }, [selectedId, structureOpen, structurePage, structureStatus, overview?.document.extractionComplete]);

  async function upload(file?: File) {
    if (!file) return;
    if (config && file.size > config.limits.maxFileMb * 1024 * 1024) { setError(`El archivo supera ${config.limits.maxFileMb} MB.`); return; }
    setPending(true); setUploading(true); setError('');
    const body = new FormData(); body.append('file', file);
    try {
      const doc = await api<DocumentRecord>('/api/documents', { method: 'POST', body });
      setDocuments(current => [doc, ...current.filter(item => item.id !== doc.id)]);
      if (selectedId === doc.id) await refresh(doc.id); else setSelectedId(doc.id);
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function search(rounds: 1 | 5) {
    if (!selectedId || !query.trim()) return;
    const id = selectedId;
    setPending(true); setError(''); setRound(null);
    try {
      const result = await api<{ job: Job; comparison: Comparison }>(`/api/documents/${id}/search`, json('POST', { query: query.trim(), rounds }));
      if (selectedRef.current === id) setComparisonId(result.comparison.id);
      await refresh(id);
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  async function action(callback: () => Promise<unknown>) {
    setPending(true); setError('');
    try { await callback(); if (selectedRef.current) await refresh(selectedRef.current); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  async function rate(rating: Rating) {
    try {
      const saved = await api<Rating>('/api/ratings', json('PUT', rating));
      setOverview(current => current && current.document.id === selectedRef.current ? { ...current, ratings: [...current.ratings.filter(item => !(item.runId === saved.runId && item.chunkId === saved.chunkId)), saved] } : current);
    } catch (error) { setError((error as Error).message); }
  }

  async function openContext(hit: Hit) {
    setContext(null); setContextError(''); dialog.current?.showModal();
    try { setContext(await api<{ chunk: Chunk; blocks: Block[] }>(`/api/documents/${selectedId}/chunks/${encodeURIComponent(hit.chunkId)}`)); }
    catch (error) { setContextError((error as Error).message); }
  }

  async function removeDocument() {
    if (!overview || !window.confirm(`Eliminar “${overview.document.name}” y sus datos locales?`)) return;
    const id = selectedId;
    setPending(true); setError('');
    try {
      await api(`/api/documents/${id}`, { method: 'DELETE' });
      const remaining = documents.filter(doc => doc.id !== id);
      setDocuments(remaining); setSelectedId(remaining[0]?.id ?? '');
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  const estimateSource = overview?.comparisons.find(item => item.query === query.trim() && item.runs.some(run => run.status === 'completed') && engines.every(engine => item.runs.some(run => run.engine === engine && run.status === 'completed' && run.cost.unknownAttempts === 0)));
  const benchmarkEstimate = estimateSource ? money(engines.reduce((total, engine) => {
    const runs = estimateSource.runs.filter(run => run.engine === engine && run.status === 'completed' && run.cost.unknownAttempts === 0);
    return total.plus(new Decimal(sumCosts(runs.map(run => run.cost)).knownUsd).dividedBy(runs.length).times(5));
  }, new Decimal(0)).toString()) : undefined;

  return <div className="app-shell">
    <header className="app-header"><a className="wordmark" href="/">Jev <span>vs.</span> RAG</a><span className="local-label">Local</span></header>
    <main>
      {error && <div className="error-banner" role="alert"><p>{error}</p><button type="button" aria-label="Cerrar error" onClick={() => setError('')}><Icon name="close" /></button></div>}
      {config && engines.some(engine => !config.keys[engine]) && <div className="config-notice">Configura {engines.filter(engine => !config.keys[engine]).map(engine => engine === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY').join(' y ')} en <code>.env</code>.</div>}
      <section className="workspace-controls" aria-label="Documento y consulta">
        <div className="document-row"><div className="document-control"><label htmlFor="document-select">Documento</label><div className="select-wrap"><Icon name="file" /><select id="document-select" value={selectedId} disabled={pending || !documents.length} onChange={event => { setSelectedId(event.target.value); setError(''); }}><option value="" disabled>{loading ? 'Cargando…' : 'Sin documentos'}</option>{documents.map(doc => <option key={doc.id} value={doc.id}>{doc.name}</option>)}</select></div></div>
          <input ref={fileInput} className="visually-hidden" type="file" tabIndex={-1} accept=".pdf,.docx,.txt" aria-label="Subir documento" onChange={event => void upload(event.target.files?.[0])} />
          <button type="button" className="button secondary upload-button" disabled={pending} onClick={() => fileInput.current?.click()}><Icon name="upload" />{uploading ? 'Subiendo…' : 'Subir archivo'}</button>
        </div>
        <div className="document-meta">{overview ? <><span>{overview.document.format.toUpperCase()}</span><span>{number(overview.document.chunkCount)} fragmentos</span><span>{number(overview.document.tokenCount)} tokens estimados</span>{overview.document.pageCount > 0 && <span>{number(overview.document.pageCount)} páginas</span>}<span>{statusLabel[overview.document.status]}</span></> : <span>PDF, DOCX o TXT{config ? ` · hasta ${config.limits.maxFileMb} MB` : ''}</span>}</div>
        {overview?.document.error && <p className="inline-error">{overview.document.error}</p>}
        {overview?.document.warnings?.map(warning => <p className="footnote" key={warning}>{warning}</p>)}
        {overview && !overview.document.extractionComplete && active(overview.document.status) && <ProgressLine progress={activeJobs.find(job => job.kind === 'prepare')?.progress ?? { phase: 'Extrayendo texto', current: 0, total: 0 }} />}
        {overview && <div className="preparation-status">{engines.map(engine => <div key={engine}><span className="engine-label">{engineName[engine]}</span>{active(overview.document.engines[engine].status) ? <ProgressLine progress={overview.document.engines[engine].progress} /> : <span className="muted">{statusLabel[overview.document.engines[engine].status]}{overview.document.engines[engine].elapsedMs !== undefined ? ` · ${elapsed(overview.document.engines[engine].elapsedMs)}` : ''}</span>}</div>)}
          {!isBusy && engines.some(engine => ['failed', 'interrupted', 'cancelled'].includes(overview.document.engines[engine].status)) && <button type="button" className="text-button" disabled={pending} onClick={() => void action(() => api(`/api/documents/${selectedId}/resume`, json('POST')))}>Reanudar preparación</button>}
        </div>}
        <form className="search-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void search(1); }}><label className="visually-hidden" htmlFor="query">Consulta</label><div className="query-wrap"><Icon name="search" /><input id="query" maxLength={2000} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar en el documento" autoComplete="off" disabled={!overview} /></div><button type="submit" className="button primary" disabled={!ready || pending || isBusy || !query.trim()}>Buscar<Icon name="arrow" /></button></form>
        <div className="search-actions"><div><button type="button" className="text-button" disabled={!ready || pending || isBusy || !query.trim()} onClick={() => void search(5)}>Repetir cinco veces</button>{benchmarkEstimate && <span className="muted estimate">≈ {benchmarkEstimate} USD</span>}</div>{activeJobs.map(job => <button key={job.id} type="button" className="text-button" disabled={pending} onClick={() => void action(() => api(`/api/jobs/${job.id}/cancel`, json('POST')))}>Cancelar {job.kind === 'prepare' ? 'preparación' : 'búsqueda'}</button>)}</div>
      </section>
      {comparison && <div className="comparison-heading"><div><span className="eyebrow">Consulta</span><p>{comparison.query}</p></div>{comparison.rounds > 1 && <div className="rounds" role="group" aria-label="Repetición">{Array.from({ length: comparison.rounds }, (_, index) => index + 1).map(value => <button type="button" key={value} aria-label={`Repetición ${value}`} aria-pressed={selectedRound === value} onClick={() => setRound(value)}>{value}</button>)}</div>}</div>}
      <div className="comparison-grid">{engines.map(engine => <ResultCard key={engine} engine={engine} overview={overview} comparison={comparison} run={comparison?.runs.find(run => run.engine === engine && run.round === selectedRound)} onContext={hit => void openContext(hit)} onRating={rating => void rate(rating)} />)}</div>
      {comparison?.rounds === 5 && <Benchmark comparison={comparison} />}
      <div className="panels">
        {overview && <>
          <Fold title="Estructura" meta={`${number(overview.document.blockCount)} bloques`} onToggle={setStructureOpen}>
            {structureLoading ? <p className="muted" role="status">Cargando estructura…</p> : structure?.blocks.length ? <><ol className="structure-list">{structure.blocks.map(block => <li key={block.id} style={{ paddingLeft: `${Math.max(0, (block.level ?? 1) - 1) * 14}px` }} className={block.kind === 'heading' ? 'structure-heading' : ''}><details className="structure-block"><summary><span className="block-kind">{block.kind === 'heading' ? `H${block.level ?? 1}` : block.kind === 'table' ? 'Tabla' : block.kind === 'list' ? 'Lista' : block.kind === 'code' ? 'Código' : 'Texto'}</span><span className="block-preview" title={block.text}>{block.text}</span><span className="muted">{block.page ? `p. ${block.page}` : `¶ ${block.paragraph}`}</span></summary><p>{block.text}</p></details></li>)}</ol><div className="pagination"><button className="text-button" type="button" disabled={structurePage === 0} onClick={() => setStructurePage(page => page - 1)}>Anterior</button><span>{number(structurePage * 100 + 1)}–{number(Math.min((structurePage + 1) * 100, structure.total))} / {number(structure.total)}</span><button className="text-button" type="button" disabled={(structurePage + 1) * 100 >= structure.total} onClick={() => setStructurePage(page => page + 1)}>Siguiente</button></div></> : <p className="muted">Sin estructura disponible.</p>}
          </Fold>
          <CostPanel overview={overview} config={config} comparison={comparison} />
          <Fold title="Historial" meta={overview.comparisons.length ? `${overview.comparisons.length} consultas recientes` : undefined}>{overview.comparisons.length ? <ol className="history-list">{overview.comparisons.map(item => <li key={item.id}><button type="button" className={comparison?.id === item.id ? 'selected' : ''} onClick={() => { setComparisonId(item.id); setRound(null); setQuery(item.query); }}><span className="history-query">{item.query}</span><span className="muted">{date(item.createdAt)} · {item.rounds === 5 ? '5 repeticiones' : statusLabel[item.status]}</span></button></li>)}</ol> : <p className="muted">Sin consultas.</p>}</Fold>
        </>}
        <Fold title="Configuración">{config ? <><dl className="compact-dl config-grid">{engines.map(engine => <div key={engine}><dt>{engineName[engine]}</dt><dd>{config.models[engine]}<span className="key-status">{config.keys[engine] ? 'Clave configurada' : 'Falta API key'}</span></dd></div>)}<div><dt>Fragmentos / solapamiento</dt><dd>{config.chunkTokens} / {config.overlapTokens} tokens</dd></div><div><dt>Ventana de Jev</dt><dd>{number(config.jevWindowTokens)} tokens estimados</dd></div><div><dt>Concurrencia por proveedor</dt><dd>{config.concurrency}</dd></div><div><dt>Límites</dt><dd>{config.limits.maxFileMb} MB · {number(config.limits.maxTokens)} tokens · {number(config.limits.maxPdfPages)} páginas PDF</dd></div>{overview?.document.extractionMs !== undefined && <div><dt>Extracción común</dt><dd>{elapsed(overview.document.extractionMs)}</dd></div>}</dl><p className="footnote">Configuración en <code>.env</code>. Reinicia el servidor después de cambiarla.</p><button type="button" className="text-button" onClick={() => void api<PublicConfig>('/api/config').then(setConfig).catch(error => setError(error.message))}>Actualizar configuración</button></> : <p className="muted">Configuración no disponible.</p>}
          {overview && <div className="document-management"><button type="button" className="text-button" disabled={pending || isBusy} onClick={() => void action(() => api(`/api/documents/${selectedId}/resume`, json('POST')))}>Reprocesar preparación</button><a href={`/api/documents/${selectedId}/export`} download>Exportar documento y registros</a><button type="button" className="text-button" disabled={pending || isBusy} onClick={() => void removeDocument()}>Eliminar documento</button></div>}
        </Fold>
      </div>
    </main>
    <dialog ref={dialog} className="context-dialog" aria-labelledby="context-title" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}><div className="dialog-heading"><h2 id="context-title">Contexto</h2><button type="button" className="icon-button" aria-label="Cerrar contexto" onClick={() => dialog.current?.close()}><Icon name="close" /></button></div><div className="dialog-content">{contextError ? <p className="inline-error" role="alert">{contextError}</p> : context ? <><p className="muted">{reference(context.chunk.references)}{context.chunk.path.length ? ` · ${context.chunk.path.join(' / ')}` : ''}</p><div className="selected-excerpt"><span className="eyebrow">Fragmento recuperado</span><p>{context.chunk.text}</p></div>{context.blocks.length > 0 && <><h3>Texto de origen</h3>{context.blocks.map(block => <div key={block.id} className="context-block"><span className="muted">{block.page ? `Página ${block.page}` : `Párrafo ${block.paragraph}`}</span><p>{block.text}</p></div>)}</>}</> : <p className="muted" role="status">Cargando contexto…</p>}</div></dialog>
  </div>;
}
