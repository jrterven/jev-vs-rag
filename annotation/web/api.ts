export const prefix = '/api/annotation';
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${prefix}${path}`, {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'x-annotation-csrf': '1' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  if (!response.ok) {
    let message = `No se pudo completar la solicitud (${response.status}).`;
    try { const data = await response.json(); message = data.error?.message ?? data.error ?? data.message ?? message; } catch { /* non-JSON HTTP failure */ }
    throw new ApiError(typeof message === 'string' ? message : 'No se pudo completar la solicitud.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Ocurrió un error.';
export const shortDate = (value: string) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const kindLabels = { author: 'Autoría', review: 'Revisión', adjudicate: 'Adjudicación', evaluate: 'Evaluación' };
export const statusLabels = { assigned: 'Pendiente', draft: 'Borrador', submitted: 'Enviado', completed: 'Completado' };
