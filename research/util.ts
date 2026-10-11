import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function stableJson(value: unknown): string {
  if (value === undefined) throw new Error('Undefined cannot be hashed.');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v)).join(',') + '}';
}
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const hashObject = (value: unknown) => sha256(stableJson(value));
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
export function writeJson(path: string, value: unknown, immutable = false) {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  if (immutable) {
    try { writeFileSync(path, text, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (!existsSync(path) || stableJson(readJson(path)) !== stableJson(value)) throw e; }
  } else { const temp = path + '.tmp'; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, path); }
}
export function seededRandom(seed: number) { let state = seed >>> 0; return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function shuffled<T>(items: readonly T[], seed: number): T[] { const result = [...items], random = seededRandom(seed); for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
export function quantile(values: number[], q: number): number { if (!values.length) throw new Error('Empty quantile'); const a = [...values].sort((x, y) => x - y), p = (a.length - 1) * q, i = Math.floor(p); return a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * (p - i); }
export const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
