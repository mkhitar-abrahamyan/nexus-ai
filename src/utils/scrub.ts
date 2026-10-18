/**
 * Removing secrets from errors: a provider that refuses a key often says which one it refused, and
 * an error travels to logs, audit events, traces, and health reports.
 */

/** What a removed secret reads as. */
export const REDACTED = '[redacted]';

/** How deep into an error's fields, causes, and details the search goes. */
const MAX_DEPTH = 6;

/**
 * Replaces every occurrence of each secret in an error's text, in place: its message, its stack, and
 * every string field of it, its cause, and the objects they hold. Secrets shorter than four
 * characters are left, since replacing them would garble ordinary text. Returns the same error.
 */
export function scrubSecrets<E>(error: E, secrets: Iterable<string>): E {
  const list = [...secrets].filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
  if (list.length === 0) return error;
  const clean = (text: string): string => {
    let out = text;
    for (const secret of list) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    return out;
  };
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value)) return;
    seen.add(value);
    // Own properties, enumerable or not, so an error's `message` and `stack` are reached.
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const field = descriptor.value as unknown;
      if (typeof field === 'string') {
        const cleaned = clean(field);
        if (cleaned === field) continue;
        if (descriptor.writable) (value as Record<string, unknown>)[key] = cleaned;
        else if (descriptor.configurable) Object.defineProperty(value, key, { ...descriptor, value: cleaned });
      } else if (field && typeof field === 'object') {
        if (field instanceof Map) {
          for (const [entryKey, entry] of field) {
            if (typeof entry === 'string') field.set(entryKey, clean(entry));
            else visit(entry, depth + 1);
          }
        } else if (!ArrayBuffer.isView(field)) visit(field, depth + 1);
      }
    }
  };
  visit(error, 0);
  return error;
}
