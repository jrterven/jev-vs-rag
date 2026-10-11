import type { Engine } from '../../shared/types.js';
import type { EngineAdapter, RuntimeConfig } from '../contracts.js';
import { JevEngine } from './jev.js';
import { RagEngine } from './rag.js';
export { EngineError } from './common.js';
export function createEngines(config: RuntimeConfig): Record<Engine, EngineAdapter> {
  return { jev: new JevEngine(config), rag: new RagEngine(config) };
}
