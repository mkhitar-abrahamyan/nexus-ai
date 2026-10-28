import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, readText, sourceOf, textChunks } from './input.js';
import type { FileLoaderOptions } from './text.js';

/** Options for `loadJson()`. */
export interface JsonLoaderOptions extends FileLoaderOptions {
  /**
   * Picks the records out of the parsed file, which is then read whole. Defaults to the items of the
   * array at `recordsAt`, or of a top-level array, read as the file arrives; or else the value itself as
   * one record.
   */
  records?: (value: unknown) => Iterable<unknown>;
  /**
   * Where the array of records is: object keys from the top, dotted, such as `data.items`. Its items
   * are read one at a time as the file arrives, so a file larger than memory streams through. A file
   * with no array there is refused.
   */
  recordsAt?: string;
  /**
   * A record's text: a field, by dotted path such as `body.text`, or a function. Defaults to a string
   * record itself, or else the record as indented JSON.
   */
  text?: string | ((record: unknown) => string);
  /** A record's id, after the file name: a field by dotted path, or a function. Defaults to its position. */
  id?: string | ((record: unknown, index: number) => string);
  /** Fields copied into the metadata, by dotted path, or a function that builds it. */
  metadataFields?: readonly string[] | ((record: unknown) => Record<string, unknown>);
  /**
   * Reads one JSON value per line (JSON Lines). Defaults to on for `.jsonl` and `.ndjson` files, so a
   * large export streams record by record.
   */
  lines?: boolean;
}

/**
 * JSON and JSON Lines files, one document per record. A JSON Lines file, and the array of records in a
 * JSON one, are read as the file arrives, a record at a time, so a file larger than memory streams
 * through; a `records` function reads the file whole.
 */
export async function* loadJson(
  inputs: FileInput | Iterable<FileInput>,
  options: JsonLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const source = sourceOf(input);
    const lines = options.lines ?? /\.(jsonl|ndjson)$/i.test(source);
    let index = 0;
    const documentOf = (record: unknown): DocumentSource => {
      const key = typeof options.id === 'function' ? options.id(record, index) : pick(record, options.id);
      const value = typeof options.text === 'function' ? options.text(record) : pick(record, options.text, record);
      index++;
      return {
        id: `${source}#${key === undefined || key === null ? index : String(key)}`,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        source,
        metadata: {
          ...options.metadata,
          ...(typeof options.metadataFields === 'function'
            ? options.metadataFields(record)
            : Object.fromEntries((options.metadataFields ?? []).map((field) => [field, pick(record, field)]))),
        },
      };
    };
    if (options.records) {
      const { text } = await readText(input);
      const values: unknown[] = [];
      if (lines) for await (const value of jsonLines([text], source)) values.push(value);
      const parsed: unknown = lines ? values : JSON.parse(text);
      for (const record of options.records(parsed)) yield documentOf(record);
    } else if (lines) {
      for await (const record of jsonLines(textChunks(input), source)) yield documentOf(record);
    } else {
      const scanner = new JsonRecordScanner(options.recordsAt?.split('.') ?? []);
      for await (const chunk of textChunks(input)) {
        for (const record of scanner.push(chunk)) yield documentOf(record);
        // What follows the array of records is never read.
        if (scanner.finished) break;
      }
      for (const record of scanner.end(source)) yield documentOf(record);
    }
  }
}

/** JSON Lines as they arrive: a value per line, blank lines passed over, a bad line named by number. */
async function* jsonLines(chunks: AsyncIterable<string> | Iterable<string>, source: string): AsyncGenerator<unknown> {
  let rest = '';
  let number = 0;
  const parse = (line: string) => {
    number += 1;
    if (!line.trim()) return undefined;
    try {
      return { value: JSON.parse(line) as unknown };
    } catch (error) {
      throw new SyntaxError(`${source} line ${number}: ${(error as Error).message}`);
    }
  };
  for await (const chunk of chunks) {
    // A carriage return left at a line's end is whitespace to JSON.parse().
    const pieces = (rest + chunk).split('\n');
    rest = pieces.pop() ?? '';
    for (const line of pieces) {
      const parsed = parse(line);
      if (parsed) yield parsed.value;
    }
  }
  const last = parse(rest);
  if (last) yield last.value;
}

/** A container the scanner is inside: an object, with the key it is reading a value of, or an array. */
interface Frame {
  kind: 'object' | 'array';
  /** In an object, the key whose value comes next, once read. */
  key?: string;
  /**
   * In an object, whether a key comes next rather than a value. Only a key's text is kept, so a long
   * string value outside the records is never held.
   */
  expectKey?: boolean;
}

/**
 * The records of a JSON document as it arrives, without holding the whole of it: each item of the
 * array at `path`, a list of object keys from the top, parsed on its own as soon as it ends. With no
 * path, the items of a top-level array, or, when the document is not one, the document itself, which
 * is then read whole.
 */
class JsonRecordScanner {
  private readonly stack: Frame[] = [];
  private inString = false;
  private escaped = false;
  /** The text of an object key being read, to know which value comes next. */
  private keyText: string[] | undefined;
  /** The depth of the array whose items are the records, while inside it. */
  private target = -1;
  private found = false;
  private done = false;
  /** The current record's text, in pieces, while one is being read. */
  private record: string[] | undefined;
  /** The whole document, kept only when it is not an array of records. */
  private whole: string[] | undefined;
  private started = false;

  /** Whether the records were looked for at a path, so a document with none there is refused. */
  private readonly explicit: boolean;

  constructor(private readonly path: readonly string[] = []) {
    this.explicit = path.length > 0;
  }

  /** Whether the array of records has ended, so nothing after it need be read. */
  get finished(): boolean {
    return this.done;
  }

  /** Reads the next piece of the document, and returns the records it completed. */
  push(text: string): unknown[] {
    const records: unknown[] = [];
    if (this.whole) {
      this.whole.push(text);
      return records;
    }
    let from = this.record ? 0 : -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index] as string;
      if (!this.started) {
        if (/\s/.test(char)) continue;
        this.started = true;
        // A document that is not an array, with no path to look in, is one record, read whole.
        if (char !== '[' && !this.explicit) {
          this.whole = [text.slice(index)];
          return records;
        }
      }
      if (this.inString) {
        if (this.keyText) this.keyText.push(char);
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') {
          this.inString = false;
          if (this.keyText) {
            const frame = this.stack.at(-1) as Frame;
            frame.key = JSON.parse(`"${this.keyText.slice(0, -1).join('')}"`) as string;
            frame.expectKey = false;
            this.keyText = undefined;
          }
        }
        continue;
      }
      const atTarget = this.target >= 0 && this.stack.length === this.target;
      if (atTarget && (char === ',' || char === ']')) {
        if (this.record) {
          this.record.push(text.slice(from, index));
          records.push(JSON.parse(this.record.join('')));
          this.record = undefined;
        }
        if (char === ']') {
          this.done = true;
          return records;
        }
        continue;
      }
      if (atTarget && !this.record && !/\s/.test(char)) {
        this.record = [];
        from = index;
      }
      const frame = this.stack.at(-1);
      if (char === '"') {
        this.inString = true;
        if (frame?.kind === 'object' && frame.expectKey && !this.record) this.keyText = [];
      } else if (char === '{' || char === '[') {
        const opened: Frame = char === '{' ? { kind: 'object', expectKey: true } : { kind: 'array' };
        if (char === '[' && this.at(this.path)) {
          this.found = true;
          this.target = this.stack.length + 1;
        }
        this.stack.push(opened);
      } else if (char === '}' || char === ']') {
        this.stack.pop();
      } else if (char === ',' && frame?.kind === 'object') frame.expectKey = true;
    }
    if (this.record) this.record.push(text.slice(Math.max(from, 0)));
    return records;
  }

  /** Ends the document, and returns the record a document that is not an array is. */
  end(source: string): unknown[] {
    if (this.whole) return [JSON.parse(this.whole.join(''))];
    if (!this.found) {
      throw new SyntaxError(
        this.explicit ? `${source} has no array at "${this.path.join('.')}"` : `${source} holds no JSON value`,
      );
    }
    if (!this.done) throw new SyntaxError(`${source} ends inside its array of records`);
    return [];
  }

  /**
   * Whether the scanner is where `path` leads: in the object at each key, in turn, from the top. An
   * array on the way has no key, so it never matches.
   */
  private at(path: readonly string[]): boolean {
    if (this.stack.length !== path.length) return false;
    return this.stack.every((frame, depth) => frame.key === path[depth]);
  }
}

function pick(record: unknown, path: string | undefined, fallback?: unknown): unknown {
  if (path === undefined) return fallback;
  let value = record;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
