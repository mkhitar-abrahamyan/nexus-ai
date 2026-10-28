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
    if ('stream' in input) {
      const pieces: Uint8Array[] = [];
      for await (const piece of input.stream) {
        pieces.push(typeof piece === 'string' ? new TextEncoder().encode(piece) : piece);
      }
      const bytes = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
      let offset = 0;
      for (const piece of pieces) {
        bytes.set(piece, offset);
        offset += piece.byteLength;
      }
      return { source: input.source, bytes };
    }
    const bytes = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;
    return { source: input.source, bytes };
  }
  const { readFile } = await import('node:fs/promises');
  return { source: sourceOf(input), bytes: new Uint8Array(await readFile(input)) };
}

/** Reads an input as text, dropping a UTF-8 byte-order mark. */
export async function readText(input: FileInput): Promise<{ source: string; text: string }> {
  if (typeof input === 'object' && !(input instanceof URL) && 'content' in input && typeof input.content === 'string') {
    return { source: input.source, text: stripBom(input.content) };
  }
  const { source, bytes } = await readInput(input);
  return { source, text: stripBom(new TextDecoder().decode(bytes)) };
}

/**
 * An input's text a piece at a time, so a large file is never held whole: a path or file URL read from
 * disk in chunks of 64 KiB, a stream as it arrives, and content in memory as it is. A character split
 * between two chunks is decoded whole, and a byte-order mark is dropped.
 */
export async function* textChunks(input: FileInput): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let first = true;
  for await (const piece of piecesOf(input)) {
    let text = typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true });
    if (first && text) {
      first = false;
      text = stripBom(text);
    }
    if (text) yield text;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

async function* piecesOf(input: FileInput): AsyncGenerator<Uint8Array | string> {
  if (typeof input === 'object' && !(input instanceof URL)) {
    if ('stream' in input) yield* input.stream;
    else yield input.content;
    return;
  }
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(input, { highWaterMark: 64 * 1024 })) yield chunk as Uint8Array;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
