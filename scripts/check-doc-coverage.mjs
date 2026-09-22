#!/usr/bin/env node
/**
 * Documentation coverage of the public API.
 *
 * Walks every entry point in `package.json` `exports`, resolves each export to its original
 * declaration, and checks that it carries a doc comment — the symbol itself, and the public members of
 * exported classes, interfaces, enums, and object types. A declaration exported from several entry
 * points is counted once.
 *
 *   node scripts/check-doc-coverage.mjs            report, and fail below 100%
 *   node scripts/check-doc-coverage.mjs --list     also list every undocumented item
 *   node scripts/check-doc-coverage.mjs --min 95   fail below another threshold
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const list = args.includes('--list');
const minIndex = args.indexOf('--min');
const minimum = minIndex >= 0 ? Number(args[minIndex + 1]) : 100;

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const entries = [
  ...new Set(
    Object.values(packageJson.exports).map((entry) =>
      path.join(root, entry.import.types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts')),
    ),
  ),
];

const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(entries, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();
const sourceRoot = path.join(root, 'src') + path.sep;

/** @type {Map<ts.Node, string>} declaration -> display name */
const items = new Map();
/** Member names already counted, so an interface reached from several owners counts once. */
const memberKeys = new Set();

function isOurs(node) {
  return path.resolve(node.getSourceFile().fileName).startsWith(sourceRoot);
}

function isHidden(declaration) {
  const flags = ts.getCombinedModifierFlags(declaration);
  if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return true;
  const name = declaration.name;
  if (name && ts.isPrivateIdentifier(name)) return true;
  return ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'internal');
}

function documented(declaration) {
  // A doc comment on the declaration itself, or on its statement for `export const x = ...`.
  const holders = [declaration];
  if (ts.isVariableDeclaration(declaration)) holders.push(declaration.parent.parent);
  const textOf = (comment) => (typeof comment === 'string' ? comment : ts.getTextOfJSDocComment(comment));
  return holders.some((node) =>
    ts.getJSDocCommentsAndTags(node).some((doc) => {
      if (!ts.isJSDoc(doc)) return false;
      if (textOf(doc.comment)?.trim()) return true;
      // A deprecation that says what to use instead documents the declaration it deprecates.
      return (doc.tags ?? []).some((tag) => tag.tagName.text === 'deprecated' && textOf(tag.comment)?.trim());
    }),
  );
}

function addMembers(ownerName, declaration) {
  const members = [];
  if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration))
    members.push(...declaration.members);
  if (ts.isEnumDeclaration(declaration)) members.push(...declaration.members);
  if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)) {
    members.push(...declaration.type.members);
  }
  for (const member of members) {
    if (ts.isConstructorDeclaration(member) || ts.isIndexSignatureDeclaration(member)) continue;
    if (ts.isCallSignatureDeclaration(member) || ts.isConstructSignatureDeclaration(member)) continue;
    if (ts.isClassStaticBlockDeclaration?.(member)) continue;
    if (!member.name || isHidden(member)) continue;
    // Overloads share one entry; the first signature carries the documentation.
    const key = `${path.relative(root, member.getSourceFile().fileName)}:${ownerName}.${member.name.getText()}`;
    if (memberKeys.has(key)) continue;
    memberKeys.add(key);
    items.set(member, `${ownerName}.${member.name.getText()}`);
  }
  // Constructor parameter properties are public members too.
  if (ts.isClassDeclaration(declaration)) {
    for (const member of declaration.members) {
      if (!ts.isConstructorDeclaration(member)) continue;
      for (const parameter of member.parameters) {
        const flags = ts.getCombinedModifierFlags(parameter);
        const isProperty = flags & (ts.ModifierFlags.Public | ts.ModifierFlags.Readonly);
        if (!isProperty || flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
        items.set(parameter, `${ownerName}.${parameter.name.getText()}`);
      }
    }
  }
}

for (const file of entries) {
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) throw new Error(`Entry point ${path.relative(root, file)} is not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) continue;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declarations = symbol.declarations ?? [];
    for (const declaration of declarations) {
      if (!isOurs(declaration) || isHidden(declaration)) continue;
      if (ts.isModuleDeclaration(declaration)) continue;
      // An overloaded function is one item: its first signature stands for the set.
      const firstFunction = declarations.find((item) => ts.isFunctionDeclaration(item));
      if (ts.isFunctionDeclaration(declaration) && declaration !== firstFunction) continue;
      if (!items.has(declaration)) items.set(declaration, symbol.getName());
      addMembers(symbol.getName(), declaration);
    }
  }
}

const missing = [];
for (const [declaration, name] of items) {
  if (documented(declaration)) continue;
  // An overload set counts as documented when any of its signatures is.
  if (ts.isFunctionDeclaration(declaration)) {
    const symbol = declaration.name && checker.getSymbolAtLocation(declaration.name);
    if (symbol?.declarations?.some((other) => documented(other))) continue;
  }
  const sourceFile = declaration.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart());
  missing.push(`${path.relative(root, sourceFile.fileName).replace(/\\/g, '/')}:${line + 1}  ${name}`);
}

const total = items.size;
const coverage = total === 0 ? 100 : ((total - missing.length) / total) * 100;
if (list || coverage < minimum) {
  for (const entry of missing.sort()) console.log(entry);
}
console.log(
  `Documentation coverage: ${(total - missing.length).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} public declarations (${coverage.toFixed(2)}%) across ${entries.length} entry points.`,
);
if (coverage < minimum) {
  console.error(`Documentation coverage is below ${minimum}%. Document the items listed above.`);
  process.exitCode = 1;
}
