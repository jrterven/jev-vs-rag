import { readFile } from 'node:fs/promises';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { getEncoding } from 'js-tiktoken';
import mammoth from 'mammoth';
import type { Block, Chunk, Progress } from '../shared/types.js';
import type { RuntimeConfig } from './contracts.js';

const encoder = getEncoding('cl100k_base');
const separator = '\n\n';

// This is an estimate for Jev, whose tokenizer may differ from cl100k_base.
export function countTokens(text: string): number {
  return encoder.encode(text, [], []).length;
}

interface ExtractionCallbacks {
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
  onBlocks?: (blocks: Block[]) => void;
}

export interface ExtractionResult {
  blocks: Block[];
  chunks: Chunk[];
  pageCount: number;
  tokenCount: number;
  warnings: string[];
  imageOnlyPages: number[];
}

function checkCancelled(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function safeBoundary(text: string, index: number): number {
  if (index > 0 && index < text.length) {
    const current = text.charCodeAt(index);
    const previous = text.charCodeAt(index - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return index - 1;
  }
  return index;
}

/** Largest practical character prefix under a token budget, never splitting a surrogate pair. */
function prefixEnd(text: string, start: number, tokens: number): number {
  let low = start;
  let high = safeBoundary(text, Math.min(text.length, start + Math.max(16, tokens * 5)));
  while (high < text.length && countTokens(text.slice(start, high)) <= tokens) {
    low = high;
    high = safeBoundary(text, Math.min(text.length, start + (high - start) * 2));
  }
  if (countTokens(text.slice(start, high)) <= tokens) return high;
  while (high - low > 1) {
    let middle = safeBoundary(text, Math.floor((low + high) / 2));
    if (middle <= low) {
      middle = low + ((text.codePointAt(low) ?? 0) > 0xffff ? 2 : 1);
      if (middle >= high) break;
    }
    if (countTokens(text.slice(start, middle)) <= tokens) low = middle;
    else high = middle;
  }
  if (low === start) throw new Error('El tamaño de fragmento es demasiado pequeño para conservar el texto Unicode.');
  return low;
}

function overlapStart(text: string, start: number, end: number, budget: number): number {
  if (budget === 0) return end;
  let low = start;
  let high = end;
  while (high - low > 1) {
    let middle = safeBoundary(text, Math.floor((low + high) / 2));
    if (middle <= low) {
      middle = low + ((text.codePointAt(low) ?? 0) > 0xffff ? 2 : 1);
      if (middle >= high) break;
    }
    if (countTokens(text.slice(middle, end)) <= budget) high = middle;
    else low = middle;
  }
  return high;
}

/** Offsets refer to blocks joined with two newlines, using JavaScript UTF-16 indices. */
export async function chunkBlocks(
  blocks: Block[],
  documentId: string,
  config: Pick<RuntimeConfig, 'chunkTokens' | 'overlapTokens'>,
  callbacks?: { signal?: AbortSignal; onProgress?: (progress: Progress) => void },
): Promise<Chunk[]> {
  if (!Number.isInteger(config.chunkTokens) || config.chunkTokens < 4 || !Number.isInteger(config.overlapTokens)
      || config.overlapTokens < 0 || config.overlapTokens >= config.chunkTokens) {
    throw new Error('Configuración de fragmentos inválida. El solapamiento debe ser menor que el tamaño.');
  }
  const text = blocks.map(block => block.text).join(separator);
  if (!text) return [];
  const chunks: Chunk[] = [];
  let start = 0;
  let referenceIndex = 0;
  while (start < text.length) {
    checkCancelled(callbacks?.signal);
    const end = prefixEnd(text, start, config.chunkTokens);
    while (referenceIndex < blocks.length && blocks[referenceIndex].end <= start) referenceIndex++;
    const references: Chunk['references'] = [];
    for (let i = referenceIndex; i < blocks.length && blocks[i].start < end; i++) {
      const block = blocks[i];
      references.push({ blockId: block.id, paragraph: block.paragraph, ...(block.page === undefined ? {} : { page: block.page }) });
    }
    chunks.push({ id: `${documentId}:c:${chunks.length}`, ordinal: chunks.length, text: text.slice(start, end), start, end, references, path: [] });
    if (end === text.length) break;
    const next = overlapStart(text, start, end, config.overlapTokens);
    // Defensive progress guard for pathological tokenization and very small budgets.
    start = next > start ? next : end;
    if (chunks.length % 16 === 0) {
      callbacks?.onProgress?.({ phase: 'Fragmentando', current: end, total: text.length });
      await yieldThread();
    }
  }
  callbacks?.onProgress?.({ phase: 'Fragmentando', current: text.length, total: text.length });
  return chunks;
}

interface PositionedText { text: string; x: number; y: number; width: number; height: number }

/** Recover lines and simple two-column reading order from PDF text positions. */
function pdfParagraphs(items: PositionedText[], width: number): string[] {
  const rows: PositionedText[][] = [];
  for (const item of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - item.y) <= Math.max(2, Math.min(row[0].height, item.height) * 0.3)) row.push(item);
    else rows.push([item]);
  }
  const lines: PositionedText[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let line: PositionedText | undefined;
    for (const item of row) {
      const gap = line ? item.x - (line.x + line.width) : 0;
      if (!line || gap > Math.max(item.height * 3, width * 0.07)) {
        line = { ...item };
        lines.push(line);
      } else {
        const joiner = /\s$/.test(line.text) || /^\s/.test(item.text) || gap < item.height * 0.15 ? '' : ' ';
        line.text += joiner + item.text;
        line.width = Math.max(line.width, item.x + item.width - line.x);
        line.height = Math.max(line.height, item.height);
      }
    }
  }
  const middle = width / 2;
  const left = lines.filter(line => line.x + line.width < middle + width * 0.04);
  const right = lines.filter(line => line.x > middle - width * 0.04);
  const crossing = lines.filter(line => !left.includes(line) && !right.includes(line));
  let ordered = lines;
  if (left.length >= 3 && right.length >= 3 && crossing.length <= Math.max(1, lines.length * 0.2)) {
    ordered = [];
    let ceiling = Infinity;
    for (const divider of [...crossing, { y: -Infinity } as PositionedText]) {
      const band = lines.filter(line => line.y < ceiling && line.y >= divider.y && !crossing.includes(line));
      ordered.push(...band.filter(line => line.x < middle), ...band.filter(line => line.x >= middle));
      if (divider.y !== -Infinity) ordered.push(divider);
      ceiling = divider.y;
    }
  }
  const paragraphs: string[] = [];
  let previous: PositionedText | undefined;
  for (const line of ordered) {
    const text = line.text.trim();
    if (!text) continue;
    const gap = previous ? previous.y - line.y : 0;
    const newParagraph = !previous || gap < -1 || gap > Math.max(previous.height, line.height) * 1.7
      || Math.abs(previous.height - line.height) > Math.min(previous.height, line.height) * 0.25
      || Math.abs(previous.x - line.x) > Math.max(previous.height, line.height) * 2;
    if (newParagraph) paragraphs.push(text);
    else paragraphs[paragraphs.length - 1] += '\n' + text;
    previous = line;
  }
  return paragraphs;
}

function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/).map(part => part.trim()).filter(Boolean);
}

export async function extractDocument(
  filePath: string,
  format: 'pdf' | 'docx' | 'txt',
  documentId: string,
  config: RuntimeConfig,
  callbacks: ExtractionCallbacks,
): Promise<ExtractionResult> {
  const blocks: Block[] = [];
  const imageOnlyPages: number[] = [];
  const warnings: string[] = [];
  let offset = 0;
  let pageCount = 0;
  const append = (texts: string[], page?: number) => {
    const added: Block[] = [];
    for (const text of texts) {
      if (!text.trim()) continue;
      if (blocks.length) offset += separator.length;
      const block: Block = {
        id: `${documentId}:b:${blocks.length}`, ordinal: blocks.length,
        text, start: offset, end: offset + text.length, paragraph: blocks.length + 1,
        ...(page === undefined ? {} : { page }),
      };
      blocks.push(block);
      added.push(block);
      offset = block.end;
    }
    if (added.length) callbacks.onBlocks?.(added);
  };
  checkCancelled(callbacks.signal);
  callbacks.onProgress({ phase: 'Extrayendo', current: 0, total: 1 });
  if (format === 'pdf') {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(await readFile(filePath)), useSystemFonts: true, verbosity: 0 });
    let pdf;
    try {
      pdf = await loading.promise;
      pageCount = pdf.numPages;
      if (pageCount > config.maxPdfPages) throw new Error(`El PDF supera el límite de ${config.maxPdfPages.toLocaleString('es-MX')} páginas.`);
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        checkCancelled(callbacks.signal);
        const page = await pdf.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const items: PositionedText[] = content.items.filter(item => 'str' in item && item.str.trim()).map(item => {
            const part = item as { str: string; transform: number[]; width: number; height: number };
            return { text: part.str, x: part.transform[4], y: part.transform[5], width: part.width, height: part.height || Math.abs(part.transform[3]) || 12 };
          });
          append(pdfParagraphs(items, page.view[2] - page.view[0]), pageNumber);
          if (!items.length) {
            const operations = await page.getOperatorList();
            const imageOperations: number[] = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat];
            if (operations.fnArray.some(operation => imageOperations.includes(operation))) imageOnlyPages.push(pageNumber);
          }
        } finally {
          page.cleanup();
        }
        callbacks.onProgress({ phase: 'Extrayendo páginas', current: pageNumber, total: pageCount });
        await yieldThread();
      }
    } catch (error) {
      if (callbacks.signal.aborted) throw error;
      if (error instanceof Error && /límite|páginas/.test(error.message)) throw error;
      throw new Error('No se pudo leer el PDF. Verifica que no esté dañado ni protegido con contraseña.', { cause: error });
    } finally {
      await loading.destroy();
    }
    if (imageOnlyPages.length) {
      const pages = imageOnlyPages.slice(0, 20).join(', ') + (imageOnlyPages.length > 20 ? ', …' : '');
      warnings.push(`${imageOnlyPages.length} página(s) con imágenes sin texto seleccionable: ${pages}. No se aplicó OCR.`);
    }
  } else {
    let text: string;
    if (format === 'docx') {
      try {
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value;
      } catch (error) {
        throw new Error('No se pudo leer el DOCX. Verifica que sea un documento válido y no esté protegido.', { cause: error });
      }
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filePath));
      } catch (error) {
        throw new Error('El TXT debe estar codificado en UTF-8.', { cause: error });
      }
      if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('El archivo contiene datos binarios. Sube un TXT en UTF-8.');
    }
    const parts = paragraphs(text);
    for (let i = 0; i < parts.length; i += 64) {
      checkCancelled(callbacks.signal);
      append(parts.slice(i, i + 64));
      callbacks.onProgress({ phase: 'Extrayendo párrafos', current: Math.min(parts.length, i + 64), total: parts.length });
      await yieldThread();
    }
  }
  checkCancelled(callbacks.signal);
  if (!blocks.length) throw new Error(format === 'pdf'
    ? 'El PDF no contiene texto seleccionable. OCR no disponible.'
    : 'El documento no contiene texto.');
  callbacks.onProgress({ phase: 'Contando tokens', current: 0, total: 1 });
  const tokenCount = countTokens(blocks.map(block => block.text).join(separator));
  if (tokenCount > config.maxTokens) throw new Error(`El documento supera el límite de ${config.maxTokens.toLocaleString('es-MX')} tokens estimados (${tokenCount.toLocaleString('es-MX')}).`);
  callbacks.onProgress({ phase: 'Contando tokens', current: 1, total: 1 });
  const chunks = await chunkBlocks(blocks, documentId, config, callbacks);
  return { blocks, chunks, pageCount, tokenCount, warnings, imageOnlyPages };
}
