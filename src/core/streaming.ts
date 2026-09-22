import type { NexusStream, StreamChunk } from '../types/response.js';

/** Reads a stream to the end and returns its text. */
export async function collectStream(stream: NexusStream): Promise<string> {
  let content = '';

  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) {
      content += chunk.content;
    }
  }

  return content;
}

/** Transforms each chunk of a stream. */
export async function* mapStream(
  stream: NexusStream,
  mapChunk: (chunk: StreamChunk) => StreamChunk | Promise<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of stream) {
    yield mapChunk(chunk);
  }
}

/** A stream that yields one text chunk and finishes, for tests and cached answers. */
export function createTextStream(text: string): NexusStream {
  let aborted = false;

  return {
    async *[Symbol.asyncIterator]() {
      if (aborted) return;
      yield { type: 'text', content: text };
      if (aborted) return;
      yield { type: 'done' };
    },
    abort() {
      aborted = true;
    },
  };
}
