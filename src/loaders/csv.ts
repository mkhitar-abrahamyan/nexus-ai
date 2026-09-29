import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, readText } from './input.js';
import type { FileLoaderOptions } from './text.js';

/** Options for `parseCsv()`. */
export interface CsvParseOptions {
  /** The field separator. Defaults to a comma; use `'\t'` for TSV. */
  delimiter?: string;
}

/**
 * Parses CSV into rows of fields, following RFC 4180: quoted fields may hold the delimiter, line
 * breaks, and doubled quotes; lines may end in CRLF or LF; and a trailing line break adds no row.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new RangeError('delimiter must be one character other than a quote or a line break');
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new SyntaxError('The CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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
 * by name, so a model reading a chunk knows what each value is.
 */
export async function* loadCsv(
  inputs: FileInput | Iterable<FileInput>,
  options: CsvLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const { source, text } = await readText(input);
    const [header, ...rows] = parseCsv(text, options);
    if (!header) continue;
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

    for (const [rowIndex, fields] of rows.entries()) {
      if (fields.length === 1 && fields[0] === '') continue;
      const key = idIndex >= 0 ? fields[idIndex] : String(rowIndex + 1);
      yield {
        id: `${source}#${key}`,
        text: textIndexes
          .map((index) => `${header[index]}: ${fields[index] ?? ''}`)
          .filter((line) => !line.endsWith(': '))
          .join('\n'),
        source,
        metadata: {
          ...options.metadata,
          ...Object.fromEntries(metadataIndexes.map(([name, index]) => [name, fields[index] ?? ''])),
          row: rowIndex + 1,
        },
      };
    }
  }
}
