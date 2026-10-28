import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, sourceOf, textChunks } from './input.js';
import type { FileLoaderOptions } from './text.js';

/** Options for `parseCsv()`. */
export interface CsvParseOptions {
  /** The field separator. Defaults to a comma; use `'\t'` for TSV. */
  delimiter?: string;
}

/**
 * CSV parsed as it arrives: `push()` takes the next piece of text, of any length, and returns the rows
 * it completed; `end()` returns the last. A quote, or a CRLF, split between two pieces is read as one.
 * `parseCsv()` is this, given the whole text at once.
 */
export class CsvRowParser {
  private readonly delimiter: string;
  private row: string[] = [];
  private field = '';
  private quoted = false;
  /** A quote inside a quoted field, waiting for the next character: a second quote, or the field's end. */
  private quote = false;
  /** A carriage return that ended a row, whose line feed, if one follows, belongs to it. */
  private carriage = false;
  private started = false;

  constructor(options: CsvParseOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new RangeError('delimiter must be one character other than a quote or a line break');
    }
    this.delimiter = delimiter;
  }

  /** Reads the next piece of text, and returns the rows it completed. */
  push(text: string): string[][] {
    const rows: string[][] = [];
    let index = 0;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) index = 1;
    }
    for (; index < text.length; index++) {
      const char = text[index] as string;
      if (this.carriage) {
        this.carriage = false;
        if (char === '\n') continue;
      }
      if (this.quote) {
        this.quote = false;
        if (char === '"') {
          this.field += '"';
          continue;
        }
        // The quote closed the field; this character is read outside it.
        this.quoted = false;
      }
      if (this.quoted) {
        if (char === '"') this.quote = true;
        else this.field += char;
      } else if (char === '"' && this.field === '') this.quoted = true;
      else if (char === this.delimiter) {
        this.row.push(this.field);
        this.field = '';
      } else if (char === '\n' || char === '\r') {
        this.carriage = char === '\r';
        this.row.push(this.field);
        rows.push(this.row);
        this.row = [];
        this.field = '';
      } else this.field += char;
    }
    return rows;
  }

  /** Ends the text, and returns its last row, unless it ended with a line break. */
  end(): string[][] {
    if (this.quote) {
      this.quote = false;
      this.quoted = false;
    }
    if (this.quoted) throw new SyntaxError('The CSV ends inside a quoted field');
    const rows: string[][] = [];
    if (this.field !== '' || this.row.length > 0) {
      this.row.push(this.field);
      rows.push(this.row);
    }
    this.row = [];
    this.field = '';
    return rows;
  }
}

/**
 * Parses CSV into rows of fields, following RFC 4180: quoted fields may hold the delimiter, line
 * breaks, and doubled quotes; lines may end in CRLF or LF; and a trailing line break adds no row.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const parser = new CsvRowParser(options);
  return [...parser.push(text), ...parser.end()];
}

/** Options for `loadCsv()`. */
export interface CsvLoaderOptions extends FileLoaderOptions, CsvParseOptions {
  /**
   * Columns that make up a row's text, written as `column: value` lines. Defaults to every column not
   * named in `idColumn` or `metadataColumns`.
   */
  textColumns?: readonly string[];
  /** The column whose value becomes the row's id, after the file name. Defaults to the row number. */
  idColumn?: string;
  /** Columns copied into the metadata, where a filter can select on them. */
  metadataColumns?: readonly string[];
}

/**
 * CSV files, one document per row. The first row names the columns. Each row's text lists its columns
 * by name, so a model reading a chunk knows what each value is. Rows are read as the file arrives, so
 * a file larger than memory streams through.
 */
export async function* loadCsv(
  inputs: FileInput | Iterable<FileInput>,
  options: CsvLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const source = sourceOf(input);
    const parser = new CsvRowParser(options);
    let reader: ((fields: string[]) => DocumentSource | undefined) | undefined;
    const rows = async function* () {
      for await (const chunk of textChunks(input)) yield* parser.push(chunk);
      yield* parser.end();
    };
    for await (const fields of rows()) {
      if (!reader) {
        reader = rowReader(source, fields, options);
        continue;
      }
      const document = reader(fields);
      if (document) yield document;
    }
  }
}

/** Reads a file's rows into documents by its header, its columns found once. */
function rowReader(
  source: string,
  header: string[],
  options: CsvLoaderOptions,
): (fields: string[]) => DocumentSource | undefined {
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new RangeError(`${source} has no column "${name}"`);
    return index;
  };
  const idIndex = options.idColumn === undefined ? -1 : column(options.idColumn);
  const metadataIndexes = (options.metadataColumns ?? []).map((name) => [name, column(name)] as const);
  const textIndexes = options.textColumns
    ? options.textColumns.map(column)
    : header
        .map((_, index) => index)
        .filter((index) => index !== idIndex && !metadataIndexes.some(([, metadata]) => metadata === index));
  let rowIndex = 0;
  return (fields) => {
    rowIndex += 1;
    if (fields.length === 1 && fields[0] === '') return undefined;
    const key = idIndex >= 0 ? fields[idIndex] : String(rowIndex);
    return {
      id: `${source}#${key}`,
      text: textIndexes
        .map((index) => `${header[index]}: ${fields[index] ?? ''}`)
        .filter((line) => !line.endsWith(': '))
        .join('\n'),
      source,
      metadata: {
        ...options.metadata,
        ...Object.fromEntries(metadataIndexes.map(([name, index]) => [name, fields[index] ?? ''])),
        row: rowIndex,
      },
    };
  };
}
