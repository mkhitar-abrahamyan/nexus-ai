/** A job in an in-process queue. */
export interface QueueJob<T = unknown> {
  /** The job's id. */
  id: string;
  /** What the worker receives. */
  payload: T;
  /** Times it has been tried. */
  attempts: number;
  /** Where it stands. */
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** What the worker returned. */
  result?: unknown;
  /** Why the last attempt failed. */
  error?: string;
}

/** Options for an in-process job queue. */
export interface QueueOptions {
  /** Jobs run at once. Defaults to 1. */
  concurrency?: number;
  /** Tries per job before it is marked failed. Defaults to 1. */
  maxAttempts?: number;
}

/**
 * An in-process job queue with concurrency and retries. Jobs are lost on restart; the operations
 * family is the durable option.
 */
export class JobQueue<TPayload = unknown, TResult = unknown> {
  private jobs: Array<QueueJob<TPayload>> = [];
  private running = 0;

  constructor(
    private worker: (payload: TPayload, job: QueueJob<TPayload>) => Promise<TResult>,
    private options: QueueOptions = {},
  ) {}

  /** Adds a job and starts it when a slot is free. */
  enqueue(payload: TPayload, id = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`): QueueJob<TPayload> {
    const job: QueueJob<TPayload> = {
      id,
      payload,
      attempts: 0,
      status: 'queued',
    };
    this.jobs.push(job);
    void this.drain();
    return job;
  }

  /** Every job, in the order added. */
  list(): Array<QueueJob<TPayload>> {
    return [...this.jobs];
  }

  /** Reads a job. */
  get(id: string): QueueJob<TPayload> | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  private async drain(): Promise<void> {
    const concurrency = this.options.concurrency || 1;
    while (this.running < concurrency) {
      const job = this.jobs.find((item) => item.status === 'queued');
      if (!job) return;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        void this.drain();
      });
    }
  }

  private async run(job: QueueJob<TPayload>): Promise<void> {
    job.status = 'running';
    job.attempts += 1;
    try {
      job.result = await this.worker(job.payload, job);
      job.status = 'completed';
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      if (job.attempts < (this.options.maxAttempts || 1)) {
        job.status = 'queued';
      } else {
        job.status = 'failed';
      }
    }
  }
}
