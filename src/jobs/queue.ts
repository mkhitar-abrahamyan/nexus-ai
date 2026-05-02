export interface QueueJob<T = unknown> {
  id: string;
  payload: T;
  attempts: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export interface QueueOptions {
  concurrency?: number;
  maxAttempts?: number;
}

export class JobQueue<TPayload = unknown, TResult = unknown> {
  private jobs: Array<QueueJob<TPayload>> = [];
  private running = 0;

  constructor(
    private worker: (payload: TPayload, job: QueueJob<TPayload>) => Promise<TResult>,
    private options: QueueOptions = {},
  ) {}

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

  list(): Array<QueueJob<TPayload>> {
    return [...this.jobs];
  }

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
