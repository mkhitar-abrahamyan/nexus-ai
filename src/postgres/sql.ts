/** SQL-building helpers for adapters whose queries are assembled from filters. */

/**
 * A Postgres `text[]` literal, passed as a string and cast with `::text[]`. Quoting every element
 * means a path segment containing a comma, a brace, or a quote cannot change the array.
 */
export function textArray(parts: readonly string[]): string {
  return `{${parts.map((part) => `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** A `LIKE` pattern matching text that starts with `prefix`, with wildcards in it escaped. */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** Collects parameters and hands out their placeholders, so dynamic SQL stays parameterized. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * The SQL condition for one exact-match filter on a jsonb document, by dot path.
 *
 * Mirrors the in-memory stores exactly: a scalar must be equal, `null` must be a stored null,
 * `undefined` must be absent, and an object never matches, because in-memory `===` never matches
 * one. `anyOf` makes an array mean "one of these values", as the long-term store's filter does.
 */
export function jsonFieldEquals(
  column: string,
  path: string,
  expected: unknown,
  params: SqlParams,
  options: { anyOf?: boolean } = {},
): string {
  // The path is only added when a condition uses it: Postgres refuses a parameter nothing references.
  const at = () => `(${column} #> ${params.add(textArray(path.split('.')))}::text[])`;
  if (expected === undefined) return `${at()} IS NULL`;
  if (Array.isArray(expected)) {
    if (!options.anyOf) return 'FALSE';
    const scalars = expected.filter((item) => item === null || typeof item !== 'object');
    if (scalars.length === 0) return 'FALSE';
    return `${at()} IN (SELECT jsonb_array_elements(${params.add(JSON.stringify(scalars))}::jsonb))`;
  }
  if (expected !== null && typeof expected === 'object') return 'FALSE';
  return `${at()} = ${params.add(JSON.stringify(expected))}::jsonb`;
}
