export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

export function getArray(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  return asArray(value[key]);
}

export function getString(value: unknown, key: string, fallback = ''): string {
  if (!isRecord(value)) return fallback;
  return asString(value[key], fallback);
}

export function getNumber(value: unknown, key: string, fallback = 0): number {
  if (!isRecord(value)) return fallback;
  return asNumber(value[key], fallback);
}
