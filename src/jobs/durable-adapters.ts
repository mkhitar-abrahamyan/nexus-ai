import type { QueueJob } from './queue.js';

export interface DurableQueueAdapter<TPayload = unknown> {
  enqueue(queueName: string, job: QueueJob<TPayload>): Promise<void> | void;
  get(queueName: string, id: string): Promise<QueueJob<TPayload> | undefined> | QueueJob<TPayload> | undefined;
  update(queueName: string, job: QueueJob<TPayload>): Promise<void> | void;
  list(queueName: string): Promise<Array<QueueJob<TPayload>>> | Array<QueueJob<TPayload>>;
}

export interface RedisQueueLikeClient {
  lpush(key: string, value: string): Promise<unknown> | unknown;
  hset(key: string, field: string, value: string): Promise<unknown> | unknown;
  hget(key: string, field: string): Promise<string | null> | string | null;
  hvals(key: string): Promise<string[]> | string[];
}

export class RedisQueueAdapter<TPayload = unknown> implements DurableQueueAdapter<TPayload> {
  constructor(private client: RedisQueueLikeClient, private prefix = 'nexus-ai-pro:queue:') {}

  async enqueue(queueName: string, job: QueueJob<TPayload>): Promise<void> {
    await this.client.hset(this.jobsKey(queueName), job.id, JSON.stringify(job));
    await this.client.lpush(this.pendingKey(queueName), job.id);
  }

  async get(queueName: string, id: string): Promise<QueueJob<TPayload> | undefined> {
    const raw = await this.client.hget(this.jobsKey(queueName), id);
    return raw ? JSON.parse(raw) as QueueJob<TPayload> : undefined;
  }

  async update(queueName: string, job: QueueJob<TPayload>): Promise<void> {
    await this.client.hset(this.jobsKey(queueName), job.id, JSON.stringify(job));
  }

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

export interface BullMQLikeQueue<TPayload = unknown> {
  add(name: string, data: TPayload, options?: Record<string, unknown>): Promise<{ id?: string | number }> | { id?: string | number };
  getJob(id: string): Promise<{ id: string | number; data: TPayload; returnvalue?: unknown; failedReason?: string } | null>;
}

export class BullMQQueueAdapter<TPayload = unknown> {
  constructor(private queue: BullMQLikeQueue<TPayload>) {}

  async enqueue(name: string, payload: TPayload, options: Record<string, unknown> = {}): Promise<string> {
    const job = await this.queue.add(name, payload, options);
    return String(job.id || '');
  }

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
