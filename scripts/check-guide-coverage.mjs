#!/usr/bin/env node
/**
 * Guide coverage of the public API.
 *
 * Every feature has a guide under `docs/`, and each guide declares the entry points it covers in a
 * comment: `<!-- covers: ./graph ./graph/visualize -->`. This checks that every entry point in
 * `package.json` `exports` is covered by a guide, that every export of an entry point is named in a
 * guide covering it, and that the README links to every guide.
 *
 * An export is resolved to its declaration first, so a name the root re-exports from a family is
 * covered by that family's guide. A feature with no entry point of its own, reachable only from the
 * root, is claimed by the guide that names its source directories in a second comment:
 * `<!-- sources: src/security src/hallucination -->`.
 *
 * Each guide ends with a reference generated from the doc comments, between
 * `<!-- reference:start -->` and `<!-- reference:end -->`: every declaration is listed once, under the
 * most specific entry point that exports it, in the guide that covers that entry point. A stale
 * reference fails the check, as a stale size table does.
 *
 *   node scripts/check-guide-coverage.mjs            report, and fail on any gap or stale reference
 *   node scripts/check-guide-coverage.mjs --update   regenerate every guide's reference
 *   node scripts/check-guide-coverage.mjs --list     also list every export no guide names
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const list = process.argv.includes('--list');
const update = process.argv.includes('--update');
const REFERENCE_START = '<!-- reference:start -->';
const REFERENCE_END = '<!-- reference:end -->';
const SOURCES = /<!--\s*sources:\s*([^>]*?)\s*-->/g;

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const sourceOf = (entry) =>
  path.join(root, entry.import.types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'));
const entries = Object.entries(packageJson.exports)
  .filter(([, entry]) => entry?.import?.types)
  .map(([subpath, entry]) => ({ subpath, file: sourceOf(entry) }));

const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(
  entries.map((entry) => entry.file),
  { ...parsed.options, noEmit: true },
);
const checker = program.getTypeChecker();

function kindOf(symbol, declaration) {
  if (!declaration) return 'value';
  if (ts.isClassDeclaration(declaration)) return 'class';
  if (ts.isFunctionDeclaration(declaration)) return 'function';
  if (ts.isInterfaceDeclaration(declaration)) return 'interface';
  if (ts.isTypeAliasDeclaration(declaration)) return 'type';
  if (ts.isEnumDeclaration(declaration)) return 'enum';
  if (ts.isVariableDeclaration(declaration)) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    return type.getCallSignatures().length > 0 ? 'function' : 'constant';
  }
  return 'value';
}

function summaryOf(symbol) {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  const deprecated = symbol.getJsDocTags(checker).find((tag) => tag.name === 'deprecated');
  const paragraph = (text.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
  const sentence = paragraph.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? paragraph;
  const note = deprecated ? `Deprecated: ${ts.displayPartsToString(deprecated.text ?? []).trim()}` : '';
  return [note, sentence].filter(Boolean).join(' ').replace(/\|/g, '\\|');
}

/** declaration key -> { name, entries, kind, summary } */
const declarations = new Map();
for (const entry of entries) {
  const source = program.getSourceFile(entry.file);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Cannot read the exports of ${entry.subpath}`);
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    // Exported for other modules of this package only, as the doc-coverage check also treats it.
    if (target.getJsDocTags(checker).some((tag) => tag.name === 'internal')) continue;
    const declaration = target.declarations?.[0];
    const file = declaration ? path.relative(root, declaration.getSourceFile().fileName).split(path.sep).join('/') : '';
    const key = declaration
      ? `${declaration.getSourceFile().fileName}:${declaration.pos}:${exported.name}`
      : `${entry.subpath}:${exported.name}`;
    const item = declarations.get(key) ?? {
      name: exported.name,
      entries: new Set(),
      kind: kindOf(target, declaration),
      summary: summaryOf(target),
      file,
    };
    item.entries.add(entry.subpath);
    declarations.set(key, item);
  }
}

const docsDir = path.join(root, 'docs');
const guides = readdirSync(docsDir)
  .filter((file) => file.endsWith('.md'))
  .sort()
  .map((file) => {
    const text = readFileSync(path.join(docsDir, file), 'utf8');
    const markers = [...text.matchAll(/<!--\s*covers:\s*([^>]*?)\s*-->/g)];
    const covers = markers.flatMap((match) => (match[1] ?? '').split(/\s+/).filter(Boolean));
    const sources = [...text.matchAll(SOURCES)].flatMap((match) => (match[1] ?? '').split(/\s+/).filter(Boolean));
    return { file, text, covers: new Set(covers), sources, marked: markers.length > 0 };
  });

/** The most specific entry point, so a family's declarations are listed in the family's guide. */
function ownerOf(item) {
  return [...item.entries].sort(
    (a, b) => Number(a === '.') - Number(b === '.') || b.length - a.length || a.localeCompare(b),
  )[0];
}

/**
 * The guide that claims a declaration by its source directory, for a feature that has no entry point
 * of its own. The longest matching directory wins, so `src/images/stores` beats `src/images`.
 */
function claimedBy(item) {
  let best;
  for (const guide of guides) {
    for (const source of guide.sources) {
      if (item.file === source || item.file.startsWith(`${source}/`)) {
        if (!best || source.length > best.source.length) best = { guide, source };
      }
    }
  }
  return best?.guide;
}

/** Which guide lists a declaration, and under which heading. */
function placementOf(item) {
  const owner = ownerOf(item);
  if (owner !== '.') return { guide: guides.find((guide) => guide.covers.has(owner)), section: owner };
  const claimed = claimedBy(item);
  if (claimed) return { guide: claimed, section: 'root' };
  return { guide: guides.find((guide) => guide.covers.has('.')), section: '.' };
}

function referenceFor(guide) {
  const subpaths = [...guide.covers].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
  if (guide.sources.length > 0) subpaths.push('root');
  const sections = [];
  for (const subpath of subpaths) {
    const items = [...declarations.values()]
      .filter((item) => {
        const placement = placementOf(item);
        return placement.guide === guide && placement.section === subpath;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 0) continue;
    const specifier = subpath === '.' || subpath === 'root' ? 'nexus-ai-pro' : `nexus-ai-pro/${subpath.slice(2)}`;
    sections.push(
      [
        `### \`${specifier}\``,
        '',
        '| Export | Kind | Summary |',
        '| --- | --- | --- |',
        ...items.map((item) => `| \`${item.name}\` | ${item.kind} | ${item.summary} |`),
      ].join('\n'),
    );
  }
  return [
    '## Reference',
    '',
    'Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most',
    'specific entry point that provides it.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

const stale = [];
for (const guide of guides) {
  const start = guide.text.indexOf(REFERENCE_START);
  const end = guide.text.indexOf(REFERENCE_END);
  if (start < 0 || end < start) continue;
  const current = guide.text.slice(start, end + REFERENCE_END.length);
  const next = `${REFERENCE_START}\n${referenceFor(guide)}\n${REFERENCE_END}`;
  if (current === next) continue;
  if (update) {
    guide.text = guide.text.slice(0, start) + next + guide.text.slice(end + REFERENCE_END.length);
    writeFileSync(path.join(docsDir, guide.file), guide.text);
  } else {
    stale.push(guide.file);
  }
}

const problems = stale.map((file) => `docs/${file} has a stale reference. Run: npm run docs:update`);
const known = new Set(entries.map((entry) => entry.subpath));
for (const guide of guides) {
  if (!guide.marked) problems.push(`docs/${guide.file} declares no entry points (<!-- covers: ... -->)`);
  for (const subpath of guide.covers) {
    if (!known.has(subpath)) problems.push(`docs/${guide.file} covers ${subpath}, which is not an entry point`);
  }
}
for (const entry of entries) {
  if (!guides.some((guide) => guide.covers.has(entry.subpath))) problems.push(`no guide covers ${entry.subpath}`);
}

for (const item of declarations.values()) {
  if (!placementOf(item).guide) problems.push(`no guide lists ${item.name} (${item.file || 'unknown file'})`);
}

const mentions = (text, name) =>
  new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/\$/g, '\\$')}([^A-Za-z0-9_$]|$)`).test(text);
const missing = [];
for (const item of declarations.values()) {
  const placed = placementOf(item).guide;
  const covering = guides.filter(
    (guide) => guide === placed || [...item.entries].some((subpath) => guide.covers.has(subpath)),
  );
  if (!covering.some((guide) => mentions(guide.text, item.name))) {
    missing.push({ name: item.name, entries: [...item.entries], guides: covering.map((guide) => guide.file) });
  }
}

const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
for (const guide of guides) {
  if (!readme.includes(`docs/${guide.file}`)) problems.push(`README.md does not link to docs/${guide.file}`);
}

const total = declarations.size;
const covered = total - missing.length;
console.log(
  `Guide coverage: ${covered.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} exports named in a guide (${(
    (covered / total) * 100
  ).toFixed(2)}%), ${guides.length} guides covering ${entries.length} entry points.`,
);
if (list) {
  for (const item of missing.sort((a, b) => a.entries[0].localeCompare(b.entries[0]) || a.name.localeCompare(b.name))) {
    console.log(`  ${item.entries.join(', ')}  ${item.name}  (${item.guides.join(', ') || 'no guide'})`);
  }
}
for (const problem of problems) console.log(`  - ${problem}`);
if (missing.length > 0 || problems.length > 0) {
  console.log('Guide coverage is incomplete. Run with --list to see every export no guide names.');
  process.exit(1);
}
