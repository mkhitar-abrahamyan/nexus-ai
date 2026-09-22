/** Whether a value is a plain object, not null or an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The value when it is an array, otherwise an empty one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The value when it is a string, otherwise the fallback. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** The value when it is a finite number, otherwise the fallback. */
export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A nested object at a key, or `undefined`. */
export function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

/** An array at a key, or an empty one. */
export function getArray(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  return asArray(value[key]);
}

/** A string at a key, or the fallback. */
export function getString(value: unknown, key: string, fallback = ''): string {
  if (!isRecord(value)) return fallback;
  return asString(value[key], fallback);
}

/** A finite number at a key, or the fallback. */
export function getNumber(value: unknown, key: string, fallback = 0): number {
  if (!isRecord(value)) return fallback;
  return asNumber(value[key], fallback);
}
