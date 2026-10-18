/**
 * Automation rules: when a score falls below a threshold over enough samples, act. Open review items
 * for people, send a webhook, or mark a deployment's revision unhealthy, which rolls a canary back.
 *
 * Rules read scores from a shared source, such as a deployment's run records, so every replica judges
 * the same scores, and a firing is claimed in a shared store, so it acts once however many replicas
 * see it.
 */
import type { OnlineScored } from './online.js';
import type { Store } from '../types/store.js';
import type { Run, RunQuery, TraceStore } from '../types/tracing.js';

/** One score, as automation rules judge them. */
export interface ScoreSample {
  /** The score's key. */
  key: string;
  /** The score. */
  score: number;
  /** Whether it passed, when its evaluator judged. */
  passed?: boolean;
  /** The run it was given to. */
  runId: string;
  /** ISO-8601 time it was given. */
  at: string;
  /** Who gave it. */
  source?: string;
  /** The assistant that ran. */
  assistant?: string;
  /** The revision that served the run. */
  revision?: string;
  /** The run's tenant. */
  tenantId?: string;
  /** What the run received, for a person reviewing it. */
  inputs?: unknown;
  /** What the run produced. */
  output?: unknown;
}

/** Where rules read scores: any replica reading the same source judges the same scores. */
export interface ScoreSource {
  /** The most recent scores of one key, newest first, at most `limit`, and none older than `since`. */
  samples(query: { key: string; since?: string; limit: number }): Promise<ScoreSample[]> | ScoreSample[];
}

/** The scores of one assistant's runs, from its deployment's run records: shared by every replica. */
export function deploymentScores(
  deployments: {
    scores(
      assistant: string,
      options: { key?: string; since?: string; limit?: number },
    ): Promise<Array<Omit<ScoreSample, 'passed' | 'inputs'>>>;
  },
  assistant: string,
): ScoreSource {
  return {
    samples: async ({ key, since, limit }) =>
      (await deployments.scores(assistant, { key, ...(since ? { since } : {}), limit: Math.max(limit, 2_000) }))
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, limit),
  };
}

/**
 * The scores recorded on a trace store's runs, as an online evaluation writes them: shared by every
 * replica that reads the store. `query` narrows the runs, such as `{ kind: 'image' }`.
 */
export function traceScores(traces: TraceStore, query: RunQuery = {}): ScoreSource {
  return {
    async samples({ key, since, limit }) {
      const runs = await traces.query({ ...query, feedbackKey: key, ...(since ? { since } : {}), limit });
      const samples: ScoreSample[] = [];
      for (const run of runs) {
        for (const feedback of run.feedback ?? []) {
          if (feedback.key !== key || feedback.score === undefined) continue;
          samples.push({
            ...fromRun(run),
            key,
            score: feedback.score,
            at: feedback.createdAt,
            ...(feedback.source ? { source: feedback.source } : {}),
          });
        }
      }
      return samples.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
    },
  };
}

/** Scores held in this process, fed by `observe()` or `record()`: for one process, or a test. */
export interface MemoryScoreSource extends ScoreSource {
  /** Keeps one score. */
  record(sample: ScoreSample): void;
  /** Keeps a run's scores as an online evaluation's `onScored` hears them. */
  observe(scored: OnlineScored): void;
}

/** A score source in this process, keeping the latest `max` scores (10,000). */
export function memoryScores(options: { max?: number } = {}): MemoryScoreSource {
  const max = options.max ?? 10_000;
  const kept: ScoreSample[] = [];
  const source: MemoryScoreSource = {
    record(sample) {
      kept.push(sample);
      if (kept.length > max) kept.splice(0, kept.length - max);
    },
    observe(scored) {
      const at = new Date().toISOString();
      for (const score of scored.scores) {
        source.record({
          ...fromRun(scored.run),
          key: score.key,
          score: score.score,
          ...(score.passed === undefined ? {} : { passed: score.passed }),
          source: scored.source,
          at,
        });
      }
    },
    samples({ key, since, limit }) {
      const found: ScoreSample[] = [];
      for (let index = kept.length - 1; index >= 0 && found.length < limit; index -= 1) {
        const sample = kept[index] as ScoreSample;
        if (sample.key !== key) continue;
        if (since && sample.at < since) break;
        found.push(sample);
      }
      return found;
    },
  };
  return source;
}

/** What a rule judges a scope's samples by. */
export type RuleStatistic = 'mean' | 'pass-rate';

/** A rule: when `key` falls below `below` over enough samples, act. */
export interface AutomationRule {
  /** Names the rule in events, in the shared state, and as `rule:<name>` in a deployment's history. */
  name: string;
  /** The score key judged, such as `banner` from a media judge. */
  key: string;
  /** Fires when the statistic is below this. */
  below: number;
  /** The mean score, the default, or the share that passed: `passed`, or a score of at least 0.5. */
  statistic?: RuleStatistic;
  /** Samples a scope needs before it is judged, each run counted once. Defaults to 20. */
  minSamples?: number;
  /** The most recent runs judged per scope. Defaults to 100. */
  window?: number;
  /** Only samples this recent, in milliseconds. */
  windowMs?: number;
  /**
   * Judges by an interval instead of the bare statistic: fires only when its upper bound at this
   * confidence, such as 0.95, is below the threshold, so a few unlucky samples never fire it.
   */
  confidence?: number;
  /** Only scores from this source. */
  source?: string;
  /** Narrows the samples further. */
  where?: (sample: ScoreSample) => boolean;
  /**
   * What is judged on its own: each revision of each assistant, the default, so a canary is judged
   * apart from the live revision; each assistant; everything as one; or a scope of your own.
   */
  by?: 'revision' | 'assistant' | 'all' | ((sample: ScoreSample) => string);
  /** What it does when it fires, in order. */
  actions: AutomationAction[];
  /**
   * Fires again after this long while a scope stays below, in milliseconds. Defaults to never: once
   * per fall, again only after it recovers, which takes `minSamples` runs back at the threshold or
   * above.
   */
  repeatAfterMs?: number;
}

/** A rule that fired, or recovered, for one scope. */
export interface AutomationEvent {
  /** `fired` when it fell below, `recovered` when it came back. */
  type: 'fired' | 'recovered';
  /** The rule. */
  rule: string;
  /** The scope, such as `designer@v2`. */
  scope: string;
  /** The score key. */
  key: string;
  /** How it was judged. */
  statistic: RuleStatistic;
  /** The statistic's value. */
  value: number;
  /** The interval at the rule's confidence, when it has one. */
  interval?: [number, number];
  /** The threshold. */
  below: number;
  /** Runs judged. */
  samples: number;
  /** The assistant, when the scope has one. */
  assistant?: string;
  /** The revision, when the scope has one. */
  revision?: string;
  /** The lowest samples, at most five, so an event points at runs to read. */
  worst: ScoreSample[];
  /** ISO-8601 time it was judged. */
  at: string;
  /** A sentence saying what happened. */
  summary: string;
}

/** What a rule does when it fires. A failure goes to `onError`, and the rule's other actions still run. */
export type AutomationAction = (event: AutomationEvent) => Promise<void> | void;

/** Where a rule judged a scope, from `AutomationRules.status()`. */
export interface AutomationStatus {
  /** The rule. */
  rule: string;
  /** The scope. */
  scope: string;
  /** The statistic's value. */
  value: number;
  /** Runs judged. */
  samples: number;
  /** Whether it is below with enough samples. */
  breached: boolean;
  /** ISO-8601 time it last fired for this scope, while it stays below. */
  firingSince?: string;
}

/** Options for `automationRules()`. */
export interface AutomationRulesOptions {
  /** The rules. */
  rules: AutomationRule[];
  /** Where scores are read. Defaults to `memoryScores()`, fed by `observe()`. */
  scores?: ScoreSource;
  /**
   * Where firings are claimed, shared by every replica, so a rule acts once for a fall however many
   * replicas judge it: a long-term store with `putIfVersion()`. Defaults to memory, for one process.
   */
  state?: Store;
  /** The namespace firings are kept under. Defaults to `['nexus', 'automation']`. */
  namespace?: readonly string[];
  /** Most recent samples read per rule, across its scopes. Defaults to 5,000. */
  scanLimit?: number;
  /** Hears every event. */
  onEvent?: (event: AutomationEvent) => void;
  /** Hears failures of actions and reads, which never stop the rules. */
  onError?: (error: unknown, event?: AutomationEvent) => void;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** Running automation rules. */
export interface AutomationRules {
  /** Judges every rule now, acting on what fell, and resolves to the events. */
  check(): Promise<AutomationEvent[]>;
  /**
   * Hears a run's scores, as an online evaluation's `onScored`: kept by a memory source, and judged
   * at once by the rules on their keys.
   */
  observe(scored: OnlineScored): Promise<void>;
  /** Where each rule stands for each scope. */
  status(): Promise<AutomationStatus[]>;
  /** Judges every `everyMs` (one minute) until `stop()`. */
  start(options?: { everyMs?: number }): void;
  /** Stops `start()`. */
  stop(): void;
}

interface Firing {
  version: number;
  since?: string;
  firedAt?: string;
}

/**
 * Automation rules over scores: each rule judges the most recent runs of each scope (each revision by
 * default) and acts when the statistic falls below its threshold over at least `minSamples` runs.
 * A firing is claimed in `state` before it acts, so it acts once for a fall across every replica,
 * and again only after the scope recovers, or after `repeatAfterMs`.
 *
 * ```ts
 * const rules = automationRules({
 *   scores: deploymentScores(deployments, 'designer'),
 *   state: store,
 *   rules: [{ name: 'banner quality', key: 'banner', below: 0.6, minSamples: 20,
 *             actions: [markUnhealthy({ deployments }), openReview(queue), sendWebhook({ url })] }],
 * });
 * const worker = deployments.evaluationWorker('designer', { evaluators, operations, onScored: rules.observe });
 * ```
 */
export function automationRules(options: AutomationRulesOptions): AutomationRules {
  const now = options.now ?? (() => new Date());
  const source = options.scores ?? memoryScores();
  const namespace = [...(options.namespace ?? ['nexus', 'automation'])];
  const local = new Map<string, Firing>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<AutomationEvent[]> | undefined;

  const readFiring = async (id: string): Promise<Firing | undefined> => {
    if (!options.state) return local.get(id);
    return (await options.state.get<Firing>(namespace, id))?.value;
  };
  /** Writes a firing only over the one read, so of two replicas deciding at once, one acts. */
  const claim = async (id: string, current: Firing | undefined, next: Omit<Firing, 'version'>): Promise<boolean> => {
    const value: Firing = { ...next, version: (current?.version ?? 0) + 1 };
    if (!options.state) {
      if (local.get(id)?.version !== current?.version) return false;
      local.set(id, value);
      return true;
    }
    if (options.state.putIfVersion) {
      return options.state.putIfVersion(namespace, id, value, current ? current.version : null);
    }
    await options.state.put(namespace, id, value, { index: false });
    return true;
  };

  const scopeOf = (rule: AutomationRule, sample: ScoreSample): string => {
    const by = rule.by ?? 'revision';
    if (typeof by === 'function') return by(sample);
    if (by === 'all') return 'all';
    if (by === 'assistant') return sample.assistant ?? 'all';
    return sample.assistant === undefined && sample.revision === undefined
      ? 'all'
      : `${sample.assistant ?? ''}@${sample.revision ?? ''}`;
  };

  const judge = async (rule: AutomationRule) => {
    const since = rule.windowMs === undefined ? undefined : new Date(now().getTime() - rule.windowMs).toISOString();
    const samples = await source.samples({
      key: rule.key,
      ...(since ? { since } : {}),
      limit: options.scanLimit ?? 5_000,
    });
    const window = rule.window ?? 100;
    // Each run counts once, as the mean of its scores; the newest `window` runs of each scope.
    const scopes = new Map<string, Map<string, ScoreSample[]>>();
    for (const sample of samples) {
      if (sample.key !== rule.key) continue;
      if (rule.source !== undefined && sample.source !== rule.source) continue;
      if (rule.where && !rule.where(sample)) continue;
      const scope = scopeOf(rule, sample);
      const runs = scopes.get(scope) ?? new Map<string, ScoreSample[]>();
      scopes.set(scope, runs);
      const run = runs.get(sample.runId);
      if (run) run.push(sample);
      else if (runs.size < window) runs.set(sample.runId, [sample]);
    }
    const statistic = rule.statistic ?? 'mean';
    const judged: Array<{
      scope: string;
      value: number;
      samples: number;
      breached: boolean;
      recovered: boolean;
      interval?: [number, number];
      runs: ScoreSample[];
    }> = [];
    for (const [scope, runs] of scopes) {
      const values: number[] = [];
      const representatives: ScoreSample[] = [];
      for (const scores of runs.values()) {
        const value =
          statistic === 'pass-rate'
            ? scores.filter((item) => item.passed ?? item.score >= 0.5).length / scores.length
            : scores.reduce((sum, item) => sum + item.score, 0) / scores.length;
        values.push(value);
        representatives.push({ ...(scores[0] as ScoreSample), score: value });
      }
      const n = values.length;
      const mean = n === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / n;
      let interval: [number, number] | undefined;
      const enough = n >= (rule.minSamples ?? 20);
      let breached = enough && mean < rule.below;
      if (rule.confidence !== undefined && n > 1) {
        const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
        const half = normalQuantile(1 - (1 - rule.confidence) / 2) * Math.sqrt(variance / n);
        interval = [mean - half, mean + half];
        breached = breached && mean + half < rule.below;
      }
      judged.push({
        scope,
        value: mean,
        samples: n,
        breached,
        // Back above on enough samples: too few to judge is not a recovery.
        recovered: enough && mean >= rule.below,
        ...(interval ? { interval } : {}),
        runs: representatives,
      });
    }
    return { statistic, judged };
  };

  const act = async (rule: AutomationRule, event: AutomationEvent) => {
    options.onEvent?.(event);
    if (event.type !== 'fired') return;
    for (const action of rule.actions) {
      try {
        await action(event);
      } catch (error) {
        options.onError?.(error, event);
      }
    }
  };

  const run = async (keys?: ReadonlySet<string>): Promise<AutomationEvent[]> => {
    const events: AutomationEvent[] = [];
    for (const rule of options.rules) {
      if (keys && !keys.has(rule.key)) continue;
      let result: Awaited<ReturnType<typeof judge>>;
      try {
        result = await judge(rule);
      } catch (error) {
        options.onError?.(error);
        continue;
      }
      for (const scope of result.judged) {
        const id = `${rule.name}|${scope.scope}`;
        const current = await readFiring(id);
        const at = now().toISOString();
        const firing = current?.since !== undefined;
        const due =
          scope.breached &&
          (!firing ||
            (rule.repeatAfterMs !== undefined &&
              now().getTime() - Date.parse(current?.firedAt ?? at) >= rule.repeatAfterMs));
        const recovered = scope.recovered && firing;
        if (!due && !recovered) continue;
        const next = due ? { since: current?.since ?? at, firedAt: at } : {};
        if (!(await claim(id, current, next))) continue;
        const [assistant, revision] = scope.scope.includes('@') ? scope.scope.split('@') : [undefined, undefined];
        const worst = [...scope.runs].sort((a, b) => a.score - b.score).slice(0, 5);
        const event: AutomationEvent = {
          type: due ? 'fired' : 'recovered',
          rule: rule.name,
          scope: scope.scope,
          key: rule.key,
          statistic: result.statistic,
          value: scope.value,
          ...(scope.interval ? { interval: scope.interval } : {}),
          below: rule.below,
          samples: scope.samples,
          ...(assistant ? { assistant } : worst[0]?.assistant ? { assistant: worst[0].assistant } : {}),
          ...(revision ? { revision } : {}),
          worst,
          at,
          summary: due
            ? `${rule.key} ${result.statistic} ${scope.value.toFixed(3)} is below ${rule.below} over ${scope.samples} runs of ${scope.scope}`
            : `${rule.key} ${result.statistic} ${scope.value.toFixed(3)} of ${scope.scope} recovered over ${scope.samples} runs`,
        };
        events.push(event);
        await act(rule, event);
      }
    }
    return events;
  };

  const rules: AutomationRules = {
    async check() {
      // One judgement at a time in this process; another waits for it, then judges again.
      while (checking) await checking.catch(() => undefined);
      checking = run();
      try {
        return await checking;
      } finally {
        checking = undefined;
      }
    },
    observe: async (scored) => {
      // A memory source keeps what it hears; a shared one already holds the scores.
      const memory = source as Partial<MemoryScoreSource>;
      if (typeof memory.observe === 'function') memory.observe(scored);
      const keys = new Set(scored.scores.map((score) => score.key));
      if (!options.rules.some((rule) => keys.has(rule.key))) return;
      while (checking) await checking.catch(() => undefined);
      checking = run(keys);
      try {
        await checking;
      } finally {
        checking = undefined;
      }
    },
    async status() {
      const statuses: AutomationStatus[] = [];
      for (const rule of options.rules) {
        const { judged } = await judge(rule);
        for (const scope of judged) {
          const firing = await readFiring(`${rule.name}|${scope.scope}`);
          statuses.push({
            rule: rule.name,
            scope: scope.scope,
            value: scope.value,
            samples: scope.samples,
            breached: scope.breached,
            ...(firing?.since ? { firingSince: firing.since } : {}),
          });
        }
      }
      return statuses;
    },
    start(startOptions = {}) {
      if (timer) return;
      timer = setInterval(
        () => void rules.check().catch((error: unknown) => options.onError?.(error)),
        startOptions.everyMs ?? 60_000,
      );
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return rules;
}

// ── Actions ──

/** Anything review items are opened in, such as an `AnnotationQueue`. */
export interface ReviewOpener {
  /** Opens one item. */
  enqueue(subject: { inputs?: unknown; output?: unknown; runId?: string }, metadata?: Record<string, unknown>): unknown;
}

/** Opens a review item for each of the lowest-scoring runs, at most `limit` (5), when a rule fires. */
export function openReview(queue: ReviewOpener, options: { limit?: number } = {}): AutomationAction {
  return async (event) => {
    for (const sample of event.worst.slice(0, options.limit ?? 5)) {
      await queue.enqueue(
        {
          runId: sample.runId,
          ...(sample.inputs === undefined ? {} : { inputs: sample.inputs }),
          ...(sample.output === undefined ? {} : { output: sample.output }),
        },
        { rule: event.rule, scope: event.scope, key: event.key, score: sample.score, summary: event.summary },
      );
    }
  };
}

/** Options for `sendWebhook()`. */
export interface AutomationWebhookOptions {
  /** Where the event is posted, as JSON. */
  url: string;
  /** Headers on the request, such as an authorization. */
  headers?: Record<string, string>;
  /**
   * Signs the body with HMAC-SHA256 under this secret, in `x-nexus-signature: sha256=<hex>`, so the
   * receiver knows it came from here.
   */
  secret?: string;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Posts the event to a webhook when a rule fires. A refusal rejects, which `onError` hears. */
export function sendWebhook(options: AutomationWebhookOptions): AutomationAction {
  return async (event) => {
    const body = JSON.stringify({ type: 'nexus.automation.fired', event });
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (options.secret) headers['x-nexus-signature'] = `sha256=${await hmacHex(options.secret, body)}`;
    const response = await (options.fetch ?? globalThis.fetch)(options.url, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`The webhook at ${options.url} answered ${response.status}`);
  };
}

/** Marks the revision a rule fired for unhealthy, which rolls back a canary, as `Deployments.markUnhealthy()` does. */
export function markUnhealthy(options: {
  deployments: {
    markUnhealthy(
      assistant: string,
      revision: string,
      options: { reason: string; by?: string; rollback?: boolean },
    ): Promise<unknown>;
  };
  /** Rolls a canary back at once. Defaults to true; false leaves it to a canary guard. */
  rollback?: boolean;
}): AutomationAction {
  return async (event) => {
    if (!event.assistant || !event.revision) {
      throw new Error(`Rule "${event.rule}" fired for ${event.scope}, which names no assistant and revision to mark`);
    }
    await options.deployments.markUnhealthy(event.assistant, event.revision, {
      reason: event.summary,
      by: `rule:${event.rule}`,
      ...(options.rollback === undefined ? {} : { rollback: options.rollback }),
    });
  };
}

// ── Helpers ──

function fromRun(run: Run): Omit<ScoreSample, 'key' | 'score' | 'at'> {
  const nexus = (run.metadata?.nexus ?? {}) as { assistant?: unknown; revision?: unknown };
  const tenantId = run.metadata?.tenantId;
  return {
    runId: run.id,
    ...(typeof nexus.assistant === 'string' ? { assistant: nexus.assistant } : {}),
    ...(typeof nexus.revision === 'string' ? { revision: nexus.revision } : {}),
    ...(typeof tenantId === 'string' ? { tenantId } : {}),
    ...(run.inputs === undefined ? {} : { inputs: run.inputs }),
    ...(run.outputs === undefined ? {} : { output: run.outputs }),
  };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The standard normal quantile, by Acklam's rational approximation (relative error under 1.2e-9). */
function normalQuantile(p: number): number {
  const [a1, a2, a3, a4, a5, a6] = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const [b1, b2, b3, b4, b5] = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
  ];
  const [c1, c2, c3, c4, c5, c6] = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const [d1, d2, d3, d4] = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) / ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
    (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
  );
}
