#!/usr/bin/env node
/**
 * Measures what each export subpath actually costs to import, and holds it to a budget.
 *
 * The package already budgets the whole tarball, which is why per-entry growth went unnoticed
 * across three releases while the total budget was raised three times. A shared module pulled into
 * an otherwise small entry point does not move the tarball at all — it only moves what a consumer
 * pays to import one piece, which is the property this package sells.
 *
 *   node scripts/check-subpath-sizes.mjs            # fail if an entry point exceeded its budget
 *   node scripts/check-subpath-sizes.mjs --update   # rewrite the budget from current measurements
 *   node scripts/check-subpath-sizes.mjs --table    # print the markdown table for the packaging guide
 *
 * Cost is the transitive ESM import graph under `dist/`, which is what Node parses on first import.
 * It deliberately ignores the CommonJS build, since the two track each other.
 *
 * Package code is only half of what an install costs. An entry point that imports a third-party
 * package makes the consumer install that package and everything it depends on, which the per-file
 * measurement above cannot see, so each row also reports the installed weight of the dependencies it
 * pulls in. That number is why `/graph` at 52 KB and `/security` at 44 KB are not comparable: one
 * needs nothing, the other drags in a validator.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const budgetFile = path.join(repoRoot, 'size-budget.json');
// The table lives in the packaging guide, which the README links to.
const readmeFile = path.join(repoRoot, 'docs', 'packaging.md');

const TABLE_START = '<!-- size-table:start -->';
const TABLE_END = '<!-- size-table:end -->';

/** Headroom added when writing a new budget, so ordinary churn does not fail the build. */
const HEADROOM = 1.1;

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return resolved.endsWith('.js') ? resolved : `${resolved}.js`;
}

/** Package name from a bare specifier, keeping the scope and dropping any subpath. */
function packageOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const installedSizes = new Map();

function directorySize(directory) {
  let bytes = 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directorySize(full);
    else {
      try {
        bytes += statSync(full).size;
      } catch {
        // A broken symlink costs nothing to install.
      }
    }
  }
  return bytes;
}

/** Installed weight of a package plus everything it depends on, counted once each. */
function installedWeight(names, seen = new Set()) {
  let bytes = 0;
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const directory = path.join(repoRoot, 'node_modules', name);
    if (!installedSizes.has(name)) installedSizes.set(name, directorySize(directory));
    const size = installedSizes.get(name);
    if (size === 0) continue;
    bytes += size;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    bytes += installedWeight(Object.keys(manifest.dependencies ?? {}), seen);
  }
  return bytes;
}

/** Every file Node would load when the entry point is imported. */
function importGraph(entryFile) {
  const seen = new Set();
  const packages = new Set();
  const stack = [entryFile];

  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.add(file);
    // Static imports only. A dynamic import is deferred cost, not import cost, and counting it
    // would penalise exactly the lazy-loading this budget is meant to encourage.
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, match[1]);
      if (next) {
        stack.push(next);
        continue;
      }
      // A bare specifier is a package the consumer has to install, which the file walk cannot see.
      const dependency = packageOf(match[1]);
      if (dependency) packages.add(dependency);
    }
  }
  return { files: seen, packages };
}

function measure() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const rows = [];

  for (const [subpath, entry] of Object.entries(packageJson.exports)) {
    const relative = entry?.import?.default?.replace(/^\.\//, '');
    if (!relative) continue;
    const entryFile = path.join(repoRoot, relative);

    const { files, packages } = importGraph(entryFile);
    let bytes = 0;
    for (const file of files) {
      try {
        bytes += statSync(file).size;
      } catch {
        // A declaration-only module leaves no JS file; it costs nothing to import.
      }
    }
    rows.push({
      subpath,
      kb: Math.round(bytes / 1024),
      files: files.size,
      packages: [...packages].sort(),
      dependencyKb: Math.round(installedWeight([...packages]) / 1024),
    });
  }

  if (rows.length === 0) {
    console.error('No subpaths measured. Run `npm run build` first.');
    process.exit(1);
  }
  return rows.sort((a, b) => b.kb - a.kb);
}

function readBudget() {
  try {
    return JSON.parse(readFileSync(budgetFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function formatKb(kb) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

function renderTable(rows) {
  const root = rows.find((row) => row.subpath === '.');
  const shown = rows.filter((row) => row.subpath !== '.');
  const share = (kb) => {
    const percent = (kb / root.kb) * 100;
    return percent >= 1 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
  };

  // A row with no third-party install is the point of the package, so it is worth showing as such.
  const dependencies = (row) => (row.dependencyKb > 0 ? `+${formatKb(row.dependencyKb)}` : 'none');
  const lines = [
    '| Import | Size | Share of root | Third-party install |',
    '| --- | --- | --- | --- |',
    `| \`nexus-ai-pro\` | ${root.kb} KB | 100% | ${dependencies(root)} |`,
    ...shown.map(
      (row) => `| \`nexus-ai-pro${row.subpath.slice(1)}\` | ${row.kb} KB | ${share(row.kb)} | ${dependencies(row)} |`,
    ),
  ];
  return lines.join('\n');
}

const rows = measure();
const mode = process.argv.includes('--update') ? 'update' : process.argv.includes('--table') ? 'table' : 'check';

if (mode === 'table') {
  console.log(renderTable(rows));
  process.exit(0);
}

if (mode === 'update') {
  const budget = {
    note: 'Generated by scripts/check-subpath-sizes.mjs --update. Transitive ESM import cost in KB.',
    measuredAt: new Date().toISOString().slice(0, 10),
    maxKb: Object.fromEntries(
      [...rows]
        .sort((a, b) => a.subpath.localeCompare(b.subpath))
        .map((row) => [row.subpath, Math.max(2, Math.ceil((row.kb * HEADROOM) / 2) * 2)]),
    ),
  };
  writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');

  const readme = readFileSync(readmeFile, 'utf8');
  if (readme.includes(TABLE_START)) {
    const updated = readme.replace(
      new RegExp(`${TABLE_START}[\\s\\S]*?${TABLE_END}`),
      `${TABLE_START}\n${renderTable(rows)}\n${TABLE_END}`,
    );
    writeFileSync(readmeFile, updated, 'utf8');
  }
  console.log(`Wrote budgets for ${rows.length} subpaths, and refreshed the size table in docs/packaging.md.`);
  process.exit(0);
}

const budget = readBudget();
if (!budget) {
  console.error('Missing size-budget.json. Run: npm run size:update');
  process.exit(1);
}

const problems = [];
for (const row of rows) {
  const max = budget.maxKb[row.subpath];
  if (max === undefined) {
    problems.push(`${row.subpath}: no budget recorded (${row.kb} KB). Run: npm run size:update`);
    continue;
  }
  if (row.kb > max) {
    problems.push(
      `${row.subpath}: ${row.kb} KB exceeds its ${max} KB budget. Check what new import reached this entry point, or run: npm run size:update`,
    );
  }
}

for (const subpath of Object.keys(budget.maxKb)) {
  if (!rows.some((row) => row.subpath === subpath)) {
    problems.push(`${subpath}: budgeted but no longer exported. Run: npm run size:update`);
  }
}

// The size table is a published claim, so a stale one is a correctness problem.
const readme = readFileSync(readmeFile, 'utf8');
if (readme.includes(TABLE_START)) {
  const current = readme.slice(readme.indexOf(TABLE_START) + TABLE_START.length, readme.indexOf(TABLE_END));
  if (current.trim() !== renderTable(rows).trim()) {
    problems.push('The size table in docs/packaging.md is out of date. Run: npm run size:update');
  }
}

if (problems.length > 0) {
  console.error('Subpath size check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const root = rows.find((row) => row.subpath === '.');
const smallest = rows[rows.length - 1];
const dependencyFree = rows.filter((row) => row.dependencyKb === 0).length;
console.log(
  `Subpath sizes are within budget: ${rows.length} entry points, root ${root.kb} KB, smallest ${smallest.subpath} at ${smallest.kb} KB.`,
);
console.log(
  `Third-party install cost: ${dependencyFree} of ${rows.length} entry points pull in no dependency at all; the root pulls in ${formatKb(root.dependencyKb)}.`,
);
