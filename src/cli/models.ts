import { readFile, writeFile } from 'node:fs/promises';
import {
  bundledRegistryData,
  checkRegistryData,
  diffRegistryData,
  type RegistryData,
  type RegistryDiff,
} from '../models/data.js';
import { CliUsageError, flagBool, listFlag, type ParsedArgs, printTable, stringFlag, writeJson } from './args.js';

/** How the command reaches the outside: replaced in tests. */
export interface ModelsCommandIo {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}

/**
 * `nexus models export | check | refresh`: registry data as a file the application keeps.
 *
 * `export` writes the bundled data, as a file to start from. `check` validates a file and says how it
 * differs from the bundled data. `refresh` lists each provider's models with the keys in the
 * environment and compares them with the data: what the data lacks, and what the provider no longer
 * lists. Prices are not in any provider's model list, so they stay a check against its pricing page.
 */
export async function runModelsCommand(
  subcommand: string,
  { positionals, flags }: ParsedArgs,
  io: ModelsCommandIo = { fetch: globalThis.fetch, env: process.env },
): Promise<void> {
  if (subcommand === 'export') {
    const text = `${JSON.stringify(bundledRegistryData(), null, 2)}\n`;
    const out = stringFlag(flags, 'out');
    if (out) {
      await writeFile(out, text);
      console.log(`Wrote the bundled registry data to ${out}.`);
    } else process.stdout.write(text);
    return;
  }
  if (subcommand === 'check') {
    const file = positionals[0];
    if (!file) throw new CliUsageError('Usage: nexus models check <registry.json> [--json]');
    const text = await readFile(file, 'utf8');
    const problems = checkRegistryData(text);
    const diff = problems.length
      ? undefined
      : diffRegistryData(bundledRegistryData(), JSON.parse(text) as RegistryData);
    if (flagBool(flags, 'json')) writeJson({ valid: problems.length === 0, problems, diff });
    else if (problems.length) {
      console.error(`${file} is not valid registry data:`);
      for (const problem of problems) console.error(`  - ${problem}`);
    } else printDiff(file, diff as RegistryDiff);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (subcommand === 'refresh') {
    const file = stringFlag(flags, 'file');
    const data = file ? (JSON.parse(await readFile(file, 'utf8')) as RegistryData) : bundledRegistryData();
    const wanted = listFlag(flags, 'providers') ?? Object.keys(PROVIDER_LISTS);
    const unknown = wanted.filter((provider) => !(provider in PROVIDER_LISTS));
    if (unknown.length) {
      throw new CliUsageError(
        `Unknown provider ${unknown.join(', ')}. Choose from ${Object.keys(PROVIDER_LISTS).join(', ')}.`,
      );
    }
    const listings: Record<string, string[]> = {};
    const skipped: string[] = [];
    for (const provider of wanted) {
      const source = PROVIDER_LISTS[provider] as ProviderList;
      const key = io.env[source.env];
      if (!key) {
        skipped.push(`${provider} (no ${source.env})`);
        continue;
      }
      listings[provider] = await source.list(key, io.fetch);
    }
    const report = refreshReport(data, listings);
    if (flagBool(flags, 'json')) writeJson({ report, skipped });
    else printRefresh(report, skipped);
    if (flagBool(flags, 'strict') && report.some((row) => row.missing.length || row.unlisted.length))
      process.exitCode = 1;
    return;
  }
  throw new CliUsageError(
    `Unknown models command "${subcommand}". Use export, check, or refresh, or no command to list.`,
  );
}

/** How the data compares with what one provider lists. */
export interface RefreshRow {
  /** The provider. */
  provider: string;
  /** Models the provider lists that the data does not have. */
  missing: string[];
  /** Models the data has for the provider that it no longer lists. */
  unlisted: string[];
}

/** Compares registry data with each provider's model list, completion and embedding models alike. */
export function refreshReport(data: RegistryData, listings: Record<string, string[]>): RefreshRow[] {
  return Object.entries(listings).map(([provider, listed]) => {
    const known = new Set([
      ...Object.entries(data.models)
        .filter(([, entry]) => entry.provider === provider)
        .map(([name]) => name),
      ...Object.entries(data.embeddingModels ?? {})
        .filter(([, entry]) => entry.provider === provider)
        .map(([name]) => name),
    ]);
    const offered = new Set(listed);
    return {
      provider,
      missing: [...offered].filter((name) => !known.has(name)).sort(),
      unlisted: [...known].filter((name) => !offered.has(name)).sort(),
    };
  });
}

interface ProviderList {
  /** The environment variable that holds its key. */
  env: string;
  /** Every model id it lists. */
  list(key: string, fetch: typeof globalThis.fetch): Promise<string[]>;
}

/** Each provider's own model list, read with the application's key: nothing else is contacted. */
export const PROVIDER_LISTS: Record<string, ProviderList> = {
  openai: { env: 'OPENAI_API_KEY', list: openAiStyle('https://api.openai.com/v1/models') },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    async list(key, fetch) {
      const ids: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = (await getJson(
          fetch,
          `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`,
          { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        )) as { data?: Array<{ id: string }>; has_more?: boolean; last_id?: string };
        ids.push(...(page.data ?? []).map((model) => model.id));
        if (!page.has_more || !page.last_id) return ids;
        after = page.last_id;
      }
    },
  },
  google: {
    env: 'GOOGLE_API_KEY',
    async list(key, fetch) {
      const ids: string[] = [];
      let token: string | undefined;
      for (;;) {
        const page = (await getJson(
          fetch,
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
          { 'x-goog-api-key': key },
        )) as { models?: Array<{ name: string }>; nextPageToken?: string };
        ids.push(...(page.models ?? []).map((model) => model.name.replace(/^models\//, '')));
        if (!page.nextPageToken) return ids;
        token = page.nextPageToken;
      }
    },
  },
  mistral: { env: 'MISTRAL_API_KEY', list: openAiStyle('https://api.mistral.ai/v1/models') },
  cohere: {
    env: 'COHERE_API_KEY',
    async list(key, fetch) {
      const ids: string[] = [];
      let token: string | undefined;
      for (;;) {
        const page = (await getJson(
          fetch,
          `https://api.cohere.com/v1/models?page_size=1000${token ? `&page_token=${encodeURIComponent(token)}` : ''}`,
          { authorization: `Bearer ${key}` },
        )) as { models?: Array<{ name: string }>; next_page_token?: string };
        ids.push(...(page.models ?? []).map((model) => model.name));
        if (!page.next_page_token) return ids;
        token = page.next_page_token;
      }
    },
  },
  groq: { env: 'GROQ_API_KEY', list: openAiStyle('https://api.groq.com/openai/v1/models') },
  deepseek: { env: 'DEEPSEEK_API_KEY', list: openAiStyle('https://api.deepseek.com/models') },
};

function openAiStyle(url: string): ProviderList['list'] {
  return async (key, fetch) => {
    const page = (await getJson(fetch, url, { authorization: `Bearer ${key}` })) as { data?: Array<{ id: string }> };
    return (page.data ?? []).map((model) => model.id);
  };
}

async function getJson(fetch: typeof globalThis.fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status} listing its models`);
  return response.json();
}

function printDiff(file: string, diff: RegistryDiff): void {
  console.log(`${file} is valid registry data. Against the bundled data:`);
  console.log(
    `  ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.aliases.length} aliases moved`,
  );
  for (const name of diff.added) console.log(`  + ${name}`);
  for (const name of diff.removed) console.log(`  - ${name}`);
  for (const { model, changes } of diff.changed) {
    console.log(
      `  ~ ${model}: ${changes.map(({ field, from, to }) => `${field} ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).join(', ')}`,
    );
  }
  for (const { alias, from, to } of diff.aliases) console.log(`  @ ${alias}: ${from ?? '(none)'} -> ${to ?? '(none)'}`);
}

function printRefresh(report: RefreshRow[], skipped: string[]): void {
  if (report.length) {
    printTable(
      report.map((row) => ({
        provider: row.provider,
        'listed, not in the data': row.missing.join(', ') || '-',
        'in the data, not listed': row.unlisted.join(', ') || '-',
      })),
      ['provider', 'listed, not in the data', 'in the data, not listed'],
    );
  }
  if (skipped.length) console.log(`Skipped: ${skipped.join(', ')}.`);
  console.log('Prices are not in any provider list: check new and changed entries against each pricing page.');
}
