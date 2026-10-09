import type {
  OperationDispatcher,
  OperationRecord,
  OperationStore,
  OperationStoreFilter,
  OperationStoreStats,
} from '../types/operations.js';
import { isTerminalOperationStatus, TERMINAL_OPERATION_STATUSES } from '../types/operations.js';
import { OperationDuplicateError } from './errors.js';
import { assertSerializableRecord } from './serialization.js';
import { countRecords, isUnheldQueued, matchesFilter } from './stats.js';

/**
 * The Redis commands the operation store needs.
 *
 * Structural rather than tied to one client, so `ioredis`, `node-redis`, or a cluster proxy all
 * satisfy it without this package depending on any of them. The sorted-set commands are needed only
 * with `index: true`; `ioredis` has them all.
 */
export interface RedisOperationLikeClient {
  /** Reads a hash field. */
  hget(key: string, field: string): Promise<string | null> | string | null;
  /** Sets a hash field. */
  hset(key: string, field: string, value: string): Promise<unknown> | unknown;
  /** Deletes a hash field. */
  hdel(key: string, field: string): Promise<unknown> | unknown;
  /** Reads every hash value. */
  hvals(key: string): Promise<string[]> | string[];
  /** Optional CAS primitive. When absent the store falls back to a read-compare-write. */
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown> | unknown;
  /** Reads several hash fields in one round trip. Used by the index when present. */
  hmget?(key: string, ...fields: string[]): Promise<Array<string | null>> | Array<string | null>;
  /** Adds a sorted-set member. Needed with `index: true`. */
  zadd?(key: string, score: number, member: string): Promise<unknown> | unknown;
  /** Removes a sorted-set member. Needed with `index: true`. */
  zrem?(key: string, member: string): Promise<unknown> | unknown;
  /** Members by score, as `ZRANGEBYSCORE key min max LIMIT offset count`. Needed with `index: true`. */
  zrangebyscore?(
    key: string,
    min: number | string,
    max: number | string,
    limit: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]> | string[];
}

const CAS_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current == false then return 0 end
local decoded = cjson.decode(current)
if tonumber(decoded.sequence) ~= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

/** Writes one index entry of a record: present with a score, or absent for an empty one. */
const PLACE_LUA = `
local function place(key, score, id)
  if score ~= '' then redis.call('ZADD', key, score, id) else redis.call('ZREM', key, id) end
end
`;

/** Refuses a create whose idempotency key another live record holds. Returns 0 from the script. */
const UNIQUE_KEY_LUA = `
if ARGV[3] ~= '' then
  local owner = redis.call('HGET', KEYS[2], ARGV[3])
  if owner and owner ~= ARGV[1] and redis.call('HEXISTS', KEYS[1], owner) == 1 then return 0 end
end
`;

// KEYS: records, idempotency. ARGV: id, record, idempotency key.
const CREATE_SCRIPT = `${UNIQUE_KEY_LUA}
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[3], ARGV[1]) end
return 1
`;

// KEYS: records, idempotency, queued, leases. ARGV: id, record, idempotency key, queued score, lease score.
const INDEXED_CREATE_SCRIPT = `${PLACE_LUA}${UNIQUE_KEY_LUA}
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[3], ARGV[1]) end
place(KEYS[3], ARGV[4], ARGV[1])
place(KEYS[4], ARGV[5], ARGV[1])
return 1
`;

// KEYS: records, queued, leases. ARGV: id, expected sequence, record, queued score, lease score.
const INDEXED_CAS_SCRIPT = `${PLACE_LUA}
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current == false then return 0 end
local decoded = cjson.decode(current)
if tonumber(decoded.sequence) ~= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
place(KEYS[2], ARGV[4], ARGV[1])
place(KEYS[3], ARGV[5], ARGV[1])
return 1
`;

// KEYS: records, one index. ARGV: the index's name, then ids. Removes the ids the index no longer
// describes, checking each record in the same step, so an entry written back meanwhile is never lost.
const PRUNE_SCRIPT = `
local terminal = { ${TERMINAL_OPERATION_STATUSES.map((status) => `${status} = true`).join(', ')} }
local removed = 0
for i = 2, #ARGV do
  local raw = redis.call('HGET', KEYS[1], ARGV[i])
  local keep = false
  if raw then
    local record = cjson.decode(raw)
    if ARGV[1] == 'queued' then
      keep = record.status == 'queued'
    else
      keep = (not terminal[record.status]) and (record.lease ~= nil or record.status == 'running')
    end
  end
  if not keep then
    redis.call('ZREM', KEYS[2], ARGV[i])
    removed = removed + 1
  end
end
return removed
`;

/** Options for the Redis operation store. */
export interface RedisOperationStoreOptions {
  /** Key prefix. Defaults to `nexus-ai-pro:operations:`. */
  prefix?: string;
  /** Disables the Lua compare-and-set even when the client exposes `eval`. */
  useEval?: boolean;
  /**
   * Keeps queued work in a sorted set by age, and leased work in one by lease expiry, so
   * `listQueued()` and `claimExpired()` read the oldest few records instead of every one: a claim
   * costs the same with 100,000 operations queued as with 1,000. The records stay the source of
   * truth; an index entry only says where to look, and one that no longer matches its record is
   * skipped and removed.
   *
   * Off by default, because a 2.1 worker writes records without index entries. Turn it on once every
   * worker sharing the prefix runs 2.2, then call `reindex()` once to index what is already there.
   * Needs `zadd`, `zrem`, and `zrangebyscore`; with `eval`, a record and its index entries change in
   * one step.
   */
  index?: boolean;
}

/**
 * Redis-backed operation storage, so a submitted operation survives a restart.
 *
 * Updates are a compare-and-set on `sequence`. When the client exposes `eval` the comparison and
 * the write happen in one Lua call, which is genuinely atomic; otherwise the store falls back to a
 * read-compare-write that narrows the race but cannot close it. Prefer a client with `eval`
 * whenever more than one worker can touch the same operation.
 */
export class RedisOperationStore<TResult = unknown> implements OperationStore<TResult> {
  private readonly prefix: string;
  private readonly useEval: boolean;
  /** Whether queued and leased work is kept in sorted sets, as `index: true` asks. */
  readonly indexed: boolean;

  constructor(
    private readonly client: RedisOperationLikeClient,
    options: RedisOperationStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:operations:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
    this.indexed = options.index === true;
    if (this.indexed && !(client.zadd && client.zrem && client.zrangebyscore)) {
      throw new TypeError('A Redis operation store with index: true needs zadd, zrem, and zrangebyscore');
    }
  }

  /**
   * Stores a new record and indexes its idempotency key. Throws `OperationDuplicateError` when another
   * record holds the key, checked in the same Lua call as the write when the client has `eval`.
   * Refuses records carrying raw bytes.
   */
  async create(record: OperationRecord<TResult>): Promise<void> {
    assertSerializableRecord(record);
    const encoded = JSON.stringify(record);
    const duplicate = () => new OperationDuplicateError(record.idempotencyKey as string);
    if (this.useEval && this.client.eval && !this.indexed) {
      const created = await this.client.eval(
        CREATE_SCRIPT,
        2,
        this.recordsKey(),
        this.idempotencyKey(),
        record.id,
        encoded,
        record.idempotencyKey ?? '',
      );
      if (Number(created) !== 1) throw duplicate();
      return;
    }
    if (this.indexed && this.useEval && this.client.eval) {
      const { queued, lease } = indexScores(record);
      const created = await this.client.eval(
        INDEXED_CREATE_SCRIPT,
        4,
        this.recordsKey(),
        this.idempotencyKey(),
        this.queuedKey(),
        this.leasesKey(),
        record.id,
        encoded,
        record.idempotencyKey ?? '',
        queued,
        lease,
      );
      if (Number(created) !== 1) throw duplicate();
      return;
    }
    if (record.idempotencyKey) {
      // Without eval the check and the write are separate, which narrows the race but cannot close it.
      const owner = await this.client.hget(this.idempotencyKey(), record.idempotencyKey);
      if (owner && owner !== record.id && (await this.client.hget(this.recordsKey(), owner))) throw duplicate();
    }
    await this.client.hset(this.recordsKey(), record.id, encoded);
    if (record.idempotencyKey) {
      await this.client.hset(this.idempotencyKey(), record.idempotencyKey, record.id);
    }
    if (this.indexed) await this.place(record);
  }

  /** Reads a record. */
  async read(id: string): Promise<OperationRecord<TResult> | undefined> {
    const raw = await this.client.hget(this.recordsKey(), id);
    return raw ? (JSON.parse(raw) as OperationRecord<TResult>) : undefined;
  }

  /**
   * Writes a record when its stored sequence still equals `expectedSequence`. Resolves false when
   * another worker got there first.
   */
  async update(record: OperationRecord<TResult>, expectedSequence: number): Promise<boolean> {
    assertSerializableRecord(record);
    const encoded = JSON.stringify(record);

    if (this.useEval && this.client.eval) {
      if (this.indexed) {
        const { queued, lease } = indexScores(record);
        const result = await this.client.eval(
          INDEXED_CAS_SCRIPT,
          3,
          this.recordsKey(),
          this.queuedKey(),
          this.leasesKey(),
          record.id,
          String(expectedSequence),
          encoded,
          queued,
          lease,
        );
        return Number(result) === 1;
      }
      const result = await this.client.eval(
        CAS_SCRIPT,
        1,
        this.recordsKey(),
        record.id,
        String(expectedSequence),
        encoded,
      );
      return Number(result) === 1;
    }

    const current = await this.read(record.id);
    if (!current || current.sequence !== expectedSequence) return false;
    await this.client.hset(this.recordsKey(), record.id, encoded);
    if (this.indexed) await this.place(record);
    return true;
  }

  /** Deletes a record and its idempotency index. Resolves true when it existed. */
  async delete(id: string): Promise<boolean> {
    const record = await this.read(id);
    if (record?.idempotencyKey) await this.client.hdel(this.idempotencyKey(), record.idempotencyKey);
    await this.client.hdel(this.recordsKey(), id);
    if (this.indexed) {
      await this.client.zrem?.(this.queuedKey(), id);
      await this.client.zrem?.(this.leasesKey(), id);
    }
    return record !== undefined;
  }

  /**
   * Records whose lease has expired, or running records without one, up to `limit`, for another
   * worker to take over. With the index, reads only records whose lease has lapsed.
   */
  async claimExpired(now: string, limit: number): Promise<Array<OperationRecord<TResult>>> {
    if (this.indexed) {
      return this.scanIndex('leases', Date.parse(now), limit, (record) => isExpired(record, now), isLeased);
    }
    const records = await this.list();
    const expired: Array<OperationRecord<TResult>> = [];
    for (const record of records) {
      if (expired.length >= limit) break;
      if (isExpired(record, now)) expired.push(record);
    }
    return expired;
  }

  /** Finds the record that claimed an idempotency key. */
  async findByIdempotencyKey(key: string): Promise<OperationRecord<TResult> | undefined> {
    const id = await this.client.hget(this.idempotencyKey(), key);
    return id ? this.read(id) : undefined;
  }

  /** Every record. */
  async list(): Promise<Array<OperationRecord<TResult>>> {
    const values = await this.client.hvals(this.recordsKey());
    return values.map((value) => JSON.parse(value) as OperationRecord<TResult>);
  }

  /**
   * Queued records no worker holds, oldest first. With the index, reads them oldest first from the
   * sorted set and stops at `limit`; without it, reads every record, as `list()` does.
   */
  async listQueued(limit: number, filter?: OperationStoreFilter): Promise<Array<OperationRecord<TResult>>> {
    const now = new Date().toISOString();
    if (this.indexed) {
      return this.scanIndex(
        'queued',
        Number.POSITIVE_INFINITY,
        limit,
        (record) => isUnheldQueued(record, now) && matchesFilter(record, filter),
        (record) => record.status === 'queued',
      );
    }
    return (await this.list())
      .filter((record) => isUnheldQueued(record, now) && matchesFilter(record, filter))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .slice(0, limit);
  }

  /** Counts unfinished records by status. Reads every record, as `list()` does. */
  async stats(now: string, filter?: OperationStoreFilter): Promise<OperationStoreStats> {
    return countRecords(await this.list(), now, filter);
  }

  /**
   * Indexes every record already stored, for turning `index` on over existing data. Safe to run
   * while workers are busy, and to run again: it only adds entries, then removes those that no
   * longer match their record, checking each record as it does. Resolves to how many records it read.
   */
  async reindex(): Promise<number> {
    if (!this.indexed) throw new TypeError('reindex() needs a store created with index: true');
    const records = await this.list();
    for (const record of records) {
      const { queued, lease } = indexScores(record);
      if (queued !== '') await this.client.zadd?.(this.queuedKey(), Number(queued), record.id);
      if (lease !== '') await this.client.zadd?.(this.leasesKey(), Number(lease), record.id);
    }
    await this.prune(
      'queued',
      records.filter((record) => record.status !== 'queued').map((record) => record.id),
    );
    await this.prune(
      'leases',
      records.filter((record) => !isLeased(record)).map((record) => record.id),
    );
    return records.length;
  }

  /**
   * Reads one index in score order up to `max`, a page at a time, keeping records that pass `keep`
   * until `limit`. Entries whose record is gone or no longer `belongs` are removed afterwards.
   */
  private async scanIndex(
    index: 'queued' | 'leases',
    max: number,
    limit: number,
    keep: (record: OperationRecord<TResult>) => boolean,
    belongs: (record: OperationRecord<TResult>) => boolean,
  ): Promise<Array<OperationRecord<TResult>>> {
    const found: Array<OperationRecord<TResult>> = [];
    if (limit <= 0) return found;
    const stale: string[] = [];
    const key = index === 'queued' ? this.queuedKey() : this.leasesKey();
    const upper = max === Number.POSITIVE_INFINITY ? '+inf' : max;
    const page = Math.max(16, limit * 4);
    for (let offset = 0; found.length < limit; offset += page) {
      const ids = (await this.client.zrangebyscore?.(key, '-inf', upper, 'LIMIT', offset, page)) ?? [];
      const records = await this.readMany(ids);
      for (const [position, id] of ids.entries()) {
        const record = records[position];
        if (!record || !belongs(record)) {
          stale.push(id);
          continue;
        }
        if (keep(record)) found.push(record);
        if (found.length >= limit) break;
      }
      if (ids.length < page) break;
    }
    await this.prune(index, stale);
    return found;
  }

  private async readMany(ids: readonly string[]): Promise<Array<OperationRecord<TResult> | undefined>> {
    if (ids.length === 0) return [];
    const raws = this.client.hmget
      ? await this.client.hmget(this.recordsKey(), ...ids)
      : await Promise.all(ids.map((id) => this.client.hget(this.recordsKey(), id)));
    return raws.map((raw) => (raw ? (JSON.parse(raw) as OperationRecord<TResult>) : undefined));
  }

  /** Removes index entries that no longer describe their record. Only with `eval`, where the check is atomic. */
  private async prune(index: 'queued' | 'leases', ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || !this.useEval || !this.client.eval) return;
    const key = index === 'queued' ? this.queuedKey() : this.leasesKey();
    for (let start = 0; start < ids.length; start += 500) {
      await this.client.eval(PRUNE_SCRIPT, 2, this.recordsKey(), key, index, ...ids.slice(start, start + 500));
    }
  }

  /** Writes a record's index entries without `eval`, after the record itself. */
  private async place(record: OperationRecord<TResult>): Promise<void> {
    const { queued, lease } = indexScores(record);
    if (queued !== '') await this.client.zadd?.(this.queuedKey(), Number(queued), record.id);
    else await this.client.zrem?.(this.queuedKey(), record.id);
    if (lease !== '') await this.client.zadd?.(this.leasesKey(), Number(lease), record.id);
    else await this.client.zrem?.(this.leasesKey(), record.id);
  }

  private recordsKey(): string {
    return `${this.prefix}records`;
  }

  private idempotencyKey(): string {
    return `${this.prefix}idempotency`;
  }

  private queuedKey(): string {
    return `${this.prefix}queued`;
  }

  private leasesKey(): string {
    return `${this.prefix}leases`;
  }
}

/** Whether recovery may take a record over: unfinished, and its lease lapsed or never taken while running. */
function isExpired(record: OperationRecord<unknown>, now: string): boolean {
  if (isTerminalOperationStatus(record.status)) return false;
  if (record.lease && record.lease.expiresAt > now) return false;
  return record.status === 'running' || record.lease !== undefined;
}

/** Whether a record belongs in the lease index: unfinished, and leased or running. */
function isLeased(record: OperationRecord<unknown>): boolean {
  return !isTerminalOperationStatus(record.status) && (record.lease !== undefined || record.status === 'running');
}

/**
 * Where a record belongs in each index, as scores, or an empty string for "not in it". Queued work
 * is ordered by creation, the order every store hands it out in. Leased work is ordered by when its
 * lease lapses, and running work without a lease is due at once.
 */
function indexScores(record: OperationRecord<unknown>): { queued: string; lease: string } {
  return {
    queued: record.status === 'queued' ? String(Date.parse(record.createdAt)) : '',
    lease: isLeased(record) ? String(record.lease ? Date.parse(record.lease.expiresAt) : 0) : '',
  };
}

/** The part of a BullMQ `Queue` the dispatcher needs. */
export interface BullMQLikeOperationQueue {
  /** Adds a job. */
  add(
    name: string,
    data: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ id?: string | number }> | { id?: string | number };
}

/** Options for the BullMQ operation dispatcher. */
export interface BullMQOperationDispatcherOptions {
  /** Job name used for every dispatched operation. Defaults to `nexus-operation`. */
  jobName?: string;
  /** Merged into the BullMQ job options, for priority, delay, or removal policy. */
  jobOptions?: Record<string, unknown>;
}

/**
 * Hands accepted operations to a BullMQ queue for a worker process to execute.
 *
 * Only the operation id and its routing metadata are queued — never the record's result or any
 * payload — so the job stays small and the store remains the single source of truth. The worker
 * reads the record by id, which is also what makes a redelivered job safe.
 */
export class BullMQOperationDispatcher implements OperationDispatcher {
  constructor(
    private readonly queue: BullMQLikeOperationQueue,
    private readonly options: BullMQOperationDispatcherOptions = {},
  ) {}

  /**
   * Queues an operation's id and routing metadata, using the operation id as the job id so a
   * duplicate dispatch is ignored.
   */
  async dispatch(record: OperationRecord<unknown>): Promise<void> {
    await this.queue.add(
      this.options.jobName ?? 'nexus-operation',
      {
        operationId: record.id,
        kind: record.kind,
        attempt: record.attempt,
        traceContext: record.traceContext,
      },
      { jobId: record.id, ...this.options.jobOptions },
    );
  }
}
