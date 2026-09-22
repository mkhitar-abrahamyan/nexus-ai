import type { OperationDispatcher, OperationRecord, OperationStore } from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';
import { assertSerializableRecord } from './serialization.js';

/**
 * The Redis commands the operation store needs.
 *
 * Structural rather than tied to one client, so `ioredis`, `node-redis`, or a cluster proxy all
 * satisfy it without this package depending on any of them.
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
}

const CAS_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current == false then return 0 end
local decoded = cjson.decode(current)
if tonumber(decoded.sequence) ~= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

/** Options for the Redis operation store. */
export interface RedisOperationStoreOptions {
  /** Key prefix. Defaults to `nexus-ai-pro:operations:`. */
  prefix?: string;
  /** Disables the Lua compare-and-set even when the client exposes `eval`. */
  useEval?: boolean;
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

  constructor(
    private readonly client: RedisOperationLikeClient,
    options: RedisOperationStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:operations:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
  }

  /** Stores a new record and indexes its idempotency key. Refuses records carrying raw bytes. */
  async create(record: OperationRecord<TResult>): Promise<void> {
    assertSerializableRecord(record);
    await this.client.hset(this.recordsKey(), record.id, JSON.stringify(record));
    if (record.idempotencyKey) {
      await this.client.hset(this.idempotencyKey(), record.idempotencyKey, record.id);
    }
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
    return true;
  }

  /** Deletes a record and its idempotency index. Resolves true when it existed. */
  async delete(id: string): Promise<boolean> {
    const record = await this.read(id);
    if (record?.idempotencyKey) await this.client.hdel(this.idempotencyKey(), record.idempotencyKey);
    await this.client.hdel(this.recordsKey(), id);
    return record !== undefined;
  }

  /**
   * Records whose lease has expired, or running records without one, up to `limit`, for another
   * worker to take over.
   */
  async claimExpired(now: string, limit: number): Promise<Array<OperationRecord<TResult>>> {
    const records = await this.list();
    const expired: Array<OperationRecord<TResult>> = [];
    for (const record of records) {
      if (expired.length >= limit) break;
      if (isTerminalOperationStatus(record.status)) continue;
      if (record.lease && record.lease.expiresAt > now) continue;
      if (record.status === 'running' || record.lease) expired.push(record);
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

  private recordsKey(): string {
    return `${this.prefix}records`;
  }

  private idempotencyKey(): string {
    return `${this.prefix}idempotency`;
  }
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
