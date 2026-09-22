import type { PromptDefinition } from '../types/prompts.js';

/**
 * JSON with object keys sorted, so the same content always encodes the same way. `undefined` fields
 * are dropped, as `JSON.stringify` drops them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/**
 * The content version of a definition: `p` and the first 12 hex digits of a SHA-256 over its name,
 * messages, partials, configuration, and defaults.
 *
 * Metadata is left out, so describing a prompt differently does not make it a new version. Hashing
 * uses Web Crypto, which Node, browsers, and edge runtimes all provide, so a version computed in one
 * matches the version computed in another.
 */
export async function promptVersion(definition: PromptDefinition): Promise<string> {
  const content = canonicalJson({
    name: definition.name,
    messages: definition.messages,
    partials: definition.partials,
    config: definition.config,
    defaults: definition.defaults,
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  let hex = '';
  for (const byte of new Uint8Array(digest).subarray(0, 6)) hex += byte.toString(16).padStart(2, '0');
  return `p${hex}`;
}
