import type { CronRecord, RunRecord, ServerStateStore } from '../types/server.js';
import { BadRequestError } from './errors.js';
import { MemoryServerStore } from './state.js';

/** A cron job that is due, with the slot it is due for. */
export interface DueCronJob extends CronRecord {
  /** The firing this is: the epoch millisecond of the slot, which makes the run idempotent. */
  slot: number;
}

/** Options for the cron scheduler. */
export interface CronSchedulerOptions {
  /** Starts a run for a due job. */
  start?: (job: DueCronJob) => Promise<RunRecord>;
  /** Where jobs are recorded. Defaults to memory; share it to schedule across replicas. */
  state?: ServerStateStore;
  /** How often due jobs are looked for, in milliseconds. Defaults to 30 seconds. */
  tickMs?: number;
  /** Receives errors from a firing, which never stop the scheduler. */
  onError?: (error: unknown, job: CronRecord) => void;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

const CRONS = ['nexus', 'server', 'crons'];

/**
 * Fires scheduled runs.
 *
 * Every replica ticks, and every firing is submitted with the idempotency key `<job>:<slot>`, so the
 * operation store decides which replica's submission wins and the job runs once however many
 * replicas are up. That is the whole coordination mechanism: no lock, no leader election, and a
 * replica that misses a tick simply does not win that slot.
 */
export class CronScheduler {
  private readonly state: ServerStateStore;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;

  constructor(private readonly options: CronSchedulerOptions = {}) {
    this.state = options.state ?? new MemoryServerStore();
    this.now = options.now ?? (() => new Date());
  }

  /** Adds a job, validating its schedule. */
  async add(job: Omit<CronRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<CronRecord> {
    if ('cron' in job.schedule) parseCron(job.schedule.cron);
    else if (!(job.schedule.everyMs > 0)) throw new BadRequestError('"everyMs" must be a positive number');
    const record: CronRecord = {
      ...job,
      id: job.id?.trim() || `cron-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: job.createdAt ?? this.now().toISOString(),
    };
    await this.state.put(CRONS, record.id, record);
    return record;
  }

  /** Reads a job. */
  async get(id: string): Promise<CronRecord | undefined> {
    return this.state.get<CronRecord>(CRONS, id);
  }

  /** Every job. */
  async list(): Promise<CronRecord[]> {
    return this.state.list<CronRecord>(CRONS, { limit: 500 });
  }

  /** Removes a job. */
  async remove(id: string): Promise<void> {
    await this.state.delete(CRONS, id);
  }

  /** Starts ticking. Ticks are skipped while one is still running. */
  start(): void {
    if (this.timer) return;
    this.lastTick = this.now().getTime();
    const tickMs = this.options.tickMs ?? 30_000;
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.tick().finally(() => {
        running = false;
      });
    }, tickMs);
    this.timer.unref?.();
  }

  /** Stops ticking. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Fires every job due since the last tick. Call it directly to drive the scheduler from a test or
   * from an external scheduler such as Kubernetes.
   */
  async tick(at: Date = this.now()): Promise<DueCronJob[]> {
    const now = at.getTime();
    const since = this.lastTick || now - (this.options.tickMs ?? 30_000);
    this.lastTick = now;
    const fired: DueCronJob[] = [];

    for (const job of await this.list()) {
      if (job.paused) continue;
      const slot = dueSlot(job, since, now);
      if (slot === undefined) continue;
      const due: DueCronJob = { ...job, slot };
      try {
        const run = await this.options.start?.(due);
        await this.state.put(CRONS, job.id, {
          ...job,
          lastRunAt: new Date(slot).toISOString(),
          lastRunId: run?.id ?? job.lastRunId,
        });
        fired.push(due);
      } catch (error) {
        this.options.onError?.(error, job);
      }
    }
    return fired;
  }
}

/** The most recent slot a job was due in, within a window, or `undefined` when it was not due. */
function dueSlot(job: CronRecord, since: number, now: number): number | undefined {
  if ('everyMs' in job.schedule) {
    const every = job.schedule.everyMs;
    const last = job.lastRunAt ? Date.parse(job.lastRunAt) : undefined;
    const previous = last ?? since;
    if (now - previous < every) return undefined;
    // Anchored to the interval so every replica computes the same slot for the same firing.
    return Math.floor(now / every) * every;
  }
  const fields = parseCron(job.schedule.cron);
  const lastRun = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
  for (let minute = Math.floor(now / 60_000) * 60_000; minute > since - 60_000 && minute > lastRun; minute -= 60_000) {
    if (matches(fields, new Date(minute))) return minute;
  }
  return undefined;
}

interface CronFields {
  minute: number[];
  hour: number[];
  day: number[];
  month: number[];
  weekday: number[];
}

/**
 * Parses the five-field cron syntax: `*`, numbers, `a-b` ranges, `a,b` lists, and `*​/n` steps.
 *
 * Times are UTC, so a schedule means the same thing on every replica whatever its timezone is set to.
 */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new BadRequestError(`"${expression}" is not a 5-field cron expression`, 'BAD_CRON');
  }
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  const fields = parts.map((part, index) => {
    const [min, max] = ranges[index] as [number, number];
    return field(part, min, max, expression);
  });
  return {
    minute: fields[0] as number[],
    hour: fields[1] as number[],
    day: fields[2] as number[],
    month: fields[3] as number[],
    weekday: (fields[4] as number[]).map((value) => value % 7),
  };
}

function field(part: string, min: number, max: number, expression: string): number[] {
  const values = new Set<number>();
  for (const item of part.split(',')) {
    const [range, stepText] = item.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new BadRequestError(`"${expression}" has an invalid step`, 'BAD_CRON');
    let start = min;
    let end = max;
    if (range !== '*' && range !== undefined && range !== '') {
      const bounds = range.split('-').map(Number);
      start = bounds[0] as number;
      end = bounds.length > 1 ? (bounds[1] as number) : (bounds[0] as number);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || end < start) {
        throw new BadRequestError(`"${expression}" has a field outside ${min}-${max}`, 'BAD_CRON');
      }
      if (stepText !== undefined && bounds.length === 1) end = max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function matches(fields: CronFields, at: Date): boolean {
  if (!fields.minute.includes(at.getUTCMinutes())) return false;
  if (!fields.hour.includes(at.getUTCHours())) return false;
  if (!fields.month.includes(at.getUTCMonth() + 1)) return false;

  const byDay = isRestricted(fields.day, 1, 31);
  const byWeekday = isRestricted(fields.weekday, 0, 6);
  const dayMatches = fields.day.includes(at.getUTCDate());
  const weekdayMatches = fields.weekday.includes(at.getUTCDay());
  // As cron has always done: with both day fields set, a match on either one is a match.
  if (byDay && byWeekday) return dayMatches || weekdayMatches;
  if (byDay) return dayMatches;
  if (byWeekday) return weekdayMatches;
  return true;
}

function isRestricted(values: number[], min: number, max: number): boolean {
  return values.length !== max - min + 1;
}
