import path from 'node:path';

export interface AnnotationConfig {
  dataDir: string;
  port: number;
  host: string;
  origin: string;
  allowedOrigins: string[];
  production: boolean;
  sessionDays: number;
  inviteDays: number;
  rateLimit: number;
  trustProxyHops: 0 | 1;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnnotationConfig {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.ANNOTATION_PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ANNOTATION_PORT must be a valid port.');
  const origin = env.ANNOTATION_ORIGIN ?? 'http://127.0.0.1:5175';
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('ANNOTATION_ORIGIN must be an origin without a path.');
  if (production && (!env.ANNOTATION_ORIGIN || url.protocol !== 'https:')) throw new Error('Production requires an explicit HTTPS ANNOTATION_ORIGIN.');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid origin protocol.');
  return {
    dataDir: path.resolve(env.ANNOTATION_DATA_DIR ?? 'annotation/data'), port,
    host: env.ANNOTATION_HOST ?? '127.0.0.1', origin, production,
    allowedOrigins: production ? [origin] : [...new Set([origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5175', 'http://localhost:5175'])],
    sessionDays: 30, inviteDays: 7, rateLimit: 300, trustProxyHops: env.ANNOTATION_TRUST_PROXY === '1' ? 1 : 0,
  };
}
