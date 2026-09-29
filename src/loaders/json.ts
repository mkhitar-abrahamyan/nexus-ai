import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, readText } from './input.js';
import type { FileLoaderOptions } from './text.js';

/** Options for `loadJson()`. */
export interface JsonLoaderOptions extends FileLoaderOptions {
  /**
   * Picks the records out of the parsed file. Defaults to the items of a top-level array, or else the
   * value itself as one record.
   */
  records?: (value: unknown) => Iterable<unknown>;
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

/** JSON and JSON Lines files, one document per record. */
export async function* loadJson(
  inputs: FileInput | Iterable<FileInput>,
  options: JsonLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const { source, text } = await readText(input);
    const lines = options.lines ?? /\.(jsonl|ndjson)$/i.test(source);
    const parsed: unknown = lines
      ? text
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line, index) => {
            try {
              return JSON.parse(line);
            } catch (error) {
              throw new SyntaxError(`${source} line ${index + 1}: ${(error as Error).message}`);
            }
          })
      : JSON.parse(text);
    const records = options.records ? options.records(parsed) : Array.isArray(parsed) ? parsed : [parsed];

    let index = 0;
    for (const record of records) {
      const key = typeof options.id === 'function' ? options.id(record, index) : pick(record, options.id);
      const value = typeof options.text === 'function' ? options.text(record) : pick(record, options.text, record);
      yield {
        id: `${source}#${key === undefined || key === null ? index + 1 : String(key)}`,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        source,
        metadata: {
          ...options.metadata,
          ...(typeof options.metadataFields === 'function'
            ? options.metadataFields(record)
            : Object.fromEntries((options.metadataFields ?? []).map((field) => [field, pick(record, field)]))),
        },
      };
      index++;
    }
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
