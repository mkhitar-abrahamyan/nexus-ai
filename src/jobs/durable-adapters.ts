import type { QueueJob } from './queue.js';

/**
 * Where a job queue keeps its jobs so they survive a restart. Methods may be synchronous or
 * asynchronous.
 */
export interface DurableQueueAdapter<TPayload = unknown> {
  /** Adds a job. */
  enqueue(queueName: string, job: QueueJob<TPayload>): Promise<void> | void;
  /** Reads a job. */
  get(queueName: string, id: string): Promise<QueueJob<TPayload> | undefined> | QueueJob<TPayload> | undefined;
  /** Replaces a job's stored state. */
  update(queueName: string, job: QueueJob<TPayload>): Promise<void> | void;
  /** Every job in a queue. */
  list(queueName: string): Promise<Array<QueueJob<TPayload>>> | Array<QueueJob<TPayload>>;
}

/** The Redis commands the queue adapter needs, in `ioredis` argument order. */
export interface RedisQueueLikeClient {
  /** Pushes onto a list. */
  lpush(key: string, value: string): Promise<unknown> | unknown;
  /** Sets a hash field. */
  hset(key: string, field: string, value: string): Promise<unknown> | unknown;
  /** Reads a hash field. */
  hget(key: string, field: string): Promise<string | null> | string | null;
  /** Reads every hash value. */
  hvals(key: string): Promise<string[]> | string[];
}

/** Keeps queue jobs in Redis: one hash of jobs per queue, and a list of pending ids. */
export class RedisQueueAdapter<TPayload = unknown> implements DurableQueueAdapter<TPayload> {
  constructor(
    private client: RedisQueueLikeClient,
    private prefix = 'nexus-ai-pro:queue:',
  ) {}

  /** Stores a job and pushes its id onto the pending list. */
  async enqueue(queueName: string, job: QueueJob<TPayload>): Promise<void> {
    await this.client.hset(this.jobsKey(queueName), job.id, JSON.stringify(job));
    await this.client.lpush(this.pendingKey(queueName), job.id);
  }

  /** Reads a job. */
  async get(queueName: string, id: string): Promise<QueueJob<TPayload> | undefined> {
    const raw = await this.client.hget(this.jobsKey(queueName), id);
    return raw ? (JSON.parse(raw) as QueueJob<TPayload>) : undefined;
  }

  /** Replaces a job's stored state. */
  async update(queueName: string, job: QueueJob<TPayload>): Promise<void> {
    await this.client.hset(this.jobsKey(queueName), job.id, JSON.stringify(job));
  }

  /** Every job in a queue. */
  async list(queueName: string): Promise<Array<QueueJob<TPayload>>> {
    const values = await this.client.hvals(this.jobsKey(queueName));
    return values.map((value) => JSON.parse(value) as QueueJob<TPayload>);
  }

  private jobsKey(queueName: string): string {
    return `${this.prefix}${queueName}:jobs`;
  }

  private pendingKey(queueName: string): string {
    return `${this.prefix}${queueName}:pending`;
  }
}

/** The part of a BullMQ `Queue` the adapter needs. */
export interface BullMQLikeQueue<TPayload = unknown> {
  /** Adds a job. */
  add(
    name: string,
    data: TPayload,
    options?: Record<string, unknown>,
  ): Promise<{ id?: string | number }> | { id?: string | number };
  /** Reads a job. */
  getJob(
    id: string,
  ): Promise<{ id: string | number; data: TPayload; returnvalue?: unknown; failedReason?: string } | null>;
}

/** Hands jobs to an existing BullMQ queue, whose workers run them. */
export class BullMQQueueAdapter<TPayload = unknown> {
  constructor(private queue: BullMQLikeQueue<TPayload>) {}

  /** Adds a job and returns its id. */
  async enqueue(name: string, payload: TPayload, options: Record<string, unknown> = {}): Promise<string> {
    const job = await this.queue.add(name, payload, options);
    return String(job.id || '');
  }

  /** Reads a job's payload, result, and failure reason. */
  async get(id: string): Promise<{ id: string; payload: TPayload; result?: unknown; error?: string } | undefined> {
    const job = await this.queue.getJob(id);
    if (!job) return undefined;
    return {
      id: String(job.id),
      payload: job.data,
      result: job.returnvalue,
      error: job.failedReason,
    };
  }
}
