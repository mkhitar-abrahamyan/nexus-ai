// Keeps the root import slim and `nexus migrate`'s map true.
//
//   node scripts/root-migration.mjs --check
//
// 2.0.0 slimmed the root import to the core client, its config builders, its types, the errors it
// throws, and the lifecycle every operation runs through. This check fails when anything else is
// exported from the root again, and when an entry of the codemod's map, frozen as 1.25 wrote it, no
// longer resolves: every name it moves must be gone from the root and exported where it points.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAP = path.join(root, 'src', 'cli', 'root-moves.ts');

/** Errors the core client throws, which the root keeps so `instanceof` needs no family import. */
const KEPT_ERRORS = new Set([
  'NexusCapabilityError',
  'NexusProviderError',
  'NexusRateLimitError',
  'NexusSecurityError',
  'TokenBudgetError',
  'CostBudgetError',
  'ResponseFormatError',
]);
/** Type modules the core client's own configuration, requests, responses, and lifecycle are made of. */
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
    'lifecycle',
  ].map((name) => `src/types/${name}.ts`),
);
/** The tool helpers every client user writes tools with. */
const KEPT_TOOL_HELPERS = new Set(['tool', 'toolOutput']);

function keptAtRoot(item) {
  if (item.file.startsWith('src/core/')) return true;
  if (KEPT_TOOL_HELPERS.has(item.name) && item.file === 'src/agent/tool.ts') return true;
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

/** Every name each entry point exports, with where the declaration behind it lives. */
const exportsBySubpath = new Map();
for (const entry of entries) {
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry.file));
  const names = new Map();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = target.declarations?.[0];
    if (!declaration) continue;
    names.set(exported.name, {
      name: exported.name,
      file: path.relative(root, declaration.getSourceFile().fileName).split(path.sep).join('/'),
      isType: !(target.flags & ts.SymbolFlags.Value),
    });
  }
  exportsBySubpath.set(entry.subpath, names);
}

const problems = [];
const rootExports = exportsBySubpath.get('.') ?? new Map();
for (const item of rootExports.values()) {
  if (!keptAtRoot(item))
    problems.push(`the root exports ${item.name} (${item.file}); export it from its family's subpath`);
}

// The map is source the codemod imports; read it as data.
const mapText = readFileSync(MAP, 'utf8');
const rows = [...mapText.matchAll(/^\s+(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*\['([^']+)'(?:,\s*'([^']+)')?\],$/gm)];
for (const row of rows) {
  const name = row[1] ?? row[2];
  const subpath = row[3];
  const target = row[4] ?? name;
  if (rootExports.has(name)) problems.push(`${name} is mapped as moved but the root still exports it`);
  const key = `.${subpath.slice('nexus-ai-pro'.length)}`;
  const exported = exportsBySubpath.get(key);
  if (!exported) problems.push(`${name} is mapped to ${subpath}, which is not an entry point`);
  else if (!exported.has(target))
    problems.push(`${name} is mapped to ${target} on ${subpath}, which does not export it`);
}

if (problems.length > 0) {
  console.error(`Root import check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `Root import: ${rootExports.size} core exports; ${rows.length} moved names each resolve where nexus migrate points.`,
);
