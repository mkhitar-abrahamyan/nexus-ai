import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliUsageError, flagBool, type ParsedArgs, writeJson } from './args.js';
import { ROOT_MOVES } from './root-moves.js';

/** Deprecated type aliases 2.0 removes, and what replaces each, wherever it is imported from. */
const RENAMES: Readonly<Record<string, string>> = { ImageManagerConfig: 'ImageConfig' };
const PACKAGE = 'nexus-ai-pro';
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const FENCE_LANGUAGES = new Set(['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'mjs', 'cjs', 'mts', 'cts']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'dist-cjs', 'build', 'coverage', '.next', 'out']);

/** One thing `migrateSource()` changed, or found and left for a person. */
export interface MigrationNote {
  /** The line, starting at 1. */
  line: number;
  /** What was done, or what to do. */
  message: string;
}

/** What `migrateSource()` produced for one file's text. */
export interface MigrationOutcome {
  /** The text after migration; the input itself when nothing changed. */
  text: string;
  /** Imports rewritten and names renamed. */
  changes: MigrationNote[];
  /** What it found and could not rewrite safely, for a person to finish. */
  notes: MigrationNote[];
}

/**
 * Migrates one file's text to the 2.0 imports: names the root import drops are imported from their
 * subpaths, names that moved under another name keep their local name through an alias, and deprecated
 * aliases are replaced. What cannot be rewritten safely — a namespace import of the root, a dynamic
 * import, a read of `estimatedCost` — is reported instead of guessed at.
 *
 * Markdown is migrated inside its TypeScript and JavaScript code blocks only. Running it twice changes
 * nothing the second time.
 */
export function migrateSource(text: string, options: { file?: string } = {}): MigrationOutcome {
  const extension = path.extname(options.file ?? '').toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return migrateMarkdown(text);
  return migrateCode(text, 0);
}

/** Options for `migrateFiles()`. */
export interface MigrateFilesOptions {
  /** Writes the migrated files. Without it, nothing is written and the result says what would change. */
  write?: boolean;
}

/** What `migrateFiles()` did with one file. */
export interface FileMigration extends Omit<MigrationOutcome, 'text'> {
  /** The file, as given or found. */
  file: string;
  /** Whether its text changed. */
  changed: boolean;
}

/**
 * Migrates every source and Markdown file under the given paths, skipping `node_modules`, build
 * output, and version control. Files are written only with `write`.
 */
export async function migrateFiles(
  paths: readonly string[],
  options: MigrateFilesOptions = {},
): Promise<FileMigration[]> {
  const results: FileMigration[] = [];
  for (const file of await collect(paths)) {
    const original = await readFile(file, 'utf8');
    const outcome = migrateSource(original, { file });
    const changed = outcome.text !== original;
    if (changed && options.write) await writeFile(file, outcome.text);
    if (changed || outcome.notes.length > 0) {
      results.push({ file, changed, changes: outcome.changes, notes: outcome.notes });
    }
  }
  return results;
}

/**
 * `nexus migrate [paths…] [--write] [--check] [--json]` moves imports of the root to the subpaths the
 * 2.0 root import keeps them on. Without `--write` it only reports; `--check` exits 1 when a file still
 * needs migrating, for a CI job that keeps a codebase ready.
 */
export async function runMigrateCommand({ positionals, flags }: ParsedArgs): Promise<void> {
  const write = flagBool(flags, 'write');
  const checking = flagBool(flags, 'check');
  if (write && checking) throw new CliUsageError('--write and --check cannot be combined.');
  const results = await migrateFiles(positionals.length > 0 ? positionals : ['.'], { write });
  const pending = results.filter((result) => result.changed);

  if (flagBool(flags, 'json')) {
    writeJson({ written: write, files: results });
  } else {
    for (const result of results) {
      const verb = result.changed ? (write ? 'migrated' : 'would migrate') : 'needs a look';
      console.log(`${result.file}: ${verb}`);
      for (const change of result.changes) console.log(`  ${change.line}: ${change.message}`);
      for (const note of result.notes) console.log(`  ${note.line}: TODO ${note.message}`);
    }
    const notes = results.reduce((total, result) => total + result.notes.length, 0);
    const summary =
      pending.length === 0
        ? 'Nothing to migrate.'
        : write
          ? `Migrated ${pending.length} file${pending.length === 1 ? '' : 's'}.`
          : `${pending.length} file${pending.length === 1 ? '' : 's'} to migrate. Run again with --write.`;
    console.log(notes > 0 ? `${summary} ${notes} place${notes === 1 ? '' : 's'} to finish by hand.` : summary);
  }
  if (checking && pending.length > 0) process.exitCode = 1;
}

// ── Markdown ───────────────────────────────────────────────────────

function migrateMarkdown(text: string): MigrationOutcome {
  const changes: MigrationNote[] = [];
  const notes: MigrationNote[] = [];
  const fence = /^([ \t]*)(```+|~~~+)[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
  let output = '';
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const language = (match[3] ?? '').toLowerCase();
    if (!FENCE_LANGUAGES.has(language)) continue;
    const body = match[4] as string;
    // The body begins on the line after the opening fence.
    const bodyStart = (match.index ?? 0) + match[0].indexOf('\n') + 1;
    const offset = lineOf(text, bodyStart) - 1;
    const outcome = migrateCode(body, offset);
    changes.push(...outcome.changes);
    notes.push(...outcome.notes);
    if (outcome.text === body) continue;
    output += text.slice(last, bodyStart) + outcome.text;
    last = bodyStart + body.length;
  }
  return { text: last === 0 ? text : output + text.slice(last), changes, notes };
}

// ── Source ─────────────────────────────────────────────────────────

interface Specifier {
  type: boolean;
  name: string;
  alias?: string;
}

/** `import { … } from 'nexus-ai-pro…'`, `import type { … }`, and `export { … } from`, in any layout. */
const NAMED =
  /^([ \t]*)(import|export)(\s+type)?\s*\{([^}]*)\}\s*from\s*(['"])(nexus-ai-pro(?:\/[\w./-]+)?)\5([ \t]*;?)/gm;
/** `const { … } = require('nexus-ai-pro…')`. */
const REQUIRE =
  /^([ \t]*)(const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])(nexus-ai-pro(?:\/[\w./-]+)?)\4\s*\)([ \t]*;?)/gm;

function migrateCode(text: string, lineOffset: number): MigrationOutcome {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const changes: MigrationNote[] = [];
  const notes: MigrationNote[] = [];
  const at = (index: number) => lineOf(text, index) + lineOffset;

  let output = text.replace(
    NAMED,
    (
      whole,
      indent: string,
      keyword: string,
      typeOnly: string | undefined,
      body: string,
      quote: string,
      from: string,
      end: string,
      index: number,
    ) => {
      const specifiers = parseSpecifiers(body, false);
      if (!specifiers) return whole;
      const rewritten = rewrite(specifiers, from, (message) => changes.push({ line: at(index), message }));
      if (!rewritten) return whole;
      const multiline = body.includes('\n');
      return rewritten
        .map(
          ([module, list]) =>
            `${indent}${keyword}${typeOnly ? ' type' : ''} ${braces(list, indent, multiline, eol, false)} from ${quote}${module}${quote}${end}`,
        )
        .join(eol);
    },
  );

  output = output.replace(
    REQUIRE,
    (
      whole,
      indent: string,
      declaration: string,
      body: string,
      quote: string,
      from: string,
      end: string,
      index: number,
    ) => {
      const specifiers = parseSpecifiers(body, true);
      if (!specifiers) return whole;
      const rewritten = rewrite(specifiers, from, (message) => changes.push({ line: at(index), message }));
      if (!rewritten) return whole;
      const multiline = body.includes('\n');
      return rewritten
        .map(
          ([module, list]) =>
            `${indent}${declaration} ${braces(list, indent, multiline, eol, true)} = require(${quote}${module}${quote})${end}`,
        )
        .join(eol);
    },
  );

  for (const match of text.matchAll(/import\s+\*\s+as\s+\w+\s+from\s*['"]nexus-ai-pro['"]/g)) {
    notes.push({
      line: at(match.index ?? 0),
      message: 'a namespace import of the root: import each name from its subpath',
    });
  }
  for (const match of text.matchAll(/export\s+\*\s+from\s*['"]nexus-ai-pro['"]/g)) {
    notes.push({ line: at(match.index ?? 0), message: 're-exports the whole root: re-export the subpaths you need' });
  }
  for (const match of text.matchAll(/\bimport\(\s*['"]nexus-ai-pro['"]\s*\)/g)) {
    notes.push({
      line: at(match.index ?? 0),
      message: 'a dynamic import of the root: import the subpath that has what you use',
    });
  }
  for (const match of text.matchAll(/(?:const|let|var)\s+\w+\s*=\s*require\(\s*['"]nexus-ai-pro['"]\s*\)/g)) {
    notes.push({
      line: at(match.index ?? 0),
      message: 'requires the whole root: require the subpaths that have what you use',
    });
  }
  // A plan's `estimatedCost` is an object and stays; the response's is a string, read as it is.
  for (const match of text.matchAll(/\.estimatedCost\b(?!\s*[.?[])/g)) {
    notes.push({
      line: at(match.index ?? 0),
      message: "a response's `estimatedCost` string is removed in 2.0: read `cost.amount`, a number, and format it",
    });
  }
  for (const { pattern, message } of REMOVED_OPTIONS) {
    for (const match of text.matchAll(pattern)) notes.push({ line: at(match.index ?? 0), message });
  }
  for (const match of text.matchAll(/(['"`])([\w./-]+)\1/g)) {
    const name = match[2] as string;
    const replacement = Object.hasOwn(REMOVED_MODELS, name) ? REMOVED_MODELS[name] : undefined;
    if (replacement) {
      notes.push({
        line: at(match.index ?? 0),
        message: `the model \`${name}\` is not in the 2.0 registry, because its provider shut it down or never served that name: use \`${replacement}\``,
      });
    }
  }
  return { text: output, changes, notes };
}

/**
 * Model names and aliases the 2.0 registry dropped, with what to use instead. They are reported
 * rather than rewritten, since a different model changes behavior and cost.
 */
const REMOVED_MODELS: Readonly<Record<string, string>> = {
  'gpt-4.5-preview': 'gpt-4.1',
  'o1-mini': 'o4-mini',
  'gpt-5-codex': 'gpt-5.3-codex',
  'gpt-5-chat-latest': 'gpt-5.6-sol',
  'claude-sonnet-5-0': 'claude-sonnet-5-5',
  'claude-haiku-5-0': 'claude-haiku-4-5',
  'claude-fable-5-0': 'claude-fable-5-1',
  'claude-opus-4-1-20250805': 'claude-opus-5-5',
  'claude-opus-4.1': 'claude-opus-5-5',
  'claude-opus-4-1': 'claude-opus-5-5',
  'claude-opus-4-20250514': 'claude-opus-5-5',
  'claude-opus-4': 'claude-opus-5-5',
  'claude-opus-4-0': 'claude-opus-5-5',
  'claude-sonnet-4-20250514': 'claude-sonnet-5-5',
  'claude-sonnet-4': 'claude-sonnet-5-5',
  'claude-sonnet-4-0': 'claude-sonnet-5-5',
  'claude-3-7-sonnet-20250219': 'claude-sonnet-5-5',
  'claude-sonnet-3.7': 'claude-sonnet-5-5',
  'claude-3-7-sonnet-latest': 'claude-sonnet-5-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-5-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-5-5',
  'claude-sonnet-3.5': 'claude-sonnet-5-5',
  'claude-3-5-sonnet-latest': 'claude-sonnet-5-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-haiku-3.5': 'claude-haiku-4-5',
  'claude-3-5-haiku-latest': 'claude-haiku-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'gemini-3.5-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-preview': 'gemini-3.5-flash-lite',
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
  'gemini-2.5-flash-lite-preview-09-2025': 'gemini-3.5-flash-lite',
  'gemini-2.0-flash': 'gemini-3.6-flash',
  'gemini-1.5-pro': 'gemini-3.1-pro-preview',
  'gemini-1.5-flash': 'gemini-3.5-flash',
  'groq/compound': 'groq/openai/gpt-oss-120b',
  'groq/groq/compound': 'groq/openai/gpt-oss-120b',
  'groq/groq/compound-mini': 'groq/openai/gpt-oss-20b',
  'groq/meta-llama/llama-4-scout-17b-16e-instruct': 'groq/openai/gpt-oss-120b',
  'groq/qwen/qwen3-32b': 'groq/qwen/qwen3.8-27b',
  'mistral/ministral-3b': 'mistral/ministral-3b-2512',
  'mistral/ministral-8b': 'mistral/ministral-8b-2512',
  'mistral/pixtral-12b': 'mistral/ministral-14b-2512',
  'mistral/pixtral-large-2411': 'mistral/mistral-medium-2604',
  'mistral/mistral-medium-3-5': 'mistral/mistral-medium-2604',
  'mistral/devstral-2512': 'mistral/mistral-medium-2604',
  'mistral/devstral-2': 'mistral/mistral-medium-2604',
  'mistral/magistral-medium-2509': 'mistral/mistral-medium-2604',
  'deepseek/deepseek-v3': 'deepseek/deepseek-flash',
  'deepseek/deepseek-chat': 'deepseek/deepseek-flash',
  'deepseek/deepseek-r1': 'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-reasoner': 'deepseek/deepseek-v4-pro',
  'cohere/command-r-plus': 'cohere/command-r-plus-08-2024',
  'cohere/command-r': 'cohere/command-r-08-2024',
};

/**
 * Options and fields 2.0 removed, found by name. A name can belong to something else in the
 * application, so each is reported for a person to check rather than deleted.
 */
const REMOVED_OPTIONS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bmodalities\s*:\s*\[[^\]]*['"](?:vision|pdf)['"]/g,
    message:
      '`modalities` is removed in 2.0: write `inputModalities` and `outputModalities`, where `vision` is an image in and `image` is an image out',
  },
  {
    pattern: /\bprojectId\s*:/g,
    message: 'if this is a Google provider config, `projectId` was never read and is removed in 2.0: delete it',
  },
  {
    pattern: /\bpreserveMarkdown\s*:/g,
    message: '`DensificationConfig.preserveMarkdown` was never read and is removed in 2.0: delete it',
  },
  {
    pattern: /\blatencyHalfLife\s*:/g,
    message: '`HealthConfig.latencyHalfLife` was never read and is removed in 2.0: delete it',
  },
  {
    pattern: /\bprometheus\s*:\s*(?:true|false)\b/g,
    message:
      'if this is a metrics config, `prometheus` was never read and is removed in 2.0: delete it; `getPrometheusMetrics()` always works',
  },
  {
    pattern: /\brequiresApproval\s*:/g,
    message:
      '`ToolPolicyConfig.requiresApproval` was never read and is removed in 2.0: require approval in the agent with `interruptOn`',
  },
  {
    pattern: /\bsensitivity\s*:/g,
    message: 'if this is injection detection, `sensitivity` was never read and is removed in 2.0: delete it',
  },
];

/** The specifiers of `{ … }`, or nothing when the list holds something this does not understand. */
function parseSpecifiers(body: string, destructuring: boolean): Specifier[] | undefined {
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const specifiers: Specifier[] = [];
  for (const part of cleaned.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const match = destructuring
      ? /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(item)
      : /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(item);
    if (!match) return undefined;
    specifiers.push(
      destructuring
        ? { type: false, name: match[1] as string, ...(match[2] ? { alias: match[2] } : {}) }
        : { type: Boolean(match[1]), name: match[2] as string, ...(match[3] ? { alias: match[3] } : {}) },
    );
  }
  return specifiers;
}

/**
 * Splits a statement's specifiers by the module each comes from after migration, or returns
 * nothing when none moves or is renamed.
 */
function rewrite(
  specifiers: readonly Specifier[],
  from: string,
  record: (message: string) => void,
): Array<[string, Specifier[]]> | undefined {
  const groups = new Map<string, Specifier[]>();
  let touched = false;
  for (const specifier of specifiers) {
    let module = from;
    let name = specifier.name;
    const move = from === PACKAGE ? ROOT_MOVES[specifier.name] : undefined;
    if (move) {
      [module] = move;
      name = move[1] ?? specifier.name;
      record(`${specifier.name}: from '${module}'${name === specifier.name ? '' : ` as ${name}`}`);
      touched = true;
    }
    const replacement = RENAMES[name];
    if (replacement) {
      record(`${name}: renamed ${replacement}`);
      name = replacement;
      touched = true;
    }
    const local = specifier.alias ?? specifier.name;
    const entry: Specifier = { type: specifier.type, name, ...(local === name ? {} : { alias: local }) };
    groups.set(module, [...(groups.get(module) ?? []), entry]);
  }
  if (!touched) return undefined;
  // The statement keeps its own module first, and the subpaths follow in a stable order.
  return [...groups].sort(([a], [b]) => (a === from ? -1 : b === from ? 1 : a.localeCompare(b)));
}

function braces(
  list: readonly Specifier[],
  indent: string,
  multiline: boolean,
  eol: string,
  destructuring: boolean,
): string {
  const items = list.map((item) =>
    destructuring
      ? item.alias
        ? `${item.name}: ${item.alias}`
        : item.name
      : `${item.type ? 'type ' : ''}${item.name}${item.alias ? ` as ${item.alias}` : ''}`,
  );
  // A group split off a long import keeps its layout only when it still lists several names.
  if (!multiline || items.length === 1) return `{ ${items.join(', ')} }`;
  return `{${eol}${items.map((item) => `${indent}  ${item},`).join(eol)}${eol}${indent}}`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (
    let position = text.indexOf('\n');
    position !== -1 && position < index;
    position = text.indexOf('\n', position + 1)
  ) {
    line += 1;
  }
  return line;
}

async function collect(paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  const visit = async (target: string): Promise<void> => {
    const info = await stat(target);
    if (info.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(path.basename(target))) return;
      for (const entry of (await readdir(target)).sort()) await visit(path.join(target, entry));
      return;
    }
    const extension = path.extname(target).toLowerCase();
    if (CODE_EXTENSIONS.has(extension) || MARKDOWN_EXTENSIONS.has(extension)) files.push(target);
  };
  for (const target of paths) await visit(target);
  return files;
}
