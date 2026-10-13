/**
 * The model and embedding registries as a data file an application supplies, so prices and models
 * can move faster than a runtime release. Nothing here fetches anything: the file is the
 * application's, read from its own repository, volume, or configuration.
 */
import {
  EMBEDDING_MODEL_ALIASES,
  EMBEDDING_REGISTRY_PROVENANCE,
  KNOWN_EMBEDDING_MODELS,
} from '../embeddings/models.js';
import type { NexusAIConfig } from '../types/config.js';
import type { EmbeddingModelCapabilities } from '../types/embeddings.js';
import {
  type AliasMetadata,
  KNOWN_MODELS,
  MODEL_ALIAS_METADATA,
  MODEL_ALIASES,
  type ModelCapabilities,
  REGISTRY_PROVENANCE,
} from '../types/providers.js';

/** The format a registry data file declares, which a later release reads too. */
export const REGISTRY_DATA_FORMAT = 'nexus-registry/1';

/** Model and embedding registry data, as a file. */
export interface RegistryData {
  /** Always `nexus-registry/1`. */
  format: typeof REGISTRY_DATA_FORMAT;
  /** The data's own version, such as the date it was assembled: `2026.10.13`. */
  version: string;
  /** When its entries were last checked against provider documentation, as an ISO date. */
  verifiedAt: string;
  /** Where they were checked. */
  source?: string;
  /** Completion models, by name. */
  models: Record<string, ModelCapabilities>;
  /** Completion aliases, mapped to model names. */
  aliases?: Record<string, string>;
  /** Each alias's stage and provenance. */
  aliasMetadata?: Record<string, AliasMetadata>;
  /** Embedding models, by name. */
  embeddingModels?: Record<string, EmbeddingModelCapabilities>;
  /** Embedding aliases, mapped to model names. */
  embeddingAliases?: Record<string, string>;
}

/** Raised by `parseRegistryData()` for a file that is not valid registry data, naming every problem. */
export class RegistryDataError extends Error {
  constructor(
    /** Each problem, with the path of the field it is in. */
    readonly problems: string[],
  ) {
    super(
      `Invalid registry data: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}`,
    );
    this.name = 'RegistryDataError';
  }
}

const MODEL_STATUSES = new Set(['stable', 'preview', 'latest', 'deprecated']);
const INPUT_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);
const OUTPUT_MODALITIES = new Set(['text', 'image', 'audio']);
const EMBEDDING_MODALITIES = new Set(['text', 'image', 'audio', 'document']);
const DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Every problem with a value as registry data, each with the path of its field; empty when it is
 * valid. An alias must name a model the file or the bundled data has.
 */
export function checkRegistryData(value: unknown): string[] {
  const problems: string[] = [];
  const data = typeof value === 'string' ? safeJson(value, problems) : value;
  if (!isRecord(data)) return problems.length ? problems : ['the data is not an object'];
  if (data.format !== REGISTRY_DATA_FORMAT) problems.push(`format: expected "${REGISTRY_DATA_FORMAT}"`);
  if (typeof data.version !== 'string' || !data.version.trim()) problems.push('version: a non-empty string');
  if (typeof data.verifiedAt !== 'string' || !DATE.test(data.verifiedAt)) problems.push('verifiedAt: an ISO date');
  if (data.source !== undefined && typeof data.source !== 'string') problems.push('source: a string');

  if (!isRecord(data.models)) problems.push('models: an object of model entries');
  else for (const [name, entry] of Object.entries(data.models)) checkModel(`models.${name}`, entry, problems);
  if (data.embeddingModels !== undefined) {
    if (!isRecord(data.embeddingModels)) problems.push('embeddingModels: an object of model entries');
    else
      for (const [name, entry] of Object.entries(data.embeddingModels))
        checkEmbeddingModel(`embeddingModels.${name}`, entry, problems);
  }

  const models = isRecord(data.models) ? data.models : {};
  const embeddings = isRecord(data.embeddingModels) ? data.embeddingModels : {};
  checkAliases('aliases', data.aliases, (target) => target in models || target in KNOWN_MODELS, problems);
  checkAliases(
    'embeddingAliases',
    data.embeddingAliases,
    (target) => target in embeddings || target in KNOWN_EMBEDDING_MODELS,
    problems,
  );
  if (data.aliasMetadata !== undefined) {
    if (!isRecord(data.aliasMetadata)) problems.push('aliasMetadata: an object');
    else {
      for (const [alias, metadata] of Object.entries(data.aliasMetadata)) {
        if (!isRecord(metadata) || !['stable', 'preview', 'deprecated'].includes(String(metadata.stage))) {
          problems.push(`aliasMetadata.${alias}.stage: stable, preview, or deprecated`);
        }
      }
    }
  }
  return problems;
}

/** Reads registry data from JSON text or a parsed value, throwing `RegistryDataError` with every problem. */
export function parseRegistryData(value: unknown): RegistryData {
  const problems = checkRegistryData(value);
  if (problems.length) throw new RegistryDataError(problems);
  return (typeof value === 'string' ? JSON.parse(value) : value) as RegistryData;
}

/**
 * The data this release bundles, as a file: the starting point for one an application keeps and
 * updates itself, or a baseline to compare one with.
 */
export function bundledRegistryData(): RegistryData {
  const verifiedAt =
    EMBEDDING_REGISTRY_PROVENANCE.verifiedAt > REGISTRY_PROVENANCE.verifiedAt
      ? EMBEDDING_REGISTRY_PROVENANCE.verifiedAt
      : REGISTRY_PROVENANCE.verifiedAt;
  return structuredClone({
    format: REGISTRY_DATA_FORMAT,
    version: verifiedAt.replaceAll('-', '.'),
    verifiedAt,
    source: REGISTRY_PROVENANCE.source,
    models: KNOWN_MODELS,
    aliases: MODEL_ALIASES,
    aliasMetadata: MODEL_ALIAS_METADATA,
    embeddingModels: KNOWN_EMBEDDING_MODELS,
    embeddingAliases: EMBEDDING_MODEL_ALIASES,
  });
}

/**
 * A client configuration with registry data layered in: the configuration's own entries first, then
 * the file's, then the bundled ones. Freshness is then measured from the file's `verifiedAt`.
 *
 * ```ts
 * const data = parseRegistryData(await readFile('./registry.json', 'utf8'));
 * const ai = new NexusAI(withRegistryData({ providers }, data));
 * ```
 */
export function withRegistryData(config: NexusAIConfig, data: RegistryData): NexusAIConfig {
  const models = config.models ?? {};
  const embeddings = config.embeddings ?? {};
  return {
    ...config,
    models: {
      ...models,
      registry: { ...data.models, ...models.registry },
      aliases: { ...data.aliases, ...models.aliases },
      aliasMetadata: { ...data.aliasMetadata, ...models.aliasMetadata },
      verifiedAt: data.verifiedAt,
    },
    embeddings: {
      ...embeddings,
      models: {
        ...embeddings.models,
        registry: { ...data.embeddingModels, ...embeddings.models?.registry },
        aliases: { ...data.embeddingAliases, ...embeddings.models?.aliases },
      },
    },
  };
}

/** One field that differs between two versions of a model's entry. */
export interface RegistryFieldChange {
  /** The field's name, such as `costPer1kInput`. */
  field: string;
  /** Its value before. */
  from: unknown;
  /** Its value after. */
  to: unknown;
}

/** How two versions of registry data differ, for completion and embedding models alike. */
export interface RegistryDiff {
  /** Models the second has and the first does not. */
  added: string[];
  /** Models the first has and the second does not. */
  removed: string[];
  /** Models both have whose entries differ, each with its changed fields. */
  changed: Array<{ model: string; changes: RegistryFieldChange[] }>;
  /** Aliases whose target differs, was added, or was removed. */
  aliases: Array<{ alias: string; from?: string; to?: string }>;
}

/** What changed from one version of registry data to another: models, fields, and aliases. */
export function diffRegistryData(from: RegistryData, to: RegistryData): RegistryDiff {
  const before = { ...from.models, ...prefixed(from.embeddingModels) };
  const after = { ...to.models, ...prefixed(to.embeddingModels) };
  const diff: RegistryDiff = { added: [], removed: [], changed: [], aliases: [] };
  for (const name of Object.keys(after).sort()) if (!(name in before)) diff.added.push(name);
  for (const name of Object.keys(before).sort()) {
    if (!(name in after)) {
      diff.removed.push(name);
      continue;
    }
    const changes: RegistryFieldChange[] = [];
    const a = before[name] as unknown as Record<string, unknown>;
    const b = after[name] as unknown as Record<string, unknown>;
    for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) changes.push({ field, from: a[field], to: b[field] });
    }
    if (changes.length) diff.changed.push({ model: name, changes });
  }
  const aliasesBefore = { ...from.aliases, ...prefixed(from.embeddingAliases) };
  const aliasesAfter = { ...to.aliases, ...prefixed(to.embeddingAliases) };
  for (const alias of [...new Set([...Object.keys(aliasesBefore), ...Object.keys(aliasesAfter)])].sort()) {
    if (aliasesBefore[alias] !== aliasesAfter[alias]) {
      diff.aliases.push({
        alias,
        ...(aliasesBefore[alias] ? { from: aliasesBefore[alias] } : {}),
        ...(aliasesAfter[alias] ? { to: aliasesAfter[alias] } : {}),
      });
    }
  }
  return diff;
}

/** How many whole days old registry data is. */
export function registryDataAgeDays(data: Pick<RegistryData, 'verifiedAt'>, now: Date = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(data.verifiedAt)) / 86_400_000);
}

/** Embedding names kept apart from completion names, which can be the same. */
function prefixed<T>(entries: Record<string, T> | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(entries ?? {}).map(([name, value]) => [`embedding:${name}`, value]));
}

function checkModel(path: string, entry: unknown, problems: string[]): void {
  if (!isRecord(entry)) {
    problems.push(`${path}: an object`);
    return;
  }
  modalities(`${path}.inputModalities`, entry.inputModalities, INPUT_MODALITIES, true, problems);
  modalities(`${path}.outputModalities`, entry.outputModalities, OUTPUT_MODALITIES, true, problems);
  for (const field of ['streaming', 'toolCalling'] as const) {
    if (typeof entry[field] !== 'boolean') problems.push(`${path}.${field}: true or false`);
  }
  positiveInteger(`${path}.maxContextTokens`, entry.maxContextTokens, true, problems);
  positiveInteger(`${path}.maxOutputTokens`, entry.maxOutputTokens, false, problems);
  for (const field of ['costPer1kInput', 'costPer1kOutput'] as const)
    price(`${path}.${field}`, entry[field], true, problems);
  for (const field of ['costPer1kCachedInput', 'costPer1kCacheWrite'] as const) {
    price(`${path}.${field}`, entry[field], false, problems);
  }
  common(path, entry, problems);
}

function checkEmbeddingModel(path: string, entry: unknown, problems: string[]): void {
  if (!isRecord(entry)) {
    problems.push(`${path}: an object`);
    return;
  }
  if (typeof entry.provider !== 'string' || !entry.provider) problems.push(`${path}.provider: a provider name`);
  positiveInteger(`${path}.dimensions`, entry.dimensions, true, problems);
  positiveInteger(`${path}.maxInputTokens`, entry.maxInputTokens, true, problems);
  positiveInteger(`${path}.maxBatchSize`, entry.maxBatchSize, false, problems);
  price(`${path}.costPer1kInput`, entry.costPer1kInput, true, problems);
  price(`${path}.costPerImage`, entry.costPerImage, false, problems);
  modalities(`${path}.inputModalities`, entry.inputModalities, EMBEDDING_MODALITIES, false, problems);
  const sizes = entry.supportedDimensions;
  if (
    sizes !== undefined &&
    sizes !== true &&
    !(Array.isArray(sizes) && sizes.every((size) => Number.isInteger(size) && size > 0))
  ) {
    problems.push(`${path}.supportedDimensions: true, or a list of sizes`);
  }
  common(path, entry, problems);
}

function common(path: string, entry: Record<string, unknown>, problems: string[]): void {
  if (entry.status !== undefined && !MODEL_STATUSES.has(String(entry.status))) {
    problems.push(`${path}.status: stable, preview, latest, or deprecated`);
  }
  if (entry.verifiedAt !== undefined && !(typeof entry.verifiedAt === 'string' && DATE.test(entry.verifiedAt))) {
    problems.push(`${path}.verifiedAt: an ISO date`);
  }
}

function checkAliases(path: string, value: unknown, known: (target: string) => boolean, problems: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    problems.push(`${path}: an object of alias names to model names`);
    return;
  }
  for (const [alias, target] of Object.entries(value)) {
    if (typeof target !== 'string' || !known(target))
      problems.push(`${path}.${alias}: names no model in the file or the bundled data`);
  }
}

function modalities(path: string, value: unknown, allowed: Set<string>, required: boolean, problems: string[]): void {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => allowed.has(String(item)))) {
    problems.push(`${path}: a list of ${[...allowed].join(', ')}`);
  }
}

function positiveInteger(path: string, value: unknown, required: boolean, problems: string[]): void {
  if (value === undefined && !required) return;
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value > 0))
    problems.push(`${path}: a positive integer`);
}

function price(path: string, value: unknown, required: boolean, problems: string[]): void {
  if (value === undefined && !required) return;
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0))
    problems.push(`${path}: a price of zero or more`);
}

function safeJson(text: string, problems: string[]): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`not JSON: ${(error as Error).message}`);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
