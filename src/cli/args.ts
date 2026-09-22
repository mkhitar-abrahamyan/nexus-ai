import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Argument parsing and output shared by every `nexus` command, so each one reads its flags the same
 * way and every command's `--json` output can be piped into something else.
 */

export type Flags = Record<string, string | boolean>;

export interface ParsedArgs {
  positionals: string[];
  flags: Flags;
}

/** Flags that never take a value, so `--json file.json` keeps `file.json` as a positional. */
export const BOOLEAN_FLAGS = new Set([
  'all',
  'allow-dataset-mismatch',
  'densify',
  'fail',
  'fail-on-regression',
  'help',
  'json',
  'print',
  'reveal-values',
]);

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2) as [string, string | undefined];
    if (rawKey.startsWith('no-')) {
      flags[rawKey.slice(3)] = false;
      continue;
    }

    const next = args[index + 1];
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
    } else if (BOOLEAN_FLAGS.has(rawKey)) {
      flags[rawKey] = true;
    } else if (next && !next.startsWith('--')) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { positionals, flags };
}

export function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

export function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function numberFlag(flags: Flags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
  return parsed;
}

/** A comma-separated flag, as a list. `--tags a,b` and `--tags a --tags b` are not both supported; the first is. */
export function listFlag(flags: Flags, name: string): string[] | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
  const widths = Object.fromEntries(
    columns.map((column) => [column, Math.max(column.length, ...rows.map((row) => (row[column] ?? '').length))]),
  );
  console.log(columns.map((column) => column.padEnd(widths[column] as number)).join('  '));
  console.log(columns.map((column) => '-'.repeat(widths[column] as number)).join('  '));
  for (const row of rows) {
    console.log(columns.map((column) => (row[column] ?? '').padEnd(widths[column] as number)).join('  '));
  }
}

/** Imports a user's module by path, relative to the working directory. */
export async function loadModule(file: string): Promise<Record<string, unknown>> {
  const loaded = (await import(pathToFileURL(path.resolve(file)).href)) as Record<string, unknown>;
  // A module whose only export is a default object is read as that object.
  if (isRecord(loaded.default) && Object.keys(loaded).length === 1) return loaded.default;
  return loaded;
}

/** An error the user can act on, printed without a stack trace. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}
