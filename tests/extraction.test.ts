import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { chunkBlocks, countTokens, extractDocument } from '../server/extraction.js';
import type { RuntimeConfig } from '../server/contracts.js';
import type { Block } from '../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'jev-extraction-'));
after(() => rm(directory, { recursive: true, force: true }));

const config: RuntimeConfig = {
  dataDir: directory, port: 3001, typesafeApiKey: '', openaiApiKey: '', jevModel: 'jev-1.13.0',
  embeddingModel: 'text-embedding-3-small', jevBaseUrl: '', openaiBaseUrl: '',
  maxFileMb: 100, maxTokens: 1_000_000, maxPdfPages: 2_000, chunkTokens: 500, overlapTokens: 75,
  jevWindowTokens: 12_000, concurrency: 2, requestTimeoutMs: 60_000,
  jevRate: '0.042', embeddingRate: '0.02', rateDate: '2026-10-02',
};
const callbacks = () => ({ signal: new AbortController().signal, onProgress: () => {} });

function makeBlocks(parts: string[]): Block[] {
  let offset = 0;
  return parts.map((text, ordinal) => {
    if (ordinal) offset += 2;
    const block: Block = { id: `book:b:${ordinal}`, ordinal, text, start: offset, end: offset + text.length, paragraph: ordinal + 1, page: ordinal + 1 };
    offset = block.end;
    return block;
  });
}

/** Small, uncompressed PDF fixtures: no renderer or binary asset dependencies. */
function pdfFixture(pages: Array<string | null | 'image'>, raw = false): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream',
  ];
  for (const [index, text] of pages.entries()) {
    const content = text === 'image' ? 'q 612 0 0 792 0 0 cm /Im0 Do Q'
      : text === null ? '' : raw ? text : `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP STORE writer, sufficient for a native DOCX extraction fixture. */
function zipFixture(files: Record<string, string>): Buffer {
  const entries: Buffer[] = [];
  const directories: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const value = Buffer.from(text);
    const crc = crc32(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(value.length, 18); local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(value.length, 20); central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    entries.push(local, filename, value); directories.push(central, filename);
    offset += local.length + filename.length + value.length;
  }
  const central = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}

test('fragmentación conserva Unicode, offsets, referencias, cobertura y límite incluso en párrafos enormes', async () => {
  const blocks = makeBlocks([
    'Título de libro: astronomía 🪐\n' + 'Una estrella ilumina el cielo nocturno. '.repeat(90),
    '第二章 🌌 e\u0301 naïve español '.repeat(210),
    'La última página contiene la respuesta final: EQUINOCCIO.',
  ]);
  const text = blocks.map(block => block.text).join('\n\n');
  const chunks = await chunkBlocks(blocks, 'book', { chunkTokens: 67, overlapTokens: 11 });
  assert.ok(chunks.length > 10);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1)?.end, text.length);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(countTokens(chunk.text) <= 67);
    assert.equal(chunk.text, new TextDecoder().decode(new TextEncoder().encode(chunk.text)));
    assert.deepEqual(chunk.references.map(reference => reference.blockId), blocks.filter(block => block.end > chunk.start && block.start < chunk.end).map(block => block.id));
    if (index) {
      const previous = chunks[index - 1];
      assert.ok(chunk.start > previous.start);
      assert.ok(chunk.start <= previous.end);
      assert.ok(countTokens(text.slice(chunk.start, previous.end)) <= 11);
    }
  }
  assert.ok(chunks.at(-1)?.text.includes('EQUINOCCIO'));
  assert.deepEqual(chunks, await chunkBlocks(blocks, 'book', { chunkTokens: 67, overlapTokens: 11 }));
});

test('texto de libro supera el antiguo límite y llega a sus últimas páginas', async () => {
  const file = join(directory, 'large.txt');
  const content = Array.from({ length: 600 }, (_, index) => `Capítulo ${index + 1}\n${'Texto de un libro sin títulos especiales. '.repeat(20)}`).join('\n\n') + '\n\nFIN DEL LIBRO';
  await writeFile(file, content);
  let persisted = 0;
  const result = await extractDocument(file, 'txt', 'large', config, { ...callbacks(), onBlocks: blocks => { persisted += blocks.length; } });
  assert.ok(result.tokenCount > 24_000);
  assert.equal(result.blocks.length, 601);
  assert.equal(persisted, result.blocks.length);
  assert.equal(result.chunks.at(-1)?.end, result.blocks.map(block => block.text).join('\n\n').length);
  assert.ok(result.chunks.at(-1)?.text.includes('FIN DEL LIBRO'));
  assert.equal(result.blocks.at(-1)?.paragraph, 601);
});

test('TXT rechaza UTF-8 inválido, datos binarios, vacío y exceso de tokens sin truncar', async () => {
  for (const [filename, content, pattern] of [
    ['invalid.txt', Buffer.from([0xc3, 0x28]), /UTF-8/],
    ['binary.txt', Buffer.from([0x61, 0, 0x62]), /binarios/],
    ['empty.txt', Buffer.from(' \n\n '), /no contiene texto/],
  ] as const) {
    const file = join(directory, filename);
    await writeFile(file, content);
    await assert.rejects(extractDocument(file, 'txt', 'invalid', config, callbacks()), pattern);
  }
  const file = join(directory, 'limit.txt');
  await writeFile(file, 'texto '.repeat(110));
  await assert.rejects(extractDocument(file, 'txt', 'limit', { ...config, maxTokens: 100 }, callbacks()), /límite.*tokens/);
  const atLimit = await extractDocument(file, 'txt', 'limit', { ...config, maxTokens: countTokens('texto '.repeat(110).trim()) }, callbacks());
  assert.equal(atLimit.chunks.at(-1)?.end, 'texto '.repeat(110).trim().length);
});

test('PDF conserva referencias de cientos de páginas y páginas vacías', async () => {
  const file = join(directory, 'book.pdf');
  const pages = Array.from({ length: 300 }, (_, index) => index === 149 ? null : `Pagina ${index + 1}: astronomia y estrellas`);
  await writeFile(file, pdfFixture(pages));
  const result = await extractDocument(file, 'pdf', 'pdf', config, callbacks());
  assert.equal(result.pageCount, 300);
  assert.equal(result.blocks.length, 299);
  assert.equal(result.blocks.at(-1)?.page, 300);
  assert.ok(result.chunks.at(-1)?.references.some(reference => reference.page === 300));
  assert.deepEqual(result.warnings, []);
  await assert.rejects(extractDocument(file, 'pdf', 'pdf', { ...config, maxPdfPages: 299 }, callbacks()), /límite.*299/);
});

test('PDF permite portada de imagen con aviso, y rechaza libros sin texto o dañados', async () => {
  const cover = join(directory, 'cover.pdf');
  await writeFile(cover, pdfFixture(['image', 'Capitulo primero: texto seleccionable', null]));
  const result = await extractDocument(cover, 'pdf', 'cover', config, callbacks());
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.imageOnlyPages, [1]);
  assert.match(result.warnings[0], /No se aplicó OCR/);
  assert.equal(result.blocks[0].page, 2);
  const scan = join(directory, 'scan.pdf');
  await writeFile(scan, pdfFixture(['image']));
  await assert.rejects(extractDocument(scan, 'pdf', 'scan', config, callbacks()), /no contiene texto seleccionable/);
  const broken = join(directory, 'broken.pdf');
  await writeFile(broken, 'not a PDF');
  await assert.rejects(extractDocument(broken, 'pdf', 'broken', config, callbacks()), /No se pudo leer el PDF/);
});

test('PDF recompone lectura por columnas sin perder texto', async () => {
  const file = join(directory, 'columns.pdf');
  const lines = [
    [72, 740, 'Titulo que cruza todo el ancho de las dos columnas del documento'],
    [72, 700, 'Izquierda uno'], [340, 700, 'Derecha uno'],
    [72, 684, 'Izquierda dos'], [340, 684, 'Derecha dos'],
    [72, 668, 'Izquierda tres'], [340, 668, 'Derecha tres'],
  ];
  const content = lines.map(([x, y, text]) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
  await writeFile(file, pdfFixture([content], true));
  const result = await extractDocument(file, 'pdf', 'columns', config, callbacks());
  const text = result.blocks.map(block => block.text).join('\n\n');
  for (const [, , expected] of lines) assert.ok(text.includes(String(expected)));
  assert.ok(text.indexOf('Izquierda tres') < text.indexOf('Derecha uno'));
});

test('DOCX conserva párrafos Unicode y detecta archivos dañados', async () => {
  const file = join(directory, 'document.docx');
  await writeFile(file, zipFixture({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Capítulo primero 🪐</w:t></w:r></w:p><w:p><w:r><w:t>Texto en español: investigación.</w:t></w:r></w:p></w:body></w:document>',
  }));
  const result = await extractDocument(file, 'docx', 'docx', config, callbacks());
  assert.deepEqual(result.blocks.map(block => block.text), ['Capítulo primero 🪐', 'Texto en español: investigación.']);
  assert.deepEqual(result.blocks.map(block => block.paragraph), [1, 2]);
  assert.ok(result.chunks[0].references.every(reference => reference.page === undefined));
  const broken = join(directory, 'broken.docx');
  await writeFile(broken, 'not a ZIP');
  await assert.rejects(extractDocument(broken, 'docx', 'broken', config, callbacks()), /No se pudo leer el DOCX/);
});

test('extracción y fragmentación respetan cancelación', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Cancelado'));
  await assert.rejects(chunkBlocks(makeBlocks(['texto']), 'cancelled', config, { signal: controller.signal }), /Cancelado/);
  await assert.rejects(extractDocument('no-file', 'pdf', 'cancelled', config, { signal: controller.signal, onProgress: () => {} }), /Cancelado/);
  const file = join(directory, 'cancelled.txt');
  await writeFile(file, Array.from({ length: 200 }, (_, index) => `Párrafo ${index}`).join('\n\n'));
  const middle = new AbortController();
  let count = 0;
  await assert.rejects(extractDocument(file, 'txt', 'cancelled', config, {
    signal: middle.signal, onProgress: () => {}, onBlocks: blocks => { count += blocks.length; middle.abort(new Error('Cancelado')); },
  }), /Cancelado/);
  assert.equal(count, 64);
});
