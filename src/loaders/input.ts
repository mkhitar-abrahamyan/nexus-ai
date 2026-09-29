import type { FileInput } from './index.js';

/** A file input once read: where it came from, and its bytes. */
export interface ReadInput {
  source: string;
  bytes: Uint8Array;
}

/** Every input as a list, so one file and many are called the same way. */
export function inputsOf(inputs: FileInput | Iterable<FileInput>): Iterable<FileInput> {
  if (typeof inputs === 'string' || inputs instanceof URL) return [inputs];
  if (Symbol.iterator in inputs) return inputs as Iterable<FileInput>;
  return [inputs as FileInput];
}

/** Where an input came from, without reading it. */
export function sourceOf(input: FileInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.protocol === 'file:' ? decodeURIComponent(input.pathname) : input.href;
  return input.source;
}

/**
 * Reads an input. Content held in memory is used as it is; a path or file URL is read from disk, and
 * `node:fs` is imported only then, so a runtime without a filesystem can still load in-memory content.
 */
export async function readInput(input: FileInput): Promise<ReadInput> {
  if (typeof input === 'object' && !(input instanceof URL)) {
    const bytes = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;
    return { source: input.source, bytes };
  }
  const { readFile } = await import('node:fs/promises');
  return { source: sourceOf(input), bytes: new Uint8Array(await readFile(input)) };
}

/** Reads an input as text, dropping a UTF-8 byte-order mark. */
export async function readText(input: FileInput): Promise<{ source: string; text: string }> {
  if (typeof input === 'object' && !(input instanceof URL) && typeof input.content === 'string') {
    return { source: input.source, text: stripBom(input.content) };
  }
  const { source, bytes } = await readInput(input);
  return { source, text: stripBom(new TextDecoder().decode(bytes)) };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
