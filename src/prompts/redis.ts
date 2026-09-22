import type { PromptHistoryEntry, PromptLabel, PromptStore, PromptVersion } from '../types/prompts.js';

/**
 * The Redis commands the prompt store needs, in `ioredis` argument order.
 *
 * Structural, as with the other Redis adapters, so no Redis client becomes a dependency.
 */
export interface RedisPromptLikeClient {
  /** Sets a hash field only when it does not exist, resolving to 1 when it was set. */
  hsetnx(key: string, field: string, value: string): Promise<number | unknown> | number | unknown;
  /** Sets a hash field. */
  hset(key: string, field: string, value: string): Promise<unknown> | unknown;
  /** Reads a hash field. */
  hget(key: string, field: string): Promise<string | null> | string | null;
  /** Reads every hash value. */
  hvals(key: string): Promise<string[]> | string[];
  /** Deletes a hash field, resolving to the number removed. */
  hdel(key: string, field: string): Promise<number | unknown> | number | unknown;
  /** Pushes onto the head of a list. */
  lpush(key: string, value: string): Promise<unknown> | unknown;
  /** Reads a range of a list. */
  lrange(key: string, start: number, stop: number): Promise<string[]> | string[];
  /** Trims a list to a range. */
  ltrim(key: string, start: number, stop: number): Promise<unknown> | unknown;
  /** Adds to a set. */
  sadd(key: string, member: string): Promise<unknown> | unknown;
  /** Reads a set. */
  smembers(key: string): Promise<string[]> | string[];
  /** Optional atomic primitive. Strongly preferred, so that label compare-and-set is one step. */
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown> | unknown;
}

/** Options for the Redis prompt store. */
export interface RedisPromptStoreOptions {
  /** Key prefix. Defaults to `nexus-ai-pro:prompts:`. */
  prefix?: string;
  /** History entries kept per prompt. Defaults to 1,000. */
  maxHistory?: number;
  /** Disables the Lua compare-and-set even when the client exposes `eval`. */
  useEval?: boolean;
}

const SET_LABEL_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if ARGV[3] == '1' then
  if current then return 0 end
elseif ARGV[3] == '2' then
  if not current then return 0 end
  if cjson.decode(current).version ~= ARGV[4] then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/**
 * Prompt versions, labels, and history in Redis, shared by every process that serves prompts.
 *
 * Versions sit in one hash per prompt with a list keeping their order; labels in another hash,
 * written by a Lua compare-and-set when the client has `eval`; history in a capped list.
 */
export class RedisPromptStore implements PromptStore {
  private readonly prefix: string;
  private readonly useEval: boolean;

  constructor(
    private readonly client: RedisPromptLikeClient,
    private readonly options: RedisPromptStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:prompts:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
  }

  /** Stores a version, unless one with the same content version exists. */
  async saveVersion(version: PromptVersion): Promise<void> {
    const added = await this.client.hsetnx(
      this.key('versions', version.name),
      version.version,
      JSON.stringify(version),
    );
    if (Number(added) !== 1) return;
    await this.client.lpush(this.key('order', version.name), version.version);
    await this.client.sadd(`${this.prefix}names`, version.name);
  }

  /** Reads a version. */
  async getVersion(name: string, version: string): Promise<PromptVersion | undefined> {
    return parse<PromptVersion>(await this.client.hget(this.key('versions', name), version));
  }

  /** Versions of a prompt, newest first. Defaults to 50. */
  async listVersions(name: string, options: { limit?: number } = {}): Promise<PromptVersion[]> {
    const ids = await this.client.lrange(this.key('order', name), 0, (options.limit ?? 50) - 1);
    const versions = await Promise.all(ids.map((id) => this.getVersion(name, id)));
    return versions.filter((version): version is PromptVersion => version !== undefined);
  }

  /** Reads a label. */
  async getLabel(name: string, label: string): Promise<PromptLabel | undefined> {
    return parse<PromptLabel>(await this.client.hget(this.key('labels', name), label));
  }

  /** Every label of a prompt, sorted by name. */
  async listLabels(name: string): Promise<PromptLabel[]> {
    return (await this.client.hvals(this.key('labels', name)))
      .map((value) => parse<PromptLabel>(value))
      .filter((label): label is PromptLabel => label !== undefined)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Writes a label when it still points at `expected`, in one step when the client has `eval`. */
  async setLabel(label: PromptLabel, expected?: string | null): Promise<boolean> {
    const key = this.key('labels', label.name);
    const encoded = JSON.stringify(label);
    if (this.useEval && this.client.eval) {
      const mode = expected === undefined ? '0' : expected === null ? '1' : '2';
      const result = await this.client.eval(SET_LABEL_SCRIPT, 1, key, label.label, encoded, mode, expected ?? '');
      return Number(result) === 1;
    }
    if (expected !== undefined) {
      const current = parse<PromptLabel>(await this.client.hget(key, label.label));
      if (expected === null ? current !== undefined : current?.version !== expected) return false;
    }
    await this.client.hset(key, label.label, encoded);
    return true;
  }

  /** Removes a label. Resolves true when it existed. */
  async deleteLabel(name: string, label: string): Promise<boolean> {
    return Number(await this.client.hdel(this.key('labels', name), label)) > 0;
  }

  /** Records a change, trimming the history to `maxHistory`. */
  async appendHistory(entry: PromptHistoryEntry): Promise<void> {
    const key = this.key('history', entry.name);
    await this.client.lpush(key, JSON.stringify(entry));
    await this.client.ltrim(key, 0, (this.options.maxHistory ?? 1_000) - 1);
  }

  /** A prompt's history, newest first, optionally for one label. Defaults to 100. */
  async listHistory(name: string, options: { label?: string; limit?: number } = {}): Promise<PromptHistoryEntry[]> {
    const limit = options.limit ?? 100;
    const raw = await this.client.lrange(this.key('history', name), 0, options.label === undefined ? limit - 1 : -1);
    return raw
      .map((value) => parse<PromptHistoryEntry>(value))
      .filter((entry): entry is PromptHistoryEntry => entry !== undefined)
      .filter((entry) => options.label === undefined || entry.label === options.label)
      .slice(0, limit);
  }

  /** Every prompt name, sorted. */
  async listNames(): Promise<string[]> {
    return [...(await this.client.smembers(`${this.prefix}names`))].sort();
  }

  private key(kind: 'versions' | 'order' | 'labels' | 'history', name: string): string {
    return `${this.prefix}${kind}:${name}`;
  }
}

function parse<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    // A value another writer mangled is treated as absent rather than failing every read.
    return undefined;
  }
}
