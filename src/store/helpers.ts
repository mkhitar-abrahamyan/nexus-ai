/** Pure helpers every long-term store shares: filtering, indexed text, and similarity. */

/** Exact match on dot-path fields, so a filter reads like the shape of the value it selects. */
export function matches(value: unknown, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([path, expected]) => {
    const actual = readPath(value, path);
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

export function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

/** The text an item is indexed by: chosen fields, or every string in the value. */
export function textOf(value: unknown, fields: readonly string[] | undefined): string {
  if (fields?.length) {
    return fields
      .map((field) => readPath(value, field))
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .trim();
  }
  if (typeof value === 'string') return value.trim();
  const parts: string[] = [];
  const walk = (current: unknown): void => {
    if (typeof current === 'string') parts.push(current);
    else if (Array.isArray(current)) for (const entry of current) walk(entry);
    else if (current && typeof current === 'object') for (const entry of Object.values(current)) walk(entry);
  };
  walk(value);
  return parts.join('\n').trim();
}

/** Cosine similarity of two vectors, from -1 to 1. Zero-length vectors score 0. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] as number;
    const y = b[index] as number;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  const magnitude = Math.sqrt(left) * Math.sqrt(right);
  return magnitude === 0 ? 0 : dot / magnitude;
}
