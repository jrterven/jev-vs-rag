import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Decimal } from 'decimal.js';
import { tokenCount } from '../server/engines/common.js';
import { costForTokens } from '../server/costs.js';
import type { Attempt, Comparison, DocumentRecord, Engine, Job, Overview, PublicConfig } from '../shared/types.js';

// Opt-in: uses the running local app and real APIs. Keeps the test book in the
// app so the same results can be inspected in the UI. Never reads API keys.
const base = process.env.LIVE_APP_URL || 'http://127.0.0.1:3001';
const engines: Engine[] = ['jev', 'rag'];
const terminal = (status: string) => !['queued', 'running'].includes(status);
async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + route, init);
  const result = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`);
  return result as T;
}
async function waitFor<T>(get: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const value = await get();
    if (done(value)) return value;
    await delay(500);
  }
  throw new Error('La prueba excedió diez minutos esperando el trabajo.');
}
const config = await api<PublicConfig>('/api/config');
assert.ok(config.keys.jev && config.keys.rag, 'Configura ambas claves y reinicia el servidor.');
const themes = ['cartografía lunar', 'registro de meteoros', 'medición de sombras', 'calibración óptica', 'fotografía nocturna', 'archivo de placas', 'seguimiento planetario', 'lectura del barómetro', 'cuidado de lentes', 'observación solar', 'control de humedad', 'revisión del reloj'];
const sections = ['MANUAL DE CAMPO DEL OBSERVATORIO DEL VALLE\n\nDocumento ficticio de prueba. La estación abrió en 1987.'];
for (let chapter = 1; tokenCount(sections.join('\n\n')) < 15_000; chapter++) {
  const theme = themes[(chapter - 1) % themes.length];
  sections.push(`CAPÍTULO ${chapter}. ${theme.toUpperCase()}`);
  sections.push(`El equipo del sector ${chapter} dedica su turno a ${theme}. Antes de empezar, registra la hora, la temperatura y las condiciones del cielo en una hoja numerada. La revisión comienza por la mesa de trabajo y termina en la terraza. Cada integrante anota los cambios observados durante la noche y comprueba que los instrumentos permanezcan estables. En este sector se utilizan ${chapter + 2} cuadernos para separar las observaciones de las tareas de mantenimiento. Los registros de días anteriores se conservan por orden de fecha. Cuando aparece una diferencia entre dos lecturas, el personal repite la medición y explica el procedimiento utilizado. La persona responsable entrega el informe al siguiente turno antes de cerrar la sala. No se descartan las mediciones difíciles: se identifican con una nota sobre las condiciones de la observación.`);
  sections.push(`Procedimiento del sector ${chapter}: consultar la lista de materiales, revisar las conexiones y preparar una superficie limpia. Durante la actividad de ${theme}, los visitantes permanecen en el corredor y el personal emplea luz tenue. Al finalizar, las piezas se guardan en sus cajas y las hojas se colocan en la carpeta del mes. La inspección ordinaria se programa cada ${chapter + 3} días. El resumen mensual incluye las incidencias, los ajustes y las recomendaciones para el siguiente periodo.`);
}
sections.push('APÉNDICE FINAL. ARCHIVO RESERVADO');
sections.push('La clave de acceso al archivo reservado es ORIÓN-7392. Este dato aparece únicamente en el apéndice final del manual. La responsable del archivo es Lucía Beltrán y el acceso se realiza por la puerta norte. El archivo reservado conserva los originales históricos que no se incluyen en las carpetas de trabajo de los sectores.');
const text = sections.join('\n\n');
const name = 'Prueba real · Manual del observatorio.txt';
await mkdir('output', { recursive: true });
await writeFile('output/live-book.txt', text);
const form = new FormData();
form.append('file', new Blob([text], { type: 'text/plain' }), name);
const document = await api<DocumentRecord>('/api/documents', { method: 'POST', body: form });
console.log(`Documento: ${document.id} · preparación iniciada`);
const getOverview = () => api<Overview>(`/api/documents/${document.id}`);
let overview = await waitFor(getOverview, value => terminal(value.document.status));
assert.equal(overview.document.status, 'completed', JSON.stringify(overview.document.engines));
assert.ok(overview.document.chunkCount > 20);
console.log(`Preparación: OK · ${overview.document.tokenCount} tokens · ${overview.document.chunkCount} fragmentos`);
const beforeResume = engines.map(engine => overview.costs[engine].preparation.calls);
const resumed = await api<Job>(`/api/documents/${document.id}/resume`, { method: 'POST' });
const resumeResult = await waitFor(() => api<Job>(`/api/jobs/${resumed.id}`), job => terminal(job.status));
assert.equal(resumeResult.status, 'completed');
overview = await getOverview();
assert.deepEqual(engines.map(engine => overview.costs[engine].preparation.calls), beforeResume);
console.log('Reanudación: OK · sin repetir llamadas completadas');

async function search(query: string, rounds: 1 | 5, expected?: string): Promise<Comparison> {
  const started = await api<{ comparison: Comparison }>(`/api/documents/${document.id}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, rounds }),
  });
  const comparison = await waitFor(() => api<Comparison>(`/api/comparisons/${started.comparison.id}`), value => terminal(value.status));
  assert.equal(comparison.status, 'completed', JSON.stringify(comparison.runs.map(run => ({ engine: run.engine, error: run.error }))));
  for (const run of comparison.runs) {
    assert.equal(run.metrics.chunksCovered, overview.document.chunkCount);
    assert.equal(run.cost.unknownAttempts, 0);
    assert.ok(run.cost.inputTokens > 0);
    assert.ok((run.elapsedMs ?? 0) > 0);
    assert.ok(run.hits.length > 0);
    if (expected) assert.ok(run.hits.slice(0, 3).some(hit => hit.text.includes(expected)), `${run.engine}, ronda ${run.round}: el dato final no aparece entre los tres primeros resultados.`);
    if (run.engine === 'jev') {
      assert.ok(run.metrics.windowsTotal > 1);
      assert.equal(run.metrics.windowsCompleted, run.metrics.windowsTotal);
      assert.ok(run.metrics.reductionLevels > 0);
      assert.equal(run.existenceScope, 'finalists');
      assert.ok(run.existence! >= 0 && run.existence! <= 1);
    }
  }
  console.log(`Búsqueda: OK · ${rounds} ronda(s) · ${query}`);
  return comparison;
}
const spanish = await search('¿Cuál es la clave de acceso al archivo reservado?', 1, 'ORIÓN-7392');
const english = await search('What is the access code for the restricted archive?', 1, 'ORIÓN-7392');
const absent = await search('¿Cuál es la receta de la tarta de chocolate del restaurante?', 1);
const benchmark = await search(spanish.query, 5, 'ORIÓN-7392');
for (const run of spanish.runs) {
  const hit = run.hits.find(hit => hit.text.includes('ORIÓN-7392'))!;
  const context = await api<{ chunk: { text: string }; blocks: { text: string }[] }>(`/api/documents/${document.id}/chunks/${encodeURIComponent(hit.chunkId)}`);
  assert.ok(context.chunk.text.includes('ORIÓN-7392'));
  assert.ok(context.blocks.some(block => block.text.includes('ORIÓN-7392')));
}
const exported = await api<Overview & { attempts: Attempt[] }>(`/api/documents/${document.id}/export`);
assert.equal(new Set(exported.attempts.map(attempt => attempt.id)).size, exported.attempts.length);
for (const attempt of exported.attempts) {
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.costUsd, costForTokens(attempt.inputTokens!, attempt.rateUsdPerMillion));
  assert.ok(attempt.rateDate && attempt.rateSource);
}
for (const engine of engines) {
  const own = exported.attempts.filter(attempt => attempt.engine === engine);
  const sum = own.reduce((total, attempt) => total.add(attempt.costUsd!), new Decimal(0));
  assert.equal(sum.toFixed(), exported.costs[engine].total.knownUsd);
}
const summary = engines.map(engine => {
  const runs = benchmark.runs.filter(run => run.engine === engine);
  const times = runs.map(run => run.elapsedMs!).sort((a, b) => a - b);
  return {
    engine, preparationMs: exported.document.engines[engine].elapsedMs,
    preparationUsd: exported.costs[engine].preparation.knownUsd,
    searchMedianMs: times[2], searchMinMs: times[0], searchMaxMs: times[4],
    benchmarkUsd: runs.reduce((total, run) => total.add(run.cost.knownUsd), new Decimal(0)).toFixed(),
    lastQueryUsd: runs[4].cost.knownUsd, totalUsd: exported.costs[engine].total.knownUsd,
    relevantRankSpanish: spanish.runs.find(run => run.engine === engine)!.hits.findIndex(hit => hit.text.includes('ORIÓN-7392')) + 1,
    relevantRankEnglish: english.runs.find(run => run.engine === engine)!.hits.findIndex(hit => hit.text.includes('ORIÓN-7392')) + 1,
    noAnswerSignal: absent.runs.find(run => run.engine === engine)!.existence ?? null,
    metrics: runs[0].metrics,
  };
});
const report = { testedAt: new Date().toISOString(), base, document: exported.document, summary, comparisons: [spanish, english, absent, benchmark], costs: exported.costs, attempts: exported.attempts };
await writeFile('output/live-api-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('Exportación, referencias y costos: OK · output/live-api-report.json');
