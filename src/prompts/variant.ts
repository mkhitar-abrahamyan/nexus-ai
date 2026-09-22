import type { PromptVariant } from '../types/prompts.js';

/**
 * Picks an A/B arm for a key, the same arm every time for the same key, prompt, and label.
 *
 * Without a key there is nothing to be sticky to, so the arm is chosen at random.
 */
export function chooseVariant(variants: readonly PromptVariant[], seed?: string): number {
  const total = variants.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);
  if (variants.length <= 1 || total <= 0) return 0;
  let point: number;
  if (seed === undefined) point = Math.random() * total;
  else {
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    point = ((hash >>> 0) / 0x1_0000_0000) * total;
  }
  for (let index = 0; index < variants.length; index += 1) {
    point -= Math.max(0, (variants[index] as PromptVariant).weight);
    if (point < 0) return index;
  }
  return variants.length - 1;
}
