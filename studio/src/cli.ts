#!/usr/bin/env node
/**
 * `nexus-studio`: starts the studio against a configuration module.
 *
 *   nexus-studio --config studio.config.mjs [--port 4747] [--host 127.0.0.1] [--token t] [--allow-host name]
 *
 * The configuration module exports the sources — or a function, possibly async, that returns them —
 * as its default export. It is ordinary application code, so it opens the same stores the
 * application does: `export default { traces: new PostgresTraceStore(pool), prompts: registry }`.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startStudio } from './server.js';
import type { StudioSources } from './types.js';

const USAGE = `Usage: nexus-studio --config <studio.config.mjs> [--port 4747] [--host 127.0.0.1] [--token <token>] [--allow-host <name>]

The config module's default export is the studio's sources, or a function returning them.
TypeScript configs work under a loader: node --import tsx node_modules/nexus-ai-pro-studio/dist/cli.js --config studio.config.ts`;

/** Reads `--name value` flags; repeated flags collect into an array. */
export function parseArgs(argv: readonly string[]): Record<string, string[]> {
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const value = inline ?? (argv[index + 1]?.startsWith('--') ? undefined : argv[++index]);
    flags[name] = [...(flags[name] ?? []), value ?? 'true'];
  }
  return flags;
}

/** Loads the sources a configuration module exports. */
export async function loadSources(file: string): Promise<StudioSources> {
  const module = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: unknown };
  const exported = module.default;
  if (exported === undefined) throw new Error(`${file} has no default export`);
  const sources = typeof exported === 'function' ? await (exported as () => unknown)() : exported;
  if (!sources || typeof sources !== 'object') throw new Error(`${file} must export the studio's sources as an object`);
  return sources as StudioSources;
}

async function main(argv: readonly string[]): Promise<void> {
  const flags = parseArgs(argv);
  if (flags.help || flags.h) {
    console.log(USAGE);
    return;
  }
  const config = flags.config?.[0];
  if (!config) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const port = flags.port ? Number(flags.port[0]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    console.error('--port must be a port number');
    process.exitCode = 2;
    return;
  }

  const sources = await loadSources(config);
  const host = flags.host?.[0];
  const running = await startStudio(sources, {
    ...(port === undefined ? {} : { port }),
    ...(host ? { host } : {}),
    ...(flags.token ? { token: flags.token[0] } : {}),
    ...(flags['allow-host'] ? { allowedHosts: flags['allow-host'] } : {}),
  });

  const shown = Object.entries(sources)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .join(', ');
  console.log(`Nexus studio is running. Open:\n\n  ${running.url}\n\nSources: ${shown || 'none'}`);
  if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn(`\nListening on ${host}: anyone who can reach it and has the token can use the studio.`);
  }

  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// Run only as a command, not when a test imports the helpers above. npm's bin entry is a symlink on
// Unix, so the path is resolved before comparing.
function realUrl(file: string | URL): string {
  try {
    return pathToFileURL(realpathSync(file)).href;
  } catch {
    return '';
  }
}
if (process.argv[1] && realUrl(path.resolve(process.argv[1])) === realUrl(new URL(import.meta.url))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
