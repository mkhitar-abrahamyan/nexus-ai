#!/usr/bin/env node
/**
 * Which entry points run on any JavaScript runtime, and which need Node.js.
 *
 * Each export subpath's ESM import graph under `dist/` is walked: static imports, re-exports, and
 * dynamic `import()`. An entry point needs Node.js when anything it reaches imports a Node built-in
 * statically, or reads one of Node's globals unguarded: `Buffer`, `process`, `require`, `__dirname`,
 * and the like. A built-in imported only dynamically is loaded when a feature is used, so that entry
 * point is portable with a note naming what loads Node.
 *
 * The kernel, listed below, promises more: nothing Node-only at all, not even dynamically. The check
 * fails when a kernel entry point reaches Node, or when the table in the runtimes guide no longer
 * matches what the graph says.
 *
 *   node scripts/check-portability.mjs            # fail on a kernel breach or a stale table
 *   node scripts/check-portability.mjs --update   # refresh the table in docs/runtimes.md
 */
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const guide = path.join(root, 'docs', 'runtimes.md');
const TABLE_START = '<!-- runtimes:start -->';
const TABLE_END = '<!-- runtimes:end -->';

/** Entry points that must never reach anything Node-only, statically or dynamically. */
const KERNEL = [
  '.',
  './core',
  './config',
  './runtime',
  './streaming',
  './capabilities',
  './providers',
  './providers/base',
  './providers/errors',
  './providers/type-guards',
  './providers/openai',
  './providers/anthropic',
  './providers/google',
  './providers/cohere',
  './providers/azure-openai',
  './providers/deepseek',
  './providers/groq',
  './providers/mistral',
  './providers/openrouter',
  './providers/ollama',
  './providers/lmstudio',
  './providers/llamacpp',
  './graph',
  './agent',
  './agent/permissions',
  './agent/middleware',
  './protocols/ag-ui',
  './protocols/a2a',
  './protocols/acp',
];

const NODE_GLOBALS = new Set([
  'Buffer',
  'process',
  'require',
  '__dirname',
  '__filename',
  'setImmediate',
  'clearImmediate',
]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isBuiltin = (specifier) => specifier.startsWith('node:') || builtins.has(specifier);

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const entries = Object.entries(packageJson.exports)
  .filter(([, entry]) => entry?.import?.default)
  .map(([subpath, entry]) => ({ subpath, file: path.join(root, entry.import.default) }));

/** What one file imports and which Node globals it reads, parsed once. */
const parsed = new Map();
function parse(file) {
  const cached = parsed.get(file);
  if (cached) return cached;
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  const declared = new Set();
  const guarded = new Set();
  const globals = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push({ specifier: node.moduleSpecifier.text, dynamic: false });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, dynamic: true });
    } else if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) {
      guarded.add(node.expression.text);
    } else if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text);
    } else if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
          parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent);
      if (!isName) globals.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const result = {
    imports,
    // A global the file declares itself, or checks with `typeof` before reading, is not a dependency.
    globals: [...globals].filter((name) => !declared.has(name) && !guarded.has(name)),
  };
  parsed.set(file, result);
  return result;
}

/** What an entry point reaches that needs Node: built-ins static and dynamic, and globals. */
function reach(start) {
  const staticBuiltins = new Map();
  const dynamicBuiltins = new Map();
  const globals = new Map();
  const dynamicGlobals = new Map();
  const seen = new Set();
  const walk = (file, dynamic) => {
    const key = `${file}|${dynamic}`;
    if (seen.has(key) || seen.has(`${file}|false`)) return;
    seen.add(key);
    if (!existsSync(file)) throw new Error(`${path.relative(root, file)} is missing: run npm run build first`);
    const { imports, globals: read } = parse(file);
    const where = path.relative(path.join(root, 'dist'), file).replace(/\\/g, '/');
    // A file reached only through `import()` runs when its feature is used, not on import.
    const readers = dynamic ? dynamicGlobals : globals;
    for (const name of read) readers.set(name, readers.get(name) ?? where);
    for (const item of imports) {
      if (item.specifier.startsWith('.'))
        walk(path.resolve(path.dirname(file), item.specifier), dynamic || item.dynamic);
      else if (isBuiltin(item.specifier)) {
        const name = item.specifier.startsWith('node:') ? item.specifier : `node:${item.specifier}`;
        const target = dynamic || item.dynamic ? dynamicBuiltins : staticBuiltins;
        if (!target.has(name)) target.set(name, where);
      }
    }
  };
  walk(start, false);
  for (const name of staticBuiltins.keys()) dynamicBuiltins.delete(name);
  for (const name of globals.keys()) dynamicGlobals.delete(name);
  return { staticBuiltins, dynamicBuiltins, globals, dynamicGlobals };
}

const rows = entries.map(({ subpath, file }) => {
  const found = reach(file);
  const nodeOnly = found.staticBuiltins.size > 0 || found.globals.size > 0;
  return { subpath, ...found, nodeOnly };
});

const problems = [];
for (const subpath of KERNEL) {
  const row = rows.find((item) => item.subpath === subpath);
  if (!row) {
    problems.push(`${subpath} is in the kernel list but is not exported`);
    continue;
  }
  const breaches = [
    ...[...row.staticBuiltins].map(([name, where]) => `imports ${name} (${where})`),
    ...[...row.dynamicBuiltins].map(([name, where]) => `loads ${name} (${where})`),
    ...[...row.globals].map(([name, where]) => `reads the global ${name} (${where})`),
    ...[...row.dynamicGlobals].map(([name, where]) => `loads code that reads the global ${name} (${where})`),
  ];
  for (const breach of breaches) problems.push(`${subpath} must run on any runtime, but it ${breach}`);
}

const label = (row) => `\`nexus-ai-pro${row.subpath === '.' ? '' : row.subpath.slice(1)}\``;
const list = (map) => [...map.keys()].map((name) => `\`${name}\``).join(', ');
const needs = (modules, globals) =>
  [list(modules), [...globals.keys()].map((name) => `the \`${name}\` global`).join(', ')].filter(Boolean).join('; ');
const nodeOnly = rows.filter((row) => row.nodeOnly);
const lazy = rows.filter((row) => !row.nodeOnly && (row.dynamicBuiltins.size > 0 || row.dynamicGlobals.size > 0));
const table = [
  TABLE_START,
  '',
  `Of ${rows.length} entry points, ${rows.length - nodeOnly.length} run on any runtime. These need Node.js, or a runtime with Node compatibility, and what they need:`,
  '',
  '| Entry point | Needs |',
  '| --- | --- |',
  ...nodeOnly.map((row) => `| ${label(row)} | ${needs(row.staticBuiltins, row.globals)} |`),
  '',
  'These run anywhere, and load a Node module only when a feature that needs it is used:',
  '',
  '| Entry point | Loads, when used |',
  '| --- | --- |',
  ...lazy.map((row) => `| ${label(row)} | ${needs(row.dynamicBuiltins, row.dynamicGlobals)} |`),
  '',
  TABLE_END,
].join('\n');

const text = readFileSync(guide, 'utf8').replace(/\r\n/g, '\n');
const start = text.indexOf(TABLE_START);
const end = text.indexOf(TABLE_END);
if (start === -1 || end === -1) {
  console.error(`docs/runtimes.md has no ${TABLE_START} … ${TABLE_END} block`);
  process.exit(1);
}
const updated = text.slice(0, start) + table + text.slice(end + TABLE_END.length);

if (process.argv.includes('--update')) {
  writeFileSync(guide, updated, 'utf8');
  console.log(
    `Refreshed the runtimes table: ${rows.length - nodeOnly.length} of ${rows.length} entry points portable.`,
  );
} else if (updated !== text) {
  problems.push('The runtimes table in docs/runtimes.md is out of date. Run: npm run size:update');
}

if (problems.length) {
  console.error('Portability check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
if (!process.argv.includes('--update')) {
  console.log(
    `Portability: ${KERNEL.length} kernel entry points reach nothing Node-only; ${rows.length - nodeOnly.length} of ${rows.length} run on any runtime.`,
  );
}
