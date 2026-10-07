import { compareRuns, type Regression, type RegressionMetric, type RunSample } from '../insights/regressions.js';
import type { EvaluationScore, Evaluator } from '../types/evaluate.js';
import type {
  AssistantRunContext,
  DeploymentChange,
  DeploymentChangeRecord,
  DeploymentRecord,
  ReplicaReport,
  RevisionChoice,
  RevisionRequest,
  RunRecord,
  ServerAssistant,
  ServerDeployments,
  ServerStateStore,
} from '../types/server.js';
import { AssistantCapabilityError, BadRequestError, ServerError } from './errors.js';
import { MemoryServerStore, RUNS_NAMESPACE } from './state.js';

export type {
  DeploymentChange,
  DeploymentChangeRecord,
  DeploymentRecord,
  ReplicaReport,
  RevisionChoice,
  RevisionReason,
  RevisionRequest,
  RunRevision,
} from '../types/server.js';

/** Options for `Deployments`. */
export interface DeploymentsOptions {
  /**
   * Where deployments and replica heartbeats are recorded. Give it the server's own state store, so
   * every replica — and a studio pointed at the same store — sees one set. Defaults to memory, for one
   * process.
   */
  state?: ServerStateStore;
  /** How often a replica heartbeats, in milliseconds. Defaults to 10 seconds. */
  heartbeatMs?: number;
  /** How long a heartbeat counts as fresh, in milliseconds. Defaults to three heartbeats. */
  replicaTtlMs?: number;
  /**
   * How long a replica reuses a deployment it read when routing, in milliseconds, so starting a run
   * costs no read. A change made elsewhere reaches every replica within this time; one made through
   * this object applies here at once. Defaults to 2 seconds.
   */
  cacheMs?: number;
  /** History entries kept per deployment. Defaults to 50. */
  historyLimit?: number;
  /** Receives heartbeat failures, which never stop the server. */
  onError?: (error: unknown) => void;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** Options for `Deployments.assistant()`. */
export interface RevisionedAssistantOptions {
  /**
   * The revision that takes the traffic until a deployment is recorded. Defaults to the last one
   * declared. Once anything is recorded, the stored deployment decides, so a new revision in new code
   * takes no traffic until it is given some.
   */
  live?: string;
  /** What the assistant is, reported by the assistants endpoint. */
  description?: string;
}

/** What one revision's runs did, from `Deployments.stats()`. */
export interface RevisionStats {
  /** The revision. */
  revision: string;
  /** Runs recorded for it, finished or not. */
  runs: number;
  /** Runs that succeeded or are awaiting input. */
  succeeded: number;
  /** Runs that failed or expired. */
  failed: number;
  /** Runs that were cancelled, which count neither way. */
  cancelled: number;
  /** Failed runs as a share of the finished ones, or 0 before any finished. */
  errorRate: number;
  /** Median duration of finished runs, in milliseconds. */
  p50Ms?: number;
  /** 95th-percentile duration of finished runs, in milliseconds. */
  p95Ms?: number;
  /** Mean recorded cost of finished runs, in US dollars. */
  meanCost?: number;
}

/** Options for `Deployments.evaluate()`. */
export interface RunEvaluationOptions {
  /** What each run is scored by: evaluators from `nexus-ai-pro/evaluate`, such as an LLM judge. */
  evaluators: ReadonlyArray<Evaluator>;
  /** Only runs created from this time, such as the start of a canary. */
  since?: string;
  /** Only this revision's runs. Defaults to every revision's. */
  revision?: string;
  /** The share of runs scored, from 0 to 1, chosen by run id so every replica picks the same ones. Defaults to 1. */
  sampleRate?: number;
  /** How many recent runs are read. Defaults to 2,000. */
  limit?: number;
  /** Recorded as each score's source; a run already scored by this source is skipped. Defaults to `online-evaluation`. */
  source?: string;
}

/** What `Deployments.evaluate()` did. */
export interface RunEvaluationReport {
  /** Runs scored. */
  evaluated: number;
  /** Runs passed over because this source had already scored them. */
  skipped: number;
  /** Every score given. */
  scores: EvaluationScore[];
}

const DEPLOYMENTS = ['nexus', 'server', 'deployments'];
const REPLICAS = ['nexus', 'server', 'replicas'];
const EPSILON = 1e-9;

interface Registration {
  revisions: Record<string, ServerAssistant>;
  live: string;
}

/**
 * Revisions, traffic splits, and replica health for the agent server, recorded in a shared store.
 *
 * An assistant with revisions is served through `assistant()`, which the server routes every run
 * through: a run on a thread keeps the revision the thread started on while that revision takes
 * traffic, and a new thread or a stateless run is split by a stable hash of its id. Raising a
 * canary's share therefore only ever moves new threads onto it, and rolling it back moves its
 * threads home. Every run records the revision, its share, the reason it was chosen, and the
 * deployment version, so what served a request is always answerable.
 *
 * The same object, built on the same store without any assistants, is what a studio or a script uses
 * to read and change deployments. A change is a short history entry, never a redeploy: the code for
 * every revision ships in the image, and the split decides which one runs.
 */
export class Deployments implements ServerDeployments {
  private readonly state: ServerStateStore;
  private readonly now: () => Date;
  private readonly registrations = new Map<string, Registration>();
  private readonly cache = new Map<string, { record: DeploymentRecord; at: number }>();
  private heartbeat?: { timer: ReturnType<typeof setInterval>; id: string };

  constructor(private readonly options: DeploymentsOptions = {}) {
    this.state = options.state ?? new MemoryServerStore();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Serves an assistant through its revisions, by id: `{ '2026-09-01': v1, '2026-09-30': v2 }`.
   *
   * The result is an assistant like any other, so it goes straight into `createAgentServer()`'s
   * `assistants`. It can do what its live revision can: resume, report state, and roll back.
   */
  assistant(
    id: string,
    revisions: Record<string, ServerAssistant>,
    options: RevisionedAssistantOptions = {},
  ): ServerAssistant {
    const ids = Object.keys(revisions);
    if (ids.length === 0) throw new BadRequestError(`Assistant "${id}" needs at least one revision`, 'NO_REVISIONS');
    const live = options.live ?? (ids[ids.length - 1] as string);
    if (!revisions[live]) throw new BadRequestError(`Assistant "${id}" has no revision "${live}"`, 'UNKNOWN_REVISION');
    this.registrations.set(id, { revisions, live });

    const pick = (context?: AssistantRunContext): ServerAssistant =>
      (context?.revision !== undefined ? revisions[context.revision] : undefined) ??
      (revisions[live] as ServerAssistant);
    const fallback = revisions[live] as ServerAssistant;
    return {
      description: options.description ?? fallback.description,
      revisions: ids,
      stream: (input, context) => pick(context).stream(input, context),
      ...(fallback.resume
        ? {
            resume: (threadId: string, value: unknown, context: AssistantRunContext) => {
              const target = pick(context);
              if (!target.resume) throw new AssistantCapabilityError(id, 'resuming an interrupt');
              return target.resume(threadId, value, context);
            },
          }
        : {}),
      ...(fallback.state ? { state: (threadId: string) => fallback.state?.(threadId) } : {}),
      ...(fallback.restore ? { restore: (threadId: string, step: number) => fallback.restore?.(threadId, step) } : {}),
      ...(fallback.step ? { step: (threadId: string) => fallback.step?.(threadId) } : {}),
      route: (request) => this.route(id, request),
      revision: (revision) => revisions[revision],
    };
  }

  /** Chooses the revision for a run. The server calls it through the assistant; tests may call it directly. */
  async route(assistant: string, request: RevisionRequest): Promise<RevisionChoice | undefined> {
    const registration = this.registrations.get(assistant);
    if (!registration) return undefined;
    const deployment = await this.current(assistant);

    if (request.requested !== undefined) {
      const chosen = registration.revisions[request.requested];
      if (!chosen) {
        throw new BadRequestError(
          `Assistant "${assistant}" has no revision "${request.requested}"`,
          'UNKNOWN_REVISION',
        );
      }
      return choice(request.requested, chosen, deployment, 'requested');
    }

    // Only revisions this replica can run take traffic here, so a revision named in the store but
    // missing from this image never gets a run it cannot serve.
    const traffic = servable(deployment.traffic, registration);
    const threadRevision = request.threadRevision;
    if (threadRevision !== undefined && (traffic[threadRevision] ?? 0) > 0) {
      return choice(threadRevision, registration.revisions[threadRevision] as ServerAssistant, deployment, 'thread');
    }
    const revision = pickRevision(
      traffic,
      deployment.live,
      bucket(`${assistant}:${request.threadId ?? request.runId}`),
    );
    return choice(revision, registration.revisions[revision] as ServerAssistant, deployment, 'split');
  }

  /** Every deployment: those recorded, and the default of every assistant registered here that has none. */
  async list(): Promise<DeploymentRecord[]> {
    const stored = await this.state.list<DeploymentRecord>(DEPLOYMENTS, { limit: 500 });
    const seen = new Set(stored.map((record) => record.assistant));
    const defaults = [...this.registrations.keys()].filter((id) => !seen.has(id)).map((id) => this.initial(id));
    return [...stored, ...(defaults.filter(Boolean) as DeploymentRecord[])].sort((a, b) =>
      a.assistant.localeCompare(b.assistant),
    );
  }

  /** One assistant's deployment, as recorded, or its default when this process registered it. */
  async get(assistant: string): Promise<DeploymentRecord | undefined> {
    return (await this.state.get<DeploymentRecord>(DEPLOYMENTS, assistant)) ?? this.initial(assistant);
  }

  /** A deployment's changes, newest first. */
  async history(assistant: string): Promise<DeploymentChangeRecord[]> {
    return (await this.get(assistant))?.history ?? [];
  }

  /**
   * Applies a change, records it in the history, and returns the deployment after it.
   *
   * - `split` sets each revision's share. Shares must add up to at most 1, and the live revision
   *   takes whatever is left.
   * - `canary` gives one revision a share, from 0 to 1, and the live revision the rest.
   * - `promote` makes a revision live, with all the traffic.
   * - `rollback` sends all traffic back to the live revision when a canary has any; otherwise it
   *   makes the previous live revision live again. `to` names the revision instead.
   *
   * `expectedVersion` applies a change only to the version it was decided on, and throws
   * `DEPLOYMENT_CONFLICT` otherwise, so two people — or a person and a canary guard — cannot undo each
   * other without noticing.
   */
  async change(
    assistant: string,
    change: DeploymentChange & { expectedVersion?: number },
    by?: string,
  ): Promise<DeploymentRecord> {
    const current = await this.get(assistant);
    if (!current) {
      throw new BadRequestError(
        `Assistant "${assistant}" has no deployment yet: serve it through Deployments.assistant() first`,
        'UNKNOWN_DEPLOYMENT',
      );
    }
    if (change.expectedVersion !== undefined && change.expectedVersion !== current.version) {
      throw new ServerError(
        `Deployment "${assistant}" is at version ${current.version}, not ${change.expectedVersion}`,
        'DEPLOYMENT_CONFLICT',
        409,
      );
    }
    const known = await this.knownRevisions(assistant);
    const check = (revision: string): void => {
      if (known.size > 0 && !known.has(revision)) {
        throw new BadRequestError(`Assistant "${assistant}" has no revision "${revision}"`, 'UNKNOWN_REVISION');
      }
    };

    let live = current.live;
    let traffic: Record<string, number>;
    switch (change.action) {
      case 'split':
        for (const revision of Object.keys(change.traffic)) check(revision);
        traffic = normalize(change.traffic, live);
        break;
      case 'canary':
        check(change.revision);
        if (!(change.weight >= 0 && change.weight <= 1)) throw new BadRequestError('A canary weight is from 0 to 1');
        traffic = normalize({ [change.revision]: change.weight }, live);
        break;
      case 'promote':
        check(change.revision);
        live = change.revision;
        traffic = { [live]: 1 };
        break;
      case 'rollback': {
        if (change.to !== undefined) {
          check(change.to);
          live = change.to;
        } else if (!hasCanary(current)) {
          // No canary to pull: undo the last promotion.
          const previous = current.history.find((entry) => entry.live !== current.live)?.live;
          if (!previous)
            throw new BadRequestError(`Deployment "${assistant}" has nothing to roll back to`, 'NO_ROLLBACK');
          live = previous;
        }
        traffic = { [live]: 1 };
        break;
      }
      default:
        throw new BadRequestError('A change needs an action: split, canary, promote, or rollback');
    }

    const at = this.now().toISOString();
    const next: DeploymentRecord = {
      assistant,
      version: current.version + 1,
      live,
      traffic,
      updatedAt: at,
      ...(by ? { updatedBy: by } : {}),
      history: [
        {
          version: current.version + 1,
          at,
          action: change.action,
          live,
          traffic,
          ...(by ? { by } : {}),
          ...(change.reason ? { reason: change.reason } : {}),
        },
        ...current.history,
      ].slice(0, this.options.historyLimit ?? 50),
    };
    const canaries = canaryRevisions(next);
    if (canaries.length > 0) {
      // A canary keeps its start while only its share changes, so a guard judges it on every run it
      // served; a different canary starts the clock again.
      const same = canaryRevisions(current).join() === canaries.join();
      next.canarySince = same && current.canarySince ? current.canarySince : at;
    }
    await this.state.put(DEPLOYMENTS, assistant, next);
    this.cache.set(assistant, { record: next, at: Date.now() });
    return next;
  }

  /** Sets each revision's share of new runs. */
  split(assistant: string, traffic: Record<string, number>, options: { by?: string; reason?: string } = {}) {
    return this.change(assistant, { action: 'split', traffic, reason: options.reason }, options.by);
  }

  /** Gives one revision a share of new runs, from 0 to 1, and the live revision the rest. */
  canary(assistant: string, revision: string, weight: number, options: { by?: string; reason?: string } = {}) {
    return this.change(assistant, { action: 'canary', revision, weight, reason: options.reason }, options.by);
  }

  /** Makes a revision live, with all the traffic. */
  promote(assistant: string, revision: string, options: { by?: string; reason?: string } = {}) {
    return this.change(assistant, { action: 'promote', revision, reason: options.reason }, options.by);
  }

  /** Pulls a canary, or undoes the last promotion when there is none; `to` names the revision instead. */
  rollback(assistant: string, options: { to?: string; by?: string; reason?: string } = {}) {
    return this.change(assistant, { action: 'rollback', to: options.to, reason: options.reason }, options.by);
  }

  /** Replicas whose heartbeat is fresh, newest first. */
  async replicas(): Promise<ReplicaReport[]> {
    const ttl = this.options.replicaTtlMs ?? 3 * (this.options.heartbeatMs ?? 10_000);
    const cutoff = this.now().getTime() - ttl;
    const reports = await this.state.list<ReplicaReport>(REPLICAS, { limit: 1_000 });
    return reports
      .filter((report) => Date.parse(report.heartbeatAt) >= cutoff)
      .sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt));
  }

  /**
   * Starts heartbeating a replica's report, and records the default deployment of every assistant
   * registered here that has none yet, so a studio or script can change it before anything else has.
   * The server calls it from `start()`.
   */
  async attach(report: () => ReplicaReport): Promise<void> {
    for (const assistant of this.registrations.keys()) {
      const initial = this.initial(assistant);
      if (initial && !(await this.state.get<DeploymentRecord>(DEPLOYMENTS, assistant))) {
        await this.state.put(DEPLOYMENTS, assistant, initial);
      }
    }
    if (this.heartbeat) clearInterval(this.heartbeat.timer);
    const beat = async (): Promise<void> => {
      const current = report();
      if (this.heartbeat) this.heartbeat.id = current.id;
      try {
        await this.state.put(REPLICAS, current.id, current);
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    const timer = setInterval(() => void beat(), this.options.heartbeatMs ?? 10_000);
    // A heartbeat reports on the process; it must never be what keeps it running.
    timer.unref?.();
    this.heartbeat = { timer, id: report().id };
    await beat();
  }

  /** Stops heartbeating and removes this replica's report. The server calls it from `stop()`. */
  async detach(): Promise<void> {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat.timer);
    const id = this.heartbeat.id;
    this.heartbeat = undefined;
    await this.state.delete(REPLICAS, id);
  }

  /** The revisions this process registered, and those fresh replicas report, for an assistant. */
  async revisions(assistant: string): Promise<string[]> {
    return [...(await this.knownRevisions(assistant))];
  }

  /**
   * What each revision's runs did, from the server's run records in the same store: counts, error
   * rate, latency percentiles, and mean cost. `since` limits it to runs created from that time, such
   * as the start of a canary; `limit` bounds how many recent runs are read, 2,000 by default.
   */
  async stats(assistant: string, options: { since?: string; limit?: number } = {}): Promise<RevisionStats[]> {
    const byRevision = new Map<string, RunRecord[]>();
    for (const run of await this.runs(assistant, options)) {
      const revision = run.revision?.id ?? '';
      byRevision.set(revision, [...(byRevision.get(revision) ?? []), run]);
    }
    return [...byRevision].map(([revision, runs]) => summarize(revision, runs));
  }

  /**
   * One revision's finished runs since a time, as samples `compareRuns()` reads: a failed or
   * expired run is an error, a cancelled one is left out.
   */
  async samples(assistant: string, revision: string, since?: string, limit?: number): Promise<RunSample[]> {
    return (await this.runs(assistant, { since, limit }))
      .filter((run) => (run.revision?.id ?? '') === revision)
      .flatMap((run) => {
        // Feedback travels with each run, so a guard can judge quality alongside errors and speed.
        const feedback = run.feedback?.length ? { feedback: run.feedback } : {};
        if (run.status === 'failed' || run.status === 'expired') {
          return [{ status: 'error', latencyMs: run.durationMs, cost: run.cost, ...feedback }];
        }
        if (run.status === 'succeeded' || run.status === 'awaiting_input') {
          return [{ status: 'success', latencyMs: run.durationMs, cost: run.cost, ...feedback }];
        }
        return [];
      });
  }

  /**
   * Online evaluation of the server's own runs: scores each finished run's output with evaluators
   * from `nexus-ai-pro/evaluate`, and records the scores as the run's feedback. A canary guard given
   * those keys in `feedback` then compares quality between revisions, beside errors, latency, and
   * cost.
   *
   * A run is scored once per `source`, so calling this on a schedule never counts a run twice.
   * Sampling is stable: the same run is always in or out of a sample, on every replica. Evaluators
   * judge a run by its output, since a run record does not keep its input.
   */
  async evaluate(assistant: string, options: RunEvaluationOptions): Promise<RunEvaluationReport> {
    const source = options.source ?? 'online-evaluation';
    const rate = options.sampleRate ?? 1;
    const report: RunEvaluationReport = { evaluated: 0, skipped: 0, scores: [] };
    for (const run of await this.runs(assistant, options)) {
      if (run.status !== 'succeeded') continue;
      if (options.revision !== undefined && (run.revision?.id ?? '') !== options.revision) continue;
      if (rate < 1 && bucket(`evaluate:${run.id}`) >= rate) continue;
      if (run.feedback?.some((item) => item.source === source)) {
        report.skipped += 1;
        continue;
      }
      const scores: EvaluationScore[] = [];
      for (const evaluator of options.evaluators) {
        const value = await evaluator({
          example: { id: run.id, inputs: undefined, ...(run.metadata ? { metadata: run.metadata } : {}) },
          output: run.output,
          latencyMs: run.durationMs ?? 0,
          ...(run.cost === undefined ? {} : { cost: run.cost }),
          run: 0,
        });
        if (typeof value === 'number') scores.push({ key: 'score', score: value });
        else if (typeof value === 'boolean') scores.push({ key: 'score', score: value ? 1 : 0, passed: value });
        else scores.push(...(Array.isArray(value) ? value : [value]));
      }
      const at = new Date().toISOString();
      // Read again just before writing, so feedback a person left meanwhile is kept.
      const latest = (await this.state.get<RunRecord>(RUNS_NAMESPACE, run.id)) ?? run;
      await this.state.put(RUNS_NAMESPACE, run.id, {
        ...latest,
        feedback: [
          ...(latest.feedback ?? []),
          ...scores.map((score) => ({
            key: score.key,
            score: score.score,
            ...(score.comment ? { comment: score.comment } : {}),
            source,
            createdAt: at,
          })),
        ].slice(-100),
      });
      report.evaluated += 1;
      report.scores.push(...scores);
    }
    return report;
  }

  /** The deployment the router uses, reusing a recent read. */
  private async current(assistant: string): Promise<DeploymentRecord> {
    const cached = this.cache.get(assistant);
    if (cached && Date.now() - cached.at < (this.options.cacheMs ?? 2_000)) return cached.record;
    const record = (await this.state.get<DeploymentRecord>(DEPLOYMENTS, assistant)) ?? this.initial(assistant);
    if (!record) throw new BadRequestError(`Assistant "${assistant}" has no deployment`, 'UNKNOWN_DEPLOYMENT');
    this.cache.set(assistant, { record, at: Date.now() });
    return record;
  }

  /** The deployment of a registered assistant before anything is recorded: its live revision, all traffic. */
  private initial(assistant: string): DeploymentRecord | undefined {
    const registration = this.registrations.get(assistant);
    if (!registration) return undefined;
    return {
      assistant,
      version: 0,
      live: registration.live,
      traffic: { [registration.live]: 1 },
      updatedAt: new Date(0).toISOString(),
      history: [],
    };
  }

  private async knownRevisions(assistant: string): Promise<Set<string>> {
    const known = new Set(Object.keys(this.registrations.get(assistant)?.revisions ?? {}));
    for (const replica of await this.replicas()) {
      for (const revision of replica.assistants[assistant] ?? []) known.add(revision);
    }
    return known;
  }

  private async runs(assistant: string, options: { since?: string; limit?: number }): Promise<RunRecord[]> {
    const runs = await this.state.list<RunRecord>(RUNS_NAMESPACE, { limit: options.limit ?? 2_000 });
    return runs.filter((run) => run.assistant === assistant && (!options.since || run.createdAt >= options.since));
  }
}

/** Options for `watchCanaries()`. */
export interface CanaryGuardOptions {
  /** The deployments to watch, and where their runs are read. */
  deployments: Deployments;
  /** Only these assistants. Defaults to every deployment with a canary. */
  assistants?: readonly string[];
  /** How often to judge, in milliseconds. Defaults to a minute. `check()` also judges on demand. */
  everyMs?: number;
  /** Finished runs each side needs before a canary is judged. Defaults to 20. */
  minRuns?: number;
  /** What is compared. Defaults to the error rate and p95 latency. */
  metrics?: readonly RegressionMetric[];
  /** A rise in p95 latency, relative, that counts. Defaults to 0.25. */
  latencyIncrease?: number;
  /**
   * The smallest rise in p95 latency, in milliseconds, that counts. Defaults to 50, so a few
   * milliseconds of noise on fast runs never rolls a canary back.
   */
  minLatencyChangeMs?: number;
  /** A rise in mean cost, relative, that counts. Defaults to 0.25. */
  costIncrease?: number;
  /**
   * The shares a canary moves through while it holds up, such as `[0.25, 0.5]`, before it is
   * promoted. Without steps, a canary that holds up stays where it is until a person promotes it.
   */
  steps?: readonly number[];
  /**
   * Where a revision's runs come from. Defaults to the server's run records. Give it runs from a
   * trace store to judge on feedback scores too, with `feedback` naming the keys.
   */
  samples?: (request: { assistant: string; revision: string; since: string }) => Promise<RunSample[]>;
  /**
   * Feedback keys whose mean score is compared: the scores `Deployments.evaluate()` records from
   * online evaluation, or any a person left through the feedback route. A canary that is worse on one
   * is rolled back like one that fails more.
   */
  feedback?: readonly string[];
  /**
   * Judges each metric as an evaluation comparison does, at this confidence, such as 0.95. A bootstrap
   * interval must not reach zero, and the change must be at least the metric's minimum effect:
   * `minErrorRateIncrease`, `latencyIncrease` with `minLatencyChangeMs`, `costIncrease`, and
   * `minFeedbackDrop`. A real regression rolls back, and noise or a trivial change does not. Without
   * it, the error rate uses a z-test at 95%, and latency and cost use their margins alone.
   */
  confidence?: number;
  /** The smallest rise in the error rate, absolute, that counts under `confidence`. Defaults to 0.02. */
  minErrorRateIncrease?: number;
  /** The smallest fall in a feedback score's mean, absolute, that counts under `confidence`. Defaults to 0.05. */
  minFeedbackDrop?: number;
  /** Bootstrap resamples under `confidence`. Defaults to 1,000. */
  resamples?: number;
  /** Recorded as who made a change. Defaults to `guard`. */
  by?: string;
  /** Hears every decision, including holds. */
  onDecision?: (decision: CanaryDecision) => void;
  /** Receives failures, which never stop the guard. */
  onError?: (error: unknown) => void;
}

/** What the guard decided about one canary. */
export interface CanaryDecision {
  /** The assistant. */
  assistant: string;
  /** The canary revision. */
  canary: string;
  /** The live revision it was compared with. */
  live: string;
  /**
   * `rollback` when it regressed, `advance` to the next step, `promote` after the last, and `hold`
   * while either side lacks the runs to judge, or while it holds up without steps.
   */
  action: 'rollback' | 'advance' | 'promote' | 'hold';
  /** What got worse, when it rolled back. */
  regressions: Regression[];
  /** Runs judged on each side. */
  samples: { live: number; canary: number };
  /** The canary's share after the decision. */
  weight: number;
}

/** A running canary guard. */
export interface CanaryGuard {
  /** Judges every watched canary now, and acts on what it finds. */
  check(): Promise<CanaryDecision[]>;
  /** Stops the periodic checks. */
  stop(): void;
}

/**
 * Watches canaries and acts on what their runs show, using the same statistics as the insights'
 * regression detection.
 *
 * Every check compares each canary with the live revision over the same window — the runs since the
 * split last changed — so both sides saw the same traffic and time of day. A canary whose error rate,
 * latency, or cost regressed is rolled back at once, with the regression as the reason in the
 * deployment's history. One that holds up moves to its next step, and is promoted after the last.
 *
 * Changes are made against the version that was judged, so a guard on every replica is safe: the
 * first to act wins, and the rest find the deployment already moved.
 */
export function watchCanaries(options: CanaryGuardOptions): CanaryGuard {
  const deployments = options.deployments;
  const minRuns = options.minRuns ?? 20;
  const by = options.by ?? 'guard';
  const samples =
    options.samples ??
    ((request: { assistant: string; revision: string; since: string }) =>
      deployments.samples(request.assistant, request.revision, request.since));

  async function judge(deployment: DeploymentRecord, canary: string): Promise<CanaryDecision> {
    const since = deployment.history[0]?.at ?? deployment.canarySince ?? deployment.updatedAt;
    const [liveRuns, canaryRuns] = await Promise.all([
      samples({ assistant: deployment.assistant, revision: deployment.live, since }),
      samples({ assistant: deployment.assistant, revision: canary, since }),
    ]);
    const weight = deployment.traffic[canary] ?? 0;
    const decision: CanaryDecision = {
      assistant: deployment.assistant,
      canary,
      live: deployment.live,
      action: 'hold',
      regressions: [],
      samples: { live: liveRuns.length, canary: canaryRuns.length },
      weight,
    };
    if (liveRuns.length < minRuns || canaryRuns.length < minRuns) return decision;

    const regressions = compareRuns(liveRuns, canaryRuns, {
      group: `${deployment.assistant}@${canary}`,
      metrics: options.metrics ?? ['error-rate', 'latency'],
      feedback: options.feedback,
      minRuns,
      latencyIncrease: options.latencyIncrease,
      minLatencyChangeMs: options.minLatencyChangeMs ?? 50,
      costIncrease: options.costIncrease,
      ...(options.confidence === undefined
        ? {}
        : {
            confidence: options.confidence,
            minErrorRateIncrease: options.minErrorRateIncrease,
            minFeedbackDrop: options.minFeedbackDrop,
            resamples: options.resamples,
          }),
    });
    if (regressions.length > 0) {
      await deployments.change(
        deployment.assistant,
        {
          action: 'rollback',
          reason: `canary ${canary} rolled back: ${regressions.map((item) => item.summary).join('; ')}`,
          expectedVersion: deployment.version,
        },
        by,
      );
      return { ...decision, action: 'rollback', regressions, weight: 0 };
    }

    const next = (options.steps ?? []).find((step) => step > weight + EPSILON);
    if (next !== undefined && next < 1 - EPSILON) {
      await deployments.change(
        deployment.assistant,
        {
          action: 'canary',
          revision: canary,
          weight: next,
          reason: `canary ${canary} held up at ${percent(weight)} over ${canaryRuns.length} runs`,
          expectedVersion: deployment.version,
        },
        by,
      );
      return { ...decision, action: 'advance', weight: next };
    }
    if (options.steps && options.steps.length > 0) {
      await deployments.change(
        deployment.assistant,
        {
          action: 'promote',
          revision: canary,
          reason: `canary ${canary} held up through every step`,
          expectedVersion: deployment.version,
        },
        by,
      );
      return { ...decision, action: 'promote', weight: 1 };
    }
    return decision;
  }

  async function check(): Promise<CanaryDecision[]> {
    const decisions: CanaryDecision[] = [];
    for (const deployment of await deployments.list()) {
      if (options.assistants && !options.assistants.includes(deployment.assistant)) continue;
      for (const canary of canaryRevisions(deployment)) {
        try {
          const decision = await judge(deployment, canary);
          decisions.push(decision);
          options.onDecision?.(decision);
        } catch (error) {
          // Another guard moved the deployment first; the next check sees where it stands.
          if (!(error instanceof ServerError && error.code === 'DEPLOYMENT_CONFLICT')) options.onError?.(error);
        }
        // One change per deployment per check: anything after it was decided on the old version.
        if (decisions.at(-1)?.action !== 'hold') break;
      }
    }
    return decisions;
  }

  const timer = setInterval(() => {
    void check().catch((error: unknown) => options.onError?.(error));
  }, options.everyMs ?? 60_000);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}

/** A stable position in [0, 1) for a key: FNV-1a, so the same thread always lands in the same place. */
export function bucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * The revision a bucket falls in. Canaries take the start of the range, in a stable order, and the
 * live revision the rest, so raising a canary's share only adds buckets to it.
 */
function pickRevision(traffic: Record<string, number>, live: string, position: number): string {
  let edge = 0;
  for (const revision of Object.keys(traffic)
    .filter((id) => id !== live)
    .sort()) {
    edge += traffic[revision] ?? 0;
    if (position < edge) return revision;
  }
  return (traffic[live] ?? 0) > 0 ? live : (Object.keys(traffic)[0] ?? live);
}

/** The split restricted to revisions this replica has, renormalized; all to live when none remain. */
function servable(traffic: Record<string, number>, registration: Registration): Record<string, number> {
  const kept = Object.entries(traffic).filter(([revision, weight]) => weight > 0 && registration.revisions[revision]);
  const total = kept.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return { [registration.live]: 1 };
  return Object.fromEntries(kept.map(([revision, weight]) => [revision, weight / total]));
}

function normalize(traffic: Record<string, number>, live: string): Record<string, number> {
  const entries = Object.entries(traffic);
  for (const [revision, weight] of entries) {
    if (!Number.isFinite(weight) || weight < 0)
      throw new BadRequestError(`The share for "${revision}" must be from 0 to 1`);
  }
  const others = entries.filter(([revision]) => revision !== live);
  const taken = others.reduce((sum, [, weight]) => sum + weight, 0);
  if (taken > 1 + EPSILON) throw new BadRequestError('Traffic shares add up to more than 1');
  const result: Record<string, number> = {};
  for (const [revision, weight] of others) if (weight > 0) result[revision] = round(weight);
  const rest = round(Math.max(0, 1 - taken));
  if (rest > 0) result[live] = rest;
  return result;
}

function canaryRevisions(deployment: DeploymentRecord): string[] {
  return Object.entries(deployment.traffic)
    .filter(([revision, weight]) => revision !== deployment.live && weight > 0)
    .map(([revision]) => revision)
    .sort();
}

function hasCanary(deployment: DeploymentRecord): boolean {
  return canaryRevisions(deployment).length > 0;
}

function choice(
  id: string,
  assistant: ServerAssistant,
  deployment: DeploymentRecord,
  reason: RevisionChoice['reason'],
): RevisionChoice {
  return { id, assistant, weight: deployment.traffic[id] ?? 0, deployment: deployment.version, reason };
}

function summarize(revision: string, runs: readonly RunRecord[]): RevisionStats {
  const succeeded = runs.filter((run) => run.status === 'succeeded' || run.status === 'awaiting_input');
  const failed = runs.filter((run) => run.status === 'failed' || run.status === 'expired');
  const finished = [...succeeded, ...failed];
  const durations = finished.map((run) => run.durationMs).filter((value): value is number => value !== undefined);
  const costs = finished.map((run) => run.cost).filter((value): value is number => value !== undefined);
  return {
    revision,
    runs: runs.length,
    succeeded: succeeded.length,
    failed: failed.length,
    cancelled: runs.filter((run) => run.status === 'cancelled').length,
    errorRate: finished.length === 0 ? 0 : failed.length / finished.length,
    ...(durations.length ? { p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) } : {}),
    ...(costs.length ? { meanCost: costs.reduce((sum, value) => sum + value, 0) / costs.length } : {}),
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
