import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, EvidenceSpan, TextBlock } from '../shared/types';
import { api, errorMessage } from './api';

export interface Jump { blockId: string; serial: number }
function markedText(block: TextBlock, evidence: EvidenceSpan[]) {
  const intervals = evidence.filter(span => span.blockId === block.id).map(span => [Math.max(0, span.start - block.start), Math.min(block.text.length, span.end - block.start)]).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]); else merged.push([...interval]);
  }
  const parts: React.ReactNode[] = []; let start = 0;
  merged.forEach(([from, to], index) => { if (from > start) parts.push(block.text.slice(start, from)); parts.push(<mark key={`${block.id}-${index}`}>{block.text.slice(from, to)}</mark>); start = to; });
  if (start < block.text.length) parts.push(block.text.slice(start));
  return parts.length ? parts : block.text;
}

export default function DocumentReader({ document, evidence, onAdd, jump, editable }: {
  document: DocumentInfo; evidence: EvidenceSpan[]; onAdd: (spans: EvidenceSpan[]) => void; jump?: Jump; editable: boolean;
}) {
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Array<{ blockIndex: number; text: string }>>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<EvidenceSpan[]>([]);
  const [keyboardBlock, setKeyboardBlock] = useState('');
  const [firstWord, setFirstWord] = useState(1);
  const [lastWord, setLastWord] = useState(1);
  const [targetBlock, setTargetBlock] = useState<string>();
  const source = useRef<HTMLDivElement>(null);
  const block = blocks.find(item => item.id === keyboardBlock) ?? blocks[0];
  const words = block ? [...block.text.matchAll(/\S+/gu)] : [];
  const validWords = !!block && Number.isInteger(firstWord) && Number.isInteger(lastWord) && firstWord >= 1 && lastWord >= firstWord && lastWord <= words.length;

  useEffect(() => {
    let cancelled = false; setLoading(true); setError('');
    api<{ blocks: TextBlock[]; total: number }>(`/documents/${document.id}/blocks?offset=${page * 200}&limit=200`).then(result => {
      if (!cancelled) { setBlocks(result.blocks); setSelected([]); }
    }).catch(error => !cancelled && setError(errorMessage(error))).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [document.id, page]);

  useEffect(() => { if (block) { setFirstWord(1); setLastWord([...block.text.matchAll(/\S+/gu)].length || 1); } }, [block?.id]);
  useEffect(() => {
    if (!jump) return;
    let cancelled = false;
    api<TextBlock>(`/documents/${document.id}/blocks/${encodeURIComponent(jump.blockId)}`).then(block => {
      if (!cancelled) { setTargetBlock(block.id); setPage(Math.floor(block.index / 200)); }
    }).catch(error => !cancelled && setError(errorMessage(error)));
    return () => { cancelled = true; };
  }, [jump?.serial, document.id]);
  useEffect(() => {
    if (!targetBlock || loading || !blocks.some(block => block.id === targetBlock)) return;
    const element = source.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(targetBlock)}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' }); element?.focus({ preventScroll: true }); setTargetBlock(undefined);
  }, [targetBlock, blocks, loading]);

  function collectSelection() {
    if (!editable) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!source.current?.contains(range.startContainer) || !source.current.contains(range.endContainer)) return;
    const spans: EvidenceSpan[] = [];
    source.current.querySelectorAll<HTMLElement>('[data-source-text]').forEach(element => {
      if (!range.intersectsNode(element)) return;
      const block = blocks.find(item => item.id === element.dataset.sourceText); if (!block) return;
      const portion = range.cloneRange();
      if (!element.contains(portion.startContainer)) portion.setStart(element, 0);
      if (!element.contains(portion.endContainer)) portion.setEnd(element, element.childNodes.length);
      const prefix = window.document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(portion.startContainer, portion.startOffset);
      let start = prefix.toString().length; let end = start + portion.toString().length;
      const raw = block.text.slice(start, end); start += raw.length - raw.trimStart().length; end -= raw.length - raw.trimEnd().length;
      if (start < end) spans.push({ blockId: block.id, start: block.start + start, end: block.start + end, quote: block.text.slice(start, end) });
    });
    setSelected(spans);
  }
  function addSelected() { onAdd(selected); setSelected([]); window.getSelection()?.removeAllRanges(); }
  function addWords() {
    if (!block || !validWords) return;
    const start = words[firstWord - 1].index!; const last = words[lastWord - 1]; const end = last.index! + last[0].length;
    onAdd([{ blockId: block.id, start: block.start + start, end: block.start + end, quote: block.text.slice(start, end) }]);
  }
  async function doSearch() {
    if (!search.trim()) { setMatches([]); setSearched(false); return; }
    try { const result = await api<{ matches: Array<{ blockIndex: number; text: string }> }>(`/documents/${document.id}/search?q=${encodeURIComponent(search.trim())}`); setMatches(result.matches); setSearched(true); }
    catch (error) { setError(errorMessage(error)); }
  }
  function navigateIndex(index: number) {
    setPage(Math.floor(index / 200));
    const existing = blocks.find(block => block.index === index);
    if (existing) { setTargetBlock(existing.id); } else {
      void api<{ blocks: TextBlock[] }>(`/documents/${document.id}/blocks?offset=${index}&limit=1`).then(result => { if (result.blocks[0]) setTargetBlock(result.blocks[0].id); }).catch(error => setError(errorMessage(error)));
    }
  }

  return <section className="reader" aria-label="Documento fuente">
    <header className="reader-header"><div><h2>{document.title}</h2><span className="subtle">Versión {document.version} · {document.blockCount.toLocaleString('es-MX')} bloques</span></div>{document.sourceUrl && <a className="small-link" href={document.sourceUrl} target="_blank" rel="noreferrer">Original ↗</a>}</header>
    {document.attribution && <div className="reader-attribution"><p><a href={document.attribution.url} target="_blank" rel="noreferrer">{document.attribution.text}</a><span aria-hidden="true"> · </span><a href={document.attribution.licenseUrl} target="_blank" rel="noreferrer">{document.attribution.license}</a></p>{document.attribution.notice && <details><summary>Aviso de uso</summary><p>{document.attribution.notice}</p></details>}</div>}
    <div className="reader-tools">
      <label className="visually-hidden" htmlFor="section-navigation">Ir a una sección</label>
      <select id="section-navigation" defaultValue="" onChange={event => { if (event.target.value !== '') navigateIndex(Number(event.target.value)); }}><option value="">Ir a sección</option>{document.sections.map((section, index) => <option key={`${section.blockIndex}-${index}`} value={section.blockIndex}>{section.title}</option>)}</select>
      <form className="inline-search" onSubmit={event => { event.preventDefault(); void doSearch(); }}><input aria-label="Buscar en el documento" placeholder="Buscar en el texto" value={search} onChange={event => setSearch(event.target.value)} /><button type="submit" className="button small secondary">Buscar</button></form>
    </div>
    {searched && <div className="source-search-results" aria-label="Coincidencias"><div className="row between"><span className="subtle">{matches.length === 50 ? 'Primeras 50 coincidencias · afina la búsqueda' : `${matches.length} coincidencias`}</span><button className="text-button" onClick={() => { setSearched(false); setMatches([]); }}>Cerrar</button></div>{matches.map((match, index) => <button key={`${match.blockIndex}-${index}`} className="search-match" onClick={() => navigateIndex(match.blockIndex)}><span>Bloque {match.blockIndex + 1}</span>{match.text}</button>)}</div>}
    {error && <p className="message error" role="alert">{error}</p>}
    {editable && <details className="keyboard-evidence"><summary>Seleccionar evidencia con teclado</summary><div className="field"><label htmlFor="evidence-block">Párrafo de esta página</label><select id="evidence-block" value={block?.id ?? ''} onChange={event => setKeyboardBlock(event.target.value)}>{blocks.map(block => <option key={block.id} value={block.id}>Bloque {block.index + 1} · {block.text.slice(0, 70)}</option>)}</select></div><div className="fields two"><div className="field"><label htmlFor="first-word">Primera palabra</label><input id="first-word" type="number" min={1} max={words.length} value={firstWord} onChange={event => setFirstWord(Number(event.target.value))} /></div><div className="field"><label htmlFor="last-word">Última palabra</label><input id="last-word" type="number" min={firstWord} max={words.length} value={lastWord} onChange={event => setLastWord(Number(event.target.value))} /></div></div><p className="selection-preview">{words.slice(Math.max(0, firstWord - 1), lastWord).map(word => word[0]).join(' ')}</p><button type="button" className="button small secondary" disabled={!validWords} onClick={addWords}>Añadir evidencia</button></details>}
    <div className="source-text" ref={source} onMouseUp={collectSelection} onKeyUp={collectSelection} onTouchEnd={() => window.setTimeout(collectSelection, 100)} aria-busy={loading}>
      {loading ? <p className="subtle" role="status">Cargando documento…</p> : blocks.map(block => <section key={block.id} data-block-id={block.id} tabIndex={-1} className={`source-block${block.heading ? ' source-heading' : ''}`}><div className="source-location"><span>Bloque {block.index + 1}{block.page ? ` · Página ${block.page}` : ''}</span>{editable && <button type="button" className="text-button" onClick={() => onAdd([{ blockId: block.id, start: block.start, end: block.end, quote: block.text }])} aria-label={`Añadir bloque ${block.index + 1} como evidencia`}>Añadir párrafo</button>}</div><p data-source-text={block.id}>{markedText(block, evidence)}</p></section>)}
    </div>
    {selected.length > 0 && editable && <div className="selection-bar"><span>{selected.reduce((count, span) => count + span.quote.length, 0)} caracteres · {selected.length} {selected.length === 1 ? 'fragmento' : 'fragmentos'}</span><button className="button small primary" type="button" onClick={addSelected}>Añadir selección</button><button className="text-button" type="button" onClick={() => setSelected([])}>Descartar</button></div>}
    <footer className="reader-pagination"><button className="text-button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>Anterior</button><span>{Math.min(page * 200 + 1, document.blockCount)}–{Math.min((page + 1) * 200, document.blockCount)} / {document.blockCount}</span><button className="text-button" disabled={(page + 1) * 200 >= document.blockCount || loading} onClick={() => setPage(value => value + 1)}>Siguiente</button></footer>
  </section>;
}
