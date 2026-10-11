import Decimal from 'decimal.js';
import type { CostSummary, Status } from '../shared/types';

export const number = (n: number) => new Intl.NumberFormat('es-MX').format(n);
export const elapsed = (ms?: number) => {
  if (ms === undefined) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round(ms % 60_000 / 1_000)} s`;
};
export const money = (value?: string | null) => {
  if (value == null) return '—';
  const amount = new Decimal(value);
  if (amount.isZero()) return '$0';
  return `$${amount.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')}`;
};
export const sumCosts = (costs: CostSummary[]): CostSummary => ({
  knownUsd: costs.reduce((total, cost) => total.plus(cost.knownUsd), new Decimal(0)).toString(),
  unknownAttempts: costs.reduce((total, cost) => total + cost.unknownAttempts, 0),
  inputTokens: costs.reduce((total, cost) => total + cost.inputTokens, 0),
  calls: costs.reduce((total, cost) => total + cost.calls, 0),
});
export const statusLabel: Record<Status, string> = {
  queued: 'En espera', running: 'Procesando', completed: 'Listo', failed: 'Error',
  cancelled: 'Cancelado', interrupted: 'Interrumpido',
};
export const active = (status?: Status) => status === 'queued' || status === 'running';
export const date = (value: string) => new Intl.DateTimeFormat('es-MX', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));
