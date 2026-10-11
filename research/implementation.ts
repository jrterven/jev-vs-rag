import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hashObject } from './util.js';
const FILES = ['research/implementation.ts', 'research/smoke.ts', 'research/annotations.ts', 'research/ablations.ts', 'research/cli.ts', 'research/forecast.ts', 'research/human-analysis.ts', 'research/methods.ts', 'research/context.ts', 'research/runner.ts', 'research/metrics.ts', 'research/ledger.ts', 'research/datasets.ts', 'research/report.ts', 'research/statistics.ts', 'research/types.ts', 'research/util.ts', 'research/local-worker.ts', 'research/hardware.ts', 'research/python/worker.py', 'research/python/download_models.py', 'research/python/requirements.txt', 'server/config.ts', 'server/engines/rag.ts', 'shared/types.ts', 'annotation/shared/types.ts', 'server/engines/jev.ts', 'server/engines/common.ts', 'server/extraction.ts', 'server/contracts.ts', 'package-lock.json'];
/** Explicit allowlist: API secrets, .env, documents and output directories never enter this snapshot. */
export function implementationSnapshot() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = Object.fromEntries(FILES.map(path => [path, readFileSync(join(root, path), 'utf8')]));
  return { schemaVersion: 1 as const, hash: hashObject(files), files };
}
