/**
 * Online evaluation on workers: production runs scored continuously by a pool of workers that share a
 * durable operation store, within a spend budget.
 *
 * A worker samples runs, and queues one operation per run and source under an idempotency key, so a
 * run is queued once however many workers sample it. It stops queuing while the queue is full, and
 * scores what it claims, each evaluation first reserved from the budget. Every score is written to the
 * run with a mark naming its operation, so an operation run again after a crash writes only what is
 * missing: each run is scored exactly once per source, across workers and restarts.
 */
import { BudgetExceededError } from '../core/lifecycle.js';
import { operationStats } from '../operations/store.js';
import { OperationRunner } from '../operations/runner.js';
import type { AnnotationQueue } from './review.js';
import { traceEvidence } from './trace.js';
import type { EvaluationContext, EvaluationScore, EvaluationTrace, Evaluator } from '../types/evaluate.js';
import type {
  BudgetLedger,
  BudgetReservation,
  BudgetReservationOutcome,
  OperationDescriptor,
} from '../types/lifecycle.js';
import type { OperationContext, OperationStore } from '../types/operations.js';
import { isAfterCursor, runCursor } from '../tracing/query.js';
import type { Run, RunCursor, RunQuery, RunTree, TraceStore } from '../types/tracing.js';

/** Options for `onlineEvaluationWorker()`. */
export interface OnlineEvaluationWorkerOptions {
  /**
   * Names the evaluation. A run is scored once per source; its scores are recorded with it as their
   * `source`, and its operations are of kind `online-evaluation:<source>`.
   */
  source: string;
  /** Where the runs are, and where their scores go. It needs `addFeedback`. */
  traces: TraceStore;
  /** The evaluators each sampled run is scored with. */
  evaluators: Evaluator[];
  /** The durable queue the workers share: any operation store, such as Redis or Postgres. */
  operations: OperationStore;
  /** Which runs to score. Defaults to finished model runs. */
  query?: RunQuery;
  /**
   * The share of runs scored, from 0 to 1. A run is in or out by a hash of its id and the source, so
   * every worker, and every pass after a restart, samples the same runs. Defaults to 1.
   */
  sampleRate?: number;
  /** Runs read per scheduling pass. Defaults to 1,000. */
  scanLimit?: number;
  /** Stops queuing while this many of this source's operations are queued or running. Defaults to 1,000. */
  maxQueued?: number;
  /** Evaluations one worker runs at once. Defaults to 4. */
  concurrency?: number;
  /** How long a worker's claim on an evaluation lasts without a heartbeat. Defaults to 30 seconds. */
  leaseMs?: number;
  /** How long an idle worker waits before looking again. Defaults to 1 second. */
  pollMs?: number;
  /** The spend budget evaluations draw on, such as `budgetLedger()`. */
  budget?: BudgetLedger;
  /** US dollars reserved before each evaluation. Defaults to 0. */
  estimate?: number;
  /** What an evaluation actually cost, reconciled against its reservation. Defaults to the estimate. */
  costOf?: (scores: EvaluationScore[], run: Run) => number;
  /** The tenant the budget charges, when the ledger keys budgets by tenant. */
  tenantId?: string;
  /** Sends an uncertain result to people instead of scoring it automatically. */
  reviewQueue?: AnnotationQueue;
  /** Decides whether a run's scores are uncertain enough to send it to people. */
  reviewWhen?: (scores: EvaluationScore[], run: Run) => boolean;
  /**
   * Gives each evaluator what the run did, read from its trace, as `context.trace`: the run and
   * everything beneath it, with its tool calls, retrievals, model calls, and media. Costs one
   * `tree()` read per evaluation. Defaults to false.
   */
  withTrace?: boolean;
  /**
   * Hears each run's scores once they are written, on the worker that wrote them, such as
   * `automationRules().observe` acting when a score falls. A failure goes to `onError` and never
   * fails the evaluation, whose scores are already written.
   */
  onScored?: (scored: OnlineScored) => Promise<void> | void;
  /** Receives failures of `onScored`. */
  onError?: (error: unknown) => void;
  /** Identifies this worker in leases. Defaults to a generated id. */
  owner?: string;
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/** One run's scores, as `onScored` hears them. */
export interface OnlineScored {
  /** The run scored. */
  run: Run;
  /** Its scores, from every evaluator. */
  scores: EvaluationScore[];
  /** The source they were recorded under. */
  source: string;
  /** The evaluation operation that wrote them. */
  operationId: string;
}

/** What one scheduling pass did. */
export interface OnlineSchedulePass {
  /** Runs read. */
  scanned: number;
  /** Runs in the sample. */
  sampled: number;
  /** Operations this pass queued. */
  queued: number;
  /** True when the pass stopped because the queue was full. */
  throttled: boolean;
  /** True when the pass read back to the oldest matching run, so the next one starts at the newest. */
  exhausted: boolean;
  /**
   * How the pass paged: by cursor, or by offset on a trace store that does not honour
   * `RunQuery.after`, where runs that start in the same millisecond may be read twice but never skipped.
   */
  paging: 'cursor' | 'offset';
}

/** What a worker has done since it was created. */
export interface OnlineEvaluationWorkerReport {
  /** Runs this worker queued. */
  queued: number;
  /** Runs this worker scored. */
  scored: number;
  /** Operations it ran whose scores were already written, as after a crash. */
  alreadyScored: number;
  /** Operations whose run was gone. */
  missing: number;
  /** Evaluations that failed and will be tried again, or were dead-lettered. */
  failed: number;
  /** Why the worker last stopped: the queue ran dry, the budget ran out, or it was told to stop. */
  stoppedBy?: 'idle' | 'budget' | 'stopped';
}

/** A worker of an online evaluation. Run several, on as many processes, over one operation store. */
export interface OnlineEvaluationWorker {
  /** Identifies this worker in leases. */
  readonly id: string;
  /** Samples runs and queues what is not queued yet, until the queue is full. */
  schedule(): Promise<OnlineSchedulePass>;
  /**
   * Scores one batch: takes back evaluations whose worker stopped, claims up to `concurrency`
   * queued ones, and waits for them. Resolves to how many it took on.
   */
  work(): Promise<number>;
  /**
   * Schedules and scores until nothing is left to queue or score, or the budget runs out. Waits out
   * the lease of an evaluation a stopped worker held, then takes it back.
   */
  drain(options?: { signal?: AbortSignal }): Promise<OnlineEvaluationWorkerReport>;
  /** Drains again and again, waiting `intervalMs` when idle, until `stop()`. */
  start(options?: { intervalMs?: number }): void;
  /** Stops `start()` after the batch in flight. Resolves when it has stopped. */
  stop(): Promise<void>;
  /** What this worker has done. */
  report(): OnlineEvaluationWorkerReport;
}

/**
 * What an evaluation's heartbeat records just before it calls its evaluators: the reservation it
 * holds. Whoever settles that reservation after a crash reads from it whether the evaluators ran.
 */
interface EvaluationCheckpoint {
  reservation?: string;
  evaluating?: boolean;
}

/** What an evaluation operation records as its result. */
interface OnlineResult {
  status: 'scored' | 'already-scored' | 'missing';
  runId: string;
  scores?: Array<{ key: string; score: number }>;
}

/**
 * Thrown inside an evaluation handed back to the queue: when the budget is spent, or when recovery
 * took back an operation of another kind, which its own workers then claim.
 */
class HandBack extends Error {}

/**
 * A worker of an online evaluation. Any number of them, in any number of processes, share one
 * `operations` store: each samples, queues, and scores, and between them every sampled run is scored
 * exactly once for the source. A worker that crashes leaves its claims to lapse, and another takes
 * them back; a score it had already written is not written again.
 */
export function onlineEvaluationWorker(options: OnlineEvaluationWorkerOptions): OnlineEvaluationWorker {
  const kind = `online-evaluation:${options.source}`;
  const now = options.now ?? (() => new Date());
  const runner = new OperationRunner<OnlineResult>({
    store: options.operations as OperationStore<OnlineResult>,
    ...(options.owner ? { owner: options.owner } : {}),
    leaseMs: options.leaseMs ?? 30_000,
    heartbeatMs: Math.max(10, Math.floor((options.leaseMs ?? 30_000) / 3)),
    retry: { maxAttempts: 5, baseDelayMs: 50, jitter: 0 },
    now,
  });
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const rate = Math.min(1, Math.max(0, options.sampleRate ?? 1));
  const tally: OnlineEvaluationWorkerReport = { queued: 0, scored: 0, alreadyScored: 0, missing: 0, failed: 0 };
  let budgetSpent = false;
  // Each evaluation is its own operation for the budget, named by the operation that runs it.
  const descriptor = (requestId: string): OperationDescriptor => ({
    family: 'job',
    operation: `online-evaluation.${options.source}`,
    requestId,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });

  // What became of an evaluation that held a reservation: scored, so charged at what the scores
  // cost; never at its evaluators, so given back; or at them with nothing written, which no one knows.
  const outcomeOf = (evaluating: boolean, run: Run | undefined, operationId: string): BudgetReservationOutcome => {
    const scores = run ? scoresWritten(run, options.source, operationId) : [];
    if (scores.length > 0) {
      return { kind: 'finished', cost: (run && options.costOf?.(scores, run)) ?? options.estimate ?? 0 };
    }
    return evaluating ? { kind: 'unknown' } : { kind: 'never-started' };
  };
  // A reservation whose lease lapsed: its evaluation is read back to see how far it got.
  const resolveReservation = async (reservation: {
    id: string;
    operationId: string;
  }): Promise<BudgetReservationOutcome | undefined> => {
    const record = await options.operations.read(reservation.operationId);
    if (record?.kind !== kind) return undefined;
    const checkpoint = (record.heartbeatDetails ?? {}) as EvaluationCheckpoint;
    const mine = checkpoint.reservation === reservation.id;
    const live =
      record.status === 'running' && record.lease !== undefined && Date.parse(record.lease.expiresAt) > now().getTime();
    // Still at its evaluators, on a worker that holds its claim: only slower than the lease.
    if (live && mine) return { kind: 'running' };
    const run = await options.traces.get(String(record.metadata?.runId ?? ''));
    return mine ? outcomeOf(checkpoint.evaluating === true, run, reservation.operationId) : { kind: 'never-started' };
  };

  const inSample = (run: Run) => rate >= 1 || hash(`${options.source}:${run.id}`) < rate;
  const operationId = (runId: string) => `${kind}:${runId}`;
  const busy = async () => {
    const stats = await operationStats(options.operations, { kindPrefix: kind, now: now() });
    return (stats.byStatus.queued ?? 0) + (stats.byStatus.running ?? 0) + (stats.byStatus.retrying ?? 0);
  };

  const evaluate: (context: OperationContext) => Promise<OnlineResult> = async (context) => {
    const record = await options.operations.read(context.operationId);
    // Recovery takes back any lapsed claim in the store; one of another source goes back to the queue.
    if (record?.kind !== kind) {
      runner.release(context.operationId);
      throw new HandBack();
    }
    const runId = String(record.metadata?.runId ?? '');
    const run = await options.traces.get(runId);
    // An earlier attempt that died holding a reservation: settled by how far it got, before this one
    // reserves its own.
    const previous = context.previousHeartbeat as EvaluationCheckpoint | undefined;
    if (previous?.reservation && options.budget?.settle) {
      await options.budget.settle(
        previous.reservation,
        outcomeOf(previous.evaluating === true, run, context.operationId),
      );
    }
    if (!run) {
      tally.missing += 1;
      return { status: 'missing', runId };
    }
    // Scores this operation already wrote, before a crash: written again, they would count twice.
    const written = new Set(
      (run.feedback ?? [])
        .filter(
          (entry) =>
            entry.source === options.source &&
            (entry.value as { evaluation?: string })?.evaluation === context.operationId,
        )
        .map((entry) => entry.key),
    );
    // Every run of the evaluators is reserved, a run after a crash too: it calls them again, and a
    // judge bills each call.
    let reservation: BudgetReservation | undefined;
    if (options.budget) {
      try {
        reservation = await options.budget.reserve(descriptor(context.operationId), options.estimate ?? 0);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        budgetSpent = true;
        runner.release(context.operationId);
        throw new HandBack();
      }
    }
    try {
      // Recorded before the evaluators run, so a crash during them is known to have reached them.
      if (reservation?.id) {
        await context.heartbeat({ reservation: reservation.id, evaluating: true } satisfies EvaluationCheckpoint);
      }
      const tree = options.withTrace ? await options.traces.tree(run.traceId) : undefined;
      const scores = await scoreRun(run, options.evaluators, tree ? traceEvidence(subtree(tree, run.id)) : undefined);
      const missing = scores.filter((score) => !written.has(score.key));
      if (missing.length === 0 && written.size > 0) {
        if (reservation) {
          await options.budget?.reconcile(reservation, options.costOf?.(scores, run) ?? options.estimate ?? 0);
          reservation = undefined;
        }
        tally.alreadyScored += 1;
        return { status: 'already-scored', runId };
      }
      // A worker that lost its claim stops before it writes, so only the worker that holds it does.
      context.signal.throwIfAborted();
      const createdAt = now().toISOString();
      for (const score of missing) {
        await options.traces.addFeedback?.(run.id, {
          key: score.key,
          score: score.score,
          ...(score.comment ? { comment: score.comment } : {}),
          value: { evaluation: context.operationId },
          source: options.source,
          createdAt,
        });
      }
      if (reservation) {
        await options.budget?.reconcile(reservation, options.costOf?.(scores, run) ?? options.estimate ?? 0);
        reservation = undefined;
      }
      if (options.reviewQueue && options.reviewWhen?.(scores, run)) {
        options.reviewQueue.enqueue(
          { inputs: run.inputs, output: run.outputs, runId: run.id },
          { traceId: run.traceId },
        );
      }
      tally.scored += 1;
      if (options.onScored) {
        try {
          await options.onScored({ run, scores, source: options.source, operationId: context.operationId });
        } catch (error) {
          options.onError?.(error);
        }
      }
      return { status: 'scored', runId, scores: scores.map(({ key, score }) => ({ key, score })) };
    } finally {
      if (reservation) await options.budget?.release(reservation);
    }
  };

  const worker: OnlineEvaluationWorker = {
    get id() {
      return runner.workerId;
    },

    async schedule() {
      const pass: OnlineSchedulePass = {
        scanned: 0,
        sampled: 0,
        queued: 0,
        throttled: false,
        exhausted: false,
        paging: byOffset ? 'offset' : 'cursor',
      };
      if (budgetSpent) return pass;
      const limit = options.scanLimit ?? 1_000;
      // Runs come newest first. Once a page has nothing left to queue, the next pass reads the page
      // after its last run, back to the oldest, then starts again at the newest. A page resumes after
      // a run, not a timestamp: a thousand runs in one millisecond span pages without one skipped.
      const read = () =>
        options.traces.query({
          kind: 'model',
          status: 'ok',
          ...options.query,
          ...(byOffset ? { offset } : cursor ? { after: cursor } : {}),
          limit,
        });
      let runs = await read();
      // A store that predates the cursor answers from the newest run again. It is paged by offset
      // from here, starting over: a run read twice is skipped by its operation, and none is missed.
      if (!byOffset && cursor) {
        const from = cursor;
        if (runs.some((run) => !isAfterCursor(run, from))) {
          byOffset = true;
          pass.paging = 'offset';
          cursor = undefined;
          offset = 0;
          runs = await read();
        }
      }
      pass.scanned = runs.length;
      const maxQueued = options.maxQueued ?? 1_000;
      let open = await busy();
      let sinceCount = 0;
      for (const run of runs) {
        if (!inSample(run)) continue;
        pass.sampled += 1;
        const id = operationId(run.id);
        if (await options.operations.read(id)) continue;
        // Counted again every few, since other workers fill the queue and drain it too.
        if (open >= maxQueued || sinceCount >= 25) {
          open = await busy();
          sinceCount = 0;
          if (open >= maxQueued) {
            pass.throttled = true;
            break;
          }
        }
        const record = await runner.enqueue({
          id,
          idempotencyKey: id,
          kind,
          ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
          metadata: { runId: run.id, source: options.source },
        });
        if (record.id === id && record.status === 'queued' && record.sequence === 0) {
          pass.queued += 1;
          tally.queued += 1;
          open += 1;
          sinceCount += 1;
        }
      }
      if (!pass.throttled) {
        if (runs.length < limit) {
          pass.exhausted = true;
          cursor = undefined;
          offset = 0;
        } else if (pass.queued === 0) {
          const last = runs.at(-1);
          cursor = last ? runCursor(last) : undefined;
          offset += runs.length;
        }
      }
      return pass;
    },

    async work() {
      if (budgetSpent) return 0;
      // Reservations held by evaluations whose worker died, settled by how far each got.
      if (options.budget?.recover) {
        await options.budget.recover(resolveReservation, {
          operation: `online-evaluation.${options.source}`,
          limit: concurrency * 4,
        });
      }
      const handles = [
        ...(await runner.recover(evaluate, concurrency)),
        ...(await runner.claimQueued(evaluate, concurrency, { kindPrefix: kind })),
      ];
      await Promise.all(
        handles.map(async (handle) => {
          try {
            await handle.result();
          } catch (error) {
            if (!(error instanceof HandBack) && !budgetSpent) tally.failed += 1;
          }
        }),
      );
      return handles.length;
    },

    async drain(drainOptions = {}) {
      for (;;) {
        if (drainOptions.signal?.aborted) {
          tally.stoppedBy = 'stopped';
          return { ...tally };
        }
        const pass = await worker.schedule();
        const took = await worker.work();
        if (budgetSpent) {
          tally.stoppedBy = 'budget';
          return { ...tally };
        }
        if (took > 0 || pass.queued > 0) continue;
        // The pass moved back a page with nothing on this one to queue: read the next one now.
        if (!pass.exhausted && !pass.throttled) continue;
        if (pass.exhausted && (await busy()) === 0) {
          tally.stoppedBy = 'idle';
          return { ...tally };
        }
        // What is left is held by another worker, or by one that stopped and whose claim has to lapse.
        await sleep(options.pollMs ?? 1_000, drainOptions.signal);
      }
    },

    start(startOptions = {}) {
      if (running) return;
      const controller = new AbortController();
      stopping = controller;
      running = (async () => {
        while (!controller.signal.aborted) {
          await worker.drain({ signal: controller.signal }).catch(() => undefined);
          await sleep(startOptions.intervalMs ?? 10_000, controller.signal);
        }
      })();
    },

    async stop() {
      stopping?.abort();
      await running;
      running = undefined;
    },

    report() {
      return { ...tally };
    },
  };
  let running: Promise<void> | undefined;
  let stopping: AbortController | undefined;
  let cursor: RunCursor | undefined;
  let offset = 0;
  let byOffset = false;
  return worker;
}

/** The scores one evaluation operation wrote to a run, from the marks it left on them. */
function scoresWritten(run: Run, source: string, operationId: string): EvaluationScore[] {
  return (run.feedback ?? [])
    .filter((entry) => entry.source === source && (entry.value as { evaluation?: string })?.evaluation === operationId)
    .map((entry) => ({
      key: entry.key,
      score: entry.score ?? 0,
      ...(entry.comment ? { comment: entry.comment } : {}),
    }));
}

/** The run judged and everything beneath it, or the whole trace when the run is not in it by id. */
function subtree(tree: RunTree, runId: string): RunTree {
  const stack = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.id === runId) return node;
    stack.push(...node.children);
  }
  return tree;
}

/** A run's scores from every evaluator, as `evaluateOnline()` gives them. */
async function scoreRun(
  run: Run,
  evaluators: readonly Evaluator[],
  trace?: EvaluationTrace,
): Promise<EvaluationScore[]> {
  const context: EvaluationContext = {
    example: {
      id: run.id,
      inputs: run.inputs ?? trace?.inputs,
      expected: undefined,
      ...(run.metadata ? { metadata: run.metadata } : {}),
    },
    output: run.outputs,
    ...(run.error ? { error: run.error } : {}),
    latencyMs: run.latencyMs ?? 0,
    ...(run.cost === undefined ? {} : { cost: run.cost }),
    run: 0,
    ...(trace ? { trace } : {}),
  };
  const scores: EvaluationScore[] = [];
  for (const evaluator of evaluators) {
    const value = await evaluator(context);
    if (typeof value === 'number') scores.push({ key: 'score', score: value });
    else if (typeof value === 'boolean') scores.push({ key: 'score', score: value ? 1 : 0, passed: value });
    else scores.push(...(Array.isArray(value) ? value : [value]));
  }
  return scores;
}

/** A number from 0 to 1, the same for the same text on every process. */
function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0) / 4294967296;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
