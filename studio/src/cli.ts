#!/usr/bin/env node
/**
 * `nexus-studio`: starts the studio against a configuration module.
 *
 *   nexus-studio --config studio.config.mjs [--port 4747] [--host 127.0.0.1] [--token t] [--allow-host name]
 *                [--users users.json] [--journal .studio]
 *
 * The configuration module exports the sources — or a function, possibly async, that returns them —
 * as its default export. It is ordinary application code, so it opens the same stores the
 * application does: `export default { traces: new PostgresTraceStore(pool), prompts: registry }`.
 * It may also export `options`, such as an `auth` authenticator, which the flags extend.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { personalTokens, type StudioUser } from './auth.js';
import { FileStudioJournal } from './journal.js';
import { type StartStudioOptions, startStudio } from './server.js';
import type { StudioSources } from './types.js';

const USAGE = `Usage: nexus-studio --config <studio.config.mjs> [--port 4747] [--host 127.0.0.1] [--token <token>] [--allow-host <name>]
                    [--users <users.json>] [--journal <directory>]

--users     a JSON list of { "id", "name", "role", "token" }: one personal link per person, with a role
            (viewer, reviewer, editor, or admin)
--journal   keeps the audit log and comments as JSON Lines files in a directory

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
  return (await loadConfig(file)).sources;
}

/**
 * Loads a configuration module: the sources from its default export, and the studio options from an
 * `options` export when it has one — an object, or a function, possibly async, returning one.
 */
export async function loadConfig(file: string): Promise<{ sources: StudioSources; options: StartStudioOptions }> {
  const module = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: unknown; options?: unknown };
  const exported = module.default;
  if (exported === undefined) throw new Error(`${file} has no default export`);
  const sources = typeof exported === 'function' ? await (exported as () => unknown)() : exported;
  if (!sources || typeof sources !== 'object') throw new Error(`${file} must export the studio's sources as an object`);
  const options =
    typeof module.options === 'function' ? await (module.options as () => unknown)() : (module.options ?? {});
  if (!options || typeof options !== 'object') throw new Error(`${file} exports options that are not an object`);
  return { sources: sources as StudioSources, options: options as StartStudioOptions };
}

/** Reads a users file: a JSON list of people, each with an id, a role, a personal token, and optionally a name. */
export async function loadUsers(file: string): Promise<Array<StudioUser & { token: string }>> {
  const { readFile } = await import('node:fs/promises');
  const users = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (
    !Array.isArray(users) ||
    users.some((user) => !user || typeof user.id !== 'string' || typeof user.token !== 'string')
  ) {
    throw new Error(`${file} must be a JSON list of { "id", "role", "token" }`);
  }
  return users as Array<StudioUser & { token: string }>;
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

  const { sources, options } = await loadConfig(config);
  const host = flags.host?.[0];
  const users = flags.users ? await loadUsers(flags.users[0] as string) : undefined;
  const journal = flags.journal ? new FileStudioJournal(flags.journal[0] as string) : undefined;
  const settings: StartStudioOptions = {
    ...options,
    ...(port === undefined ? {} : { port }),
    ...(host ? { host } : {}),
    ...(flags.token ? { token: flags.token[0] } : {}),
    ...(flags['allow-host'] ? { allowedHosts: [...(options.allowedHosts ?? []), ...flags['allow-host']] } : {}),
    ...(users ? { auth: personalTokens(users) } : {}),
    ...(journal ? { audit: journal, comments: journal } : {}),
  };
  const running = await startStudio(sources, settings);

  const shown = Object.entries(sources)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .join(', ');
  if (settings.auth) {
    const address = running.url.slice(0, running.url.indexOf('/?'));
    console.log(
      `Nexus studio is running at ${address}\n\nEach person signs in with their own link or through your proxy.\nSources: ${shown || 'none'}`,
    );
  } else {
    console.log(`Nexus studio is running. Open:\n\n  ${running.url}\n\nSources: ${shown || 'none'}`);
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
