// Keeps the root import's deprecations and `nexus migrate`'s map in step with the export map.
//
//   node scripts/root-migration.mjs           rewrites both
//   node scripts/root-migration.mjs --check   fails when either is out of date
//
// 2.0.0 slims the root import to the core client, its config builders, its types, and the errors it
// throws. Everything else the root exports today also lives on a subpath; this script finds that
// subpath for each one, marks the root export `@deprecated` with it, and writes the table the
// codemod rewrites imports from. Both outputs are generated so they can never disagree.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const check = process.argv.includes('--check');
const INDEX = path.join(root, 'src', 'index.ts');
const MAP = path.join(root, 'src', 'cli', 'root-moves.ts');
const MARK = 'the 2.0 root drops it';

/** Errors the core client throws, which the 2.0 root keeps so `instanceof` needs no family import. */
const KEPT_ERRORS = new Set([
  'NexusCapabilityError',
  'NexusProviderError',
  'NexusRateLimitError',
  'NexusSecurityError',
  'TokenBudgetError',
  'CostBudgetError',
  'ResponseFormatError',
]);
/** Type modules the core client's own configuration, requests, and responses are made of. */
const KEPT_TYPE_FILES = new Set(
  [
    'config',
    'messages',
    'response',
    'providers',
    'planning',
    'capabilities',
    'security',
    'optimizer',
    'context-window',
    'agent',
  ].map((name) => `src/types/${name}.ts`),
);

function keptAtRoot(item) {
  if (item.file.startsWith('src/core/')) return true;
  if (item.name === 'tool' && item.file === 'src/agent/tool.ts') return true;
  if (KEPT_ERRORS.has(item.name)) return true;
  return item.isType && KEPT_TYPE_FILES.has(item.file);
}

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const entries = Object.entries(packageJson.exports)
  .filter(([, entry]) => entry?.import?.types)
  .map(([subpath, entry]) => ({
    subpath,
    file: path.join(root, entry.import.types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts')),
  }));
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(
  entries.map((entry) => entry.file),
  { ...parsed.options, noEmit: true },
);
const checker = program.getTypeChecker();

/** Every exported declaration, by identity, with the names it goes by on each entry point. */
const declarations = new Map();
for (const entry of entries) {
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry.file));
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = target.declarations?.[0];
    if (!declaration) continue;
    const key = `${declaration.getSourceFile().fileName}:${declaration.pos}:${target.name}`;
    const item = declarations.get(key) ?? {
      file: path.relative(root, declaration.getSourceFile().fileName).split(path.sep).join('/'),
      isType: !(target.flags & ts.SymbolFlags.Value),
      names: new Map(),
    };
    item.names.set(entry.subpath, exported.name);
    declarations.set(key, item);
  }
}

/** The most specific subpath that exports a declaration, as the guides' references choose. */
function homeOf(item) {
  const [subpath] = [...item.names.keys()]
    .filter((subpath) => subpath !== '.')
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return subpath;
}

const moves = new Map();
const homeless = [];
for (const item of declarations.values()) {
  const name = item.names.get('.');
  if (name === undefined) continue;
  const candidate = { name, file: item.file, isType: item.isType };
  if (keptAtRoot(candidate)) continue;
  const subpath = homeOf(item);
  if (!subpath) {
    homeless.push(`${name} (${item.file})`);
    continue;
  }
  const target = item.names.get(subpath);
  moves.set(name, { subpath: `nexus-ai-pro${subpath.slice(1)}`, name: target, isType: item.isType });
}
if (homeless.length > 0) {
  console.error(`These root exports move in 2.0 but no subpath exports them yet:\n  ${homeless.join('\n  ')}`);
  process.exit(1);
}

// ── The root index, with a deprecation on every specifier that moves ──────────────────────────

const indexText = readFileSync(INDEX, 'utf8');
const source = ts.createSourceFile(INDEX, indexText, ts.ScriptTarget.Latest, true);
const edits = [];
for (const statement of source.statements) {
  if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    continue;
  }
  for (const specifier of statement.exportClause.elements) {
    // Drop an earlier generated note, so the output depends only on the current map.
    const leading = ts.getLeadingCommentRanges(indexText, specifier.pos) ?? [];
    for (const range of leading) {
      if (!indexText.slice(range.pos, range.end).includes(MARK)) continue;
      const trailing = indexText.slice(range.end).match(/^\s*/)?.[0].length ?? 0;
      edits.push({ start: range.pos, end: range.end + trailing, text: '' });
    }
    const move = moves.get(specifier.name.text);
    if (!move) continue;
    const what = move.name === specifier.name.text ? '' : ` \`${move.name}\``;
    const start = specifier.getStart(source);
    // On a line of its own: a note sharing a line with the previous comma would be read as that
    // specifier's trailing comment. It also makes the formatter spread a one-line export out.
    const lineStart = /\n\s*$/.test(indexText.slice(0, start));
    edits.push({
      start,
      end: start,
      // Short, because it ships in both declaration builds: what to import, from where, and why.
      text: `${lineStart ? '' : '\n'}/** @deprecated Import${what} from '${move.subpath}'; ${MARK}. */\n`,
    });
  }
}
let nextIndex = indexText;
for (const edit of edits.sort((a, b) => b.start - a.start)) {
  nextIndex = nextIndex.slice(0, edit.start) + edit.text + nextIndex.slice(edit.end);
}
nextIndex = format(nextIndex, 'src/index.ts');

// ── The codemod's table ────────────────────────────────────────────────────────────────────────

const rows = [...moves].sort(([a], [b]) => a.localeCompare(b));
const nextMap = `// Generated by scripts/root-migration.mjs. Do not edit; run \`node scripts/root-migration.mjs\`.

/**
 * Where each export the 2.0 root import drops lives instead: the subpath, and the name it has there
 * when that differs. \`nexus migrate\` rewrites imports from it.
 */
export const ROOT_MOVES: Readonly<Record<string, readonly [subpath: string, name?: string]>> = {
${rows.map(([name, move]) => `  ${JSON.stringify(name)}: [${JSON.stringify(move.subpath)}${move.name === name ? '' : `, ${JSON.stringify(move.name)}`}],`).join('\n')}
};
`;
const formattedMap = format(nextMap, 'src/cli/root-moves.ts');

let currentMap = '';
try {
  currentMap = readFileSync(MAP, 'utf8');
} catch {}
const normalize = (text) => text.replace(/\s+/g, ' ');
const stale = [];
if (normalize(nextIndex) !== normalize(indexText)) stale.push('src/index.ts');
if (normalize(formattedMap) !== normalize(currentMap)) stale.push('src/cli/root-moves.ts');
if (check) {
  if (stale.length > 0) {
    console.error(`Out of date: ${stale.join(', ')}. Run: node scripts/root-migration.mjs`);
    process.exit(1);
  }
  console.log(`Root migration: ${moves.size} root exports move in 2.0, each deprecated and mapped.`);
} else {
  writeFileSync(INDEX, nextIndex);
  writeFileSync(MAP, formattedMap);
  console.log(
    `Root migration: ${moves.size} root exports marked deprecated and mapped${stale.length ? '' : ' (no change)'}.`,
  );
}

/** Formats generated source as the repository's formatter would, so a check compares like with like. */
function format(text, file) {
  const biome = path.join(root, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
  return execFileSync(process.execPath, [biome, 'format', `--stdin-file-path=${file}`], {
    cwd: root,
    input: text,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}
