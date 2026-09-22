import { createHash } from 'node:crypto';
import type { DatasetExample } from '../types/evaluate.js';

/**
 * A dataset version derived from its examples.
 *
 * Kept apart from the dataset stores so a runner that only needs the version — `EvalRunner`,
 * `MediaEvalRunner` — does not pull file-system code into the imports that reach it.
 */
export function contentVersion(examples: readonly DatasetExample[]): string {
  const hash = createHash('sha256');
  for (const example of examples) {
    hash.update(JSON.stringify({ id: example.id, inputs: example.inputs, expected: example.expected }));
  }
  return `v${hash.digest('hex').slice(0, 12)}`;
}
