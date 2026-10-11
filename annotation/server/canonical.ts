import { createHash } from 'node:crypto';
import type { FrozenDataset } from '../shared/types.js';
export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export function hashDataset(value: Pick<FrozenDataset, 'projectId' | 'version' | 'documents' | 'questions'>): string {
  return sha256(JSON.stringify({ projectId: value.projectId, version: value.version, documents: value.documents, questions: value.questions }));
}
