/**
 * An in-memory Redis for tests: hashes, strings with expiry, and sorted sets, in `ioredis` argument
 * order. `eval` runs the script in real Lua (wasmoon, Lua compiled to WebAssembly) with `redis.call`
 * bound to these commands, so the adapters' Lua is executed rather than imitated: a syntax error or a
 * wrong branch fails here as it would against a server. Each script runs synchronously, so it is as
 * atomic as on Redis.
 */
import { LuaFactory } from 'wasmoon';

type LuaEngine = Awaited<ReturnType<LuaFactory['createEngine']>>;

const PRELUDE = `
unpack = unpack or table.unpack
redis = {
  call = function(...) return __call(...) end,
  pcall = function(...) return __call(...) end,
}
cjson = {
  decode = function(text) return __decode(text) end,
  encode = function(value) return __encode(value) end,
}
`;

export class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly strings = new Map<string, { value: string; expiresAt?: number }>();
  readonly sets = new Map<string, Set<string>>();
  readonly lists = new Map<string, string[]>();
  /** Each sorted set as member → score, with its members kept in score order for range reads. */
  private readonly zsets = new Map<string, { scores: Map<string, number>; order: Array<[number, string]> }>();
  /** Hash values read, by any command: what a test counts to show how much a read touched. */
  reads = 0;
  /** Commands run, including those inside scripts. */
  commands = 0;
  now: () => number = () => Date.now();

  private constructor(private readonly lua: LuaEngine) {}

  static async create(): Promise<FakeRedis> {
    // The script path, which wasmoon exposes as `_`, may hold characters it refuses; leave it out.
    const lua = await new LuaFactory(undefined, { _: undefined } as never).createEngine();
    const fake = new FakeRedis(lua);
    lua.global.set('__call', (...args: unknown[]) => fake.luaCall(args));
    lua.global.set('__decode', (text: string) => JSON.parse(text));
    lua.global.set('__encode', (value: unknown) => JSON.stringify(value));
    lua.doStringSync(PRELUDE);
    return fake;
  }

  close(): void {
    this.lua.global.close();
  }

  // ── Hashes ──────────────────────────────────────────────────────

  hget(key: string, field: string): string | null {
    this.commands += 1;
    const value = this.hashes.get(key)?.get(field);
    if (value !== undefined) this.reads += 1;
    return value ?? null;
  }

  hset(key: string, field: string, value: string): number {
    this.commands += 1;
    const hash = this.hash(key);
    const added = hash.has(field) ? 0 : 1;
    hash.set(field, String(value));
    return added;
  }

  hdel(key: string, field: string): number {
    this.commands += 1;
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }

  hsetnx(key: string, field: string, value: string): number {
    this.commands += 1;
    const hash = this.hash(key);
    if (hash.has(field)) return 0;
    hash.set(field, String(value));
    return 1;
  }

  // ── Sets and lists ──────────────────────────────────────────────

  sadd(key: string, ...members: string[]): number {
    this.commands += 1;
    const set = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, set);
    let added = 0;
    for (const member of members)
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    return added;
  }

  srem(key: string, ...members: string[]): number {
    this.commands += 1;
    const set = this.sets.get(key);
    return members.filter((member) => set?.delete(member)).length;
  }

  smembers(key: string): string[] {
    this.commands += 1;
    return [...(this.sets.get(key) ?? [])];
  }

  lpush(key: string, ...values: string[]): number {
    this.commands += 1;
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list);
    for (const value of values) list.unshift(String(value));
    return list.length;
  }

  lrange(key: string, start: number | string, stop: number | string): string[] {
    this.commands += 1;
    const list = this.lists.get(key) ?? [];
    const from = Number(start) < 0 ? Math.max(0, list.length + Number(start)) : Number(start);
    const to = Number(stop) < 0 ? list.length + Number(stop) : Number(stop);
    return list.slice(from, to + 1);
  }

  ltrim(key: string, start: number | string, stop: number | string): 'OK' {
    this.commands += 1;
    this.lists.set(key, this.lrange(key, start, stop));
    return 'OK';
  }

  hexists(key: string, field: string): number {
    this.commands += 1;
    return this.hashes.get(key)?.has(field) ? 1 : 0;
  }

  hvals(key: string): string[] {
    this.commands += 1;
    const values = [...(this.hashes.get(key)?.values() ?? [])];
    this.reads += values.length;
    return values;
  }

  hgetall(key: string): Record<string, string> {
    this.commands += 1;
    const entries = [...(this.hashes.get(key)?.entries() ?? [])];
    this.reads += entries.length;
    return Object.fromEntries(entries);
  }

  hmget(key: string, ...fields: string[]): Array<string | null> {
    this.commands += 1;
    const hash = this.hashes.get(key);
    return fields.map((field) => {
      const value = hash?.get(field);
      if (value !== undefined) this.reads += 1;
      return value ?? null;
    });
  }

  hincrby(key: string, field: string, by: number | string): number {
    this.commands += 1;
    const hash = this.hash(key);
    const next = Number(hash.get(field) ?? 0) + Number(by);
    hash.set(field, String(next));
    return next;
  }

  // ── Strings ─────────────────────────────────────────────────────

  get(key: string): string | null {
    this.commands += 1;
    return this.live(key)?.value ?? null;
  }

  set(key: string, value: string, ...options: Array<string | number>): 'OK' | null {
    this.commands += 1;
    let ttl: number | undefined;
    let onlyIfAbsent = false;
    for (let index = 0; index < options.length; index += 1) {
      const option = String(options[index]).toUpperCase();
      if (option === 'PX') ttl = Number(options[++index]);
      else if (option === 'EX') ttl = Number(options[++index]) * 1000;
      else if (option === 'NX') onlyIfAbsent = true;
    }
    if (onlyIfAbsent && this.live(key)) return null;
    this.strings.set(key, { value: String(value), ...(ttl === undefined ? {} : { expiresAt: this.now() + ttl }) });
    return 'OK';
  }

  del(key: string): number {
    this.commands += 1;
    const removed =
      Number(this.strings.delete(key)) +
      Number(this.hashes.delete(key)) +
      Number(this.zsets.delete(key)) +
      Number(this.sets.delete(key)) +
      Number(this.lists.delete(key));
    return removed > 0 ? 1 : 0;
  }

  incrbyfloat(key: string, by: number | string): string {
    this.commands += 1;
    const entry = this.live(key);
    const next = Number(entry?.value ?? 0) + Number(by);
    this.strings.set(key, {
      value: String(next),
      ...(entry?.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    });
    return String(next);
  }

  pexpireat(key: string, at: number | string): number {
    this.commands += 1;
    const entry = this.live(key);
    if (entry) entry.expiresAt = Number(at);
    return entry ? 1 : 0;
  }

  pexpire(key: string, ms: number | string): number {
    this.commands += 1;
    const entry = this.live(key);
    if (entry) entry.expiresAt = this.now() + Number(ms);
    return entry ? 1 : 0;
  }

  // ── Sorted sets ─────────────────────────────────────────────────

  zadd(key: string, score: number | string, member: string): number {
    this.commands += 1;
    const set = this.zset(key);
    const value = Number(score);
    const previous = set.scores.get(member);
    if (previous !== undefined) {
      if (previous === value) return 0;
      set.order.splice(this.position(set.order, previous, member), 1);
    }
    set.scores.set(member, value);
    set.order.splice(this.position(set.order, value, member), 0, [value, member]);
    return previous === undefined ? 1 : 0;
  }

  zrem(key: string, ...members: string[]): number {
    this.commands += 1;
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      const score = set.scores.get(member);
      if (score === undefined) continue;
      set.order.splice(this.position(set.order, score, member), 1);
      set.scores.delete(member);
      removed += 1;
    }
    return removed;
  }

  zscore(key: string, member: string): string | null {
    this.commands += 1;
    const score = this.zsets.get(key)?.scores.get(member);
    return score === undefined ? null : String(score);
  }

  zcard(key: string): number {
    this.commands += 1;
    return this.zsets.get(key)?.scores.size ?? 0;
  }

  zrangebyscore(key: string, min: number | string, max: number | string, ...limit: Array<string | number>): string[] {
    this.commands += 1;
    const set = this.zsets.get(key);
    if (!set) return [];
    const low = bound(min, Number.NEGATIVE_INFINITY);
    const high = bound(max, Number.POSITIVE_INFINITY);
    let offset = 0;
    let count = Number.POSITIVE_INFINITY;
    if (String(limit[0] ?? '').toUpperCase() === 'LIMIT') {
      offset = Number(limit[1]);
      count = Number(limit[2]) < 0 ? Number.POSITIVE_INFINITY : Number(limit[2]);
    }
    const out: string[] = [];
    // Binary search for the first member at or above `low`, so a range read costs its size, not the set's.
    let start = 0;
    let end = set.order.length;
    while (start < end) {
      const middle = (start + end) >> 1;
      if (
        (set.order[middle] as [number, string])[0] < low.value ||
        (low.open && (set.order[middle] as [number, string])[0] === low.value)
      )
        start = middle + 1;
      else end = middle;
    }
    for (let index = start + offset; index < set.order.length && out.length < count; index += 1) {
      const [score, member] = set.order[index] as [number, string];
      if (score > high.value || (high.open && score === high.value)) break;
      out.push(member);
    }
    return out;
  }

  zremrangebyscore(key: string, min: number | string, max: number | string): number {
    const members = this.zrangebyscore(key, min, max);
    return members.length ? this.zrem(key, ...members) : 0;
  }

  // ── Scripts ─────────────────────────────────────────────────────

  eval(script: string, numKeys: number | string, ...args: Array<string | number>): unknown {
    this.commands += 1;
    const keys = args.slice(0, Number(numKeys)).map(String);
    const argv = args.slice(Number(numKeys)).map(String);
    this.lua.global.set('__keys', keys);
    this.lua.global.set('__argv', argv);
    const result = this.lua.doStringSync(
      `KEYS = {} for i = 1, #__keys do KEYS[i] = __keys[i] end
ARGV = {} for i = 1, #__argv do ARGV[i] = __argv[i] end
return (function()\n${script}\nend)()`,
    );
    return toReply(result);
  }

  /** Runs one `redis.call` from a script, converting the reply as Redis converts it for Lua. */
  private luaCall(args: unknown[]): unknown {
    const [name, ...rest] = args.map((arg) => (typeof arg === 'number' ? String(arg) : arg)) as string[];
    const command = String(name).toLowerCase();
    if (command === 'time') {
      const now = this.now();
      return [String(Math.floor(now / 1000)), String(Math.floor((now % 1000) * 1000))];
    }
    const method = (this as unknown as Record<string, (...input: unknown[]) => unknown>)[command];
    if (typeof method !== 'function') throw new Error(`FakeRedis has no ${name} command`);
    const reply = method.apply(this, rest);
    if (reply === null || reply === undefined) return false;
    if (reply && typeof reply === 'object' && !Array.isArray(reply)) return Object.entries(reply).flat();
    return reply;
  }

  private live(key: string): { value: string; expiresAt?: number } | undefined {
    const entry = this.strings.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  private hash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  private zset(key: string) {
    let set = this.zsets.get(key);
    if (!set) {
      set = { scores: new Map(), order: [] };
      this.zsets.set(key, set);
    }
    return set;
  }

  /** Where `[score, member]` sits, or would, in score-then-member order. */
  private position(order: Array<[number, string]>, score: number, member: string): number {
    let start = 0;
    let end = order.length;
    while (start < end) {
      const middle = (start + end) >> 1;
      const [s, m] = order[middle] as [number, string];
      if (s < score || (s === score && m < member)) start = middle + 1;
      else end = middle;
    }
    return start;
  }
}

function bound(value: number | string, infinite: number): { value: number; open: boolean } {
  const text = String(value);
  if (text === '-inf') return { value: Number.NEGATIVE_INFINITY, open: false };
  if (text === '+inf' || text === 'inf') return { value: Number.POSITIVE_INFINITY, open: false };
  if (text.startsWith('(')) return { value: Number(text.slice(1)), open: true };
  const parsed = Number(text);
  return { value: Number.isNaN(parsed) ? infinite : parsed, open: false };
}

/** A script's return value as Redis would reply: integers truncated, false as nil, tables as arrays. */
function toReply(value: unknown): unknown {
  if (value === false || value === undefined || value === null) return null;
  if (value === true) return 1;
  if (typeof value === 'number') return Math.trunc(value);
  if (Array.isArray(value)) return value.map(toReply);
  return value;
}
