import { lintGraph, type GraphLintFinding } from '../graph/lint.js';
import type { GraphDescription } from '../types/graph.js';
import {
  CliUsageError,
  flagBool,
  isRecord,
  listFlag,
  loadModule,
  type ParsedArgs,
  printTable,
  writeJson,
} from './args.js';

/**
 * `nexus graph lint <module>[#export]`.
 *
 * The module exports a compiled graph, or a description of one as `describe()` returns it, as the
 * named export, as `graph`, or as its default. Exits 1 when a finding is an error, or with `--strict`
 * when any finding is a warning too.
 */
export async function runGraphCommand(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  if (subcommand !== 'lint') {
    throw new CliUsageError(`Unknown graph command "${subcommand ?? ''}". Use lint.`);
  }
  const [target] = args.positionals;
  if (!target) throw new CliUsageError('nexus graph lint needs a module: nexus graph lint ./graph.mjs[#exportName].');
  const [file, exportName] = target.split('#') as [string, string | undefined];
  const loaded = await loadModule(file);
  const graph = (exportName ? loaded[exportName] : (loaded.graph ?? loaded.default ?? loaded)) as unknown;
  if (!isLintable(graph)) {
    throw new CliUsageError(
      `${target} must export a compiled graph, or a graph description, ${exportName ? `as "${exportName}"` : 'as `graph` or its default'}.`,
    );
  }

  const findings = lintGraph(graph, {
    deployed: flagBool(args.flags, 'deployed'),
    ignore: listFlag(args.flags, 'ignore') as GraphLintFinding['code'][] | undefined,
  });
  const failing = findings.filter(
    (finding) => finding.severity === 'error' || (flagBool(args.flags, 'strict') && finding.severity === 'warning'),
  );

  if (flagBool(args.flags, 'json')) {
    writeJson({ findings, failed: failing.length > 0 });
  } else if (findings.length === 0) {
    console.log('No findings.');
  } else {
    printTable(
      findings.map((finding) => ({
        severity: finding.severity,
        code: finding.code,
        node: finding.node ?? '',
        message: finding.message,
      })),
      ['severity', 'code', 'node', 'message'],
    );
    console.log('');
    for (const finding of findings) console.log(`${finding.code}: ${finding.fix}`);
  }
  if (failing.length > 0) process.exitCode = 1;
}

function isLintable(value: unknown): value is { describe(): GraphDescription } | GraphDescription {
  if (!isRecord(value)) return false;
  if (typeof value.describe === 'function') return true;
  return Array.isArray(value.nodes) && Array.isArray(value.edges) && Array.isArray(value.dynamic);
}
