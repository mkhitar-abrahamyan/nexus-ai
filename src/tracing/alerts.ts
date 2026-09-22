import type { Run, RunQuery, TraceStore } from '../types/tracing.js';

/** What an alert measures: error rate, latency percentile, total cost, or run count. */
export type AlertMetric = 'errorRate' | 'latencyP95' | 'latencyP50' | 'cost' | 'count';

/** A condition over recent runs that should fire an alert. */
export interface AlertRule {
  /** Name reported when it fires. */
  name: string;
  /** What it measures. */
  metric: AlertMetric;
  /** Fires when the measured value crosses this, in the direction implied by the metric. */
  threshold: number;
  /** Window to measure, in milliseconds. Defaults to 15 minutes. */
  windowMs?: number;
  /** Narrows what is measured: one model, one kind of run, one tag. */
  filter?: RunQuery;
  /** Ignores a window with too few runs to mean anything. Defaults to 1. */
  minRuns?: number;
}

/** A rule that fired. */
export interface AlertEvent {
  /** The rule's name. */
  rule: string;
  /** What it measured. */
  metric: AlertMetric;
  /** The measured value. */
  value: number;
  /** The threshold it crossed. */
  threshold: number;
  /** Runs measured. */
  runs: number;
  /** ISO-8601 start of the window. */
  windowStart: string;
  /** ISO-8601 end of the window. */
  windowEnd: string;
  /** A few runs that contributed, so an alert points at something rather than just firing. */
  samples: Array<{ id: string; traceId: string; name: string }>;
}

/** Where fired alerts are sent. */
export interface AlertNotifier {
  /** Sends one alert. */
  notify(event: AlertEvent): Promise<void> | void;
}

/**
 * Watches traces and reports when something crosses a line.
 *
 * Metrics answer "how is it going"; alerts answer "tell me when it stops going well". Evaluating
 * over stored runs rather than a separate metrics pipeline means every alert carries the runs that
 * caused it, so the next step is reading them, not starting an investigation from scratch.
 */
export class AlertEvaluator {
  constructor(
    private readonly store: TraceStore,
    private readonly rules: AlertRule[],
    private readonly options: { notifier?: AlertNotifier; now?: () => Date } = {},
  ) {}

  /** Evaluates every rule once. Call it on a timer, or from a scheduled job. */
  async evaluate(): Promise<AlertEvent[]> {
    const now = (this.options.now ?? (() => new Date()))();
    const fired: AlertEvent[] = [];

    for (const rule of this.rules) {
      const windowMs = rule.windowMs ?? 15 * 60 * 1000;
      const windowStart = new Date(now.getTime() - windowMs).toISOString();
      const runs = await this.store.query({
        ...rule.filter,
        since: windowStart,
        limit: rule.filter?.limit ?? 1_000,
      });
      if (runs.length < (rule.minRuns ?? 1)) continue;

      const value = measure(rule.metric, runs);
      if (value <= rule.threshold) continue;

      const event: AlertEvent = {
        rule: rule.name,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        runs: runs.length,
        windowStart,
        windowEnd: now.toISOString(),
        samples: pickSamples(rule.metric, runs).map((run) => ({ id: run.id, traceId: run.traceId, name: run.name })),
      };
      fired.push(event);
      await this.options.notifier?.notify(event);
    }
    return fired;
  }
}

/** Computes a metric over a set of runs. */
export function measure(metric: AlertMetric, runs: Run[]): number {
  switch (metric) {
    case 'errorRate':
      return runs.filter((run) => run.status === 'error').length / runs.length;
    case 'latencyP95':
      return percentile(
        runs.map((run) => run.latencyMs ?? 0),
        0.95,
      );
    case 'latencyP50':
      return percentile(
        runs.map((run) => run.latencyMs ?? 0),
        0.5,
      );
    case 'cost':
      return runs.reduce((total, run) => total + (run.cost ?? 0), 0);
    case 'count':
      return runs.length;
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] as number;
}

function pickSamples(metric: AlertMetric, runs: Run[]): Run[] {
  const relevant =
    metric === 'errorRate'
      ? runs.filter((run) => run.status === 'error')
      : metric === 'cost'
        ? [...runs].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
        : [...runs].sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0));
  return relevant.slice(0, 3);
}

/** Options for `createWebhookNotifier()`. */
export interface WebhookNotifierOptions {
  /** The webhook URL. */
  url: string;
  /** Headers added to each post. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Builds the payload. Defaults to a shape chat webhooks accept: `{ text }` plus the event. */
  body?: (event: AlertEvent) => unknown;
}

/** Posts alerts to a webhook. The default payload fits the common `{ text }` chat format. */
export function createWebhookNotifier(options: WebhookNotifierOptions): AlertNotifier {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    async notify(event) {
      const payload = options.body?.(event) ?? {
        text: `${event.rule}: ${event.metric} is ${round(event.value)} (threshold ${event.threshold}) over ${event.runs} runs`,
        event,
      };
      await fetchImplementation(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(payload),
      });
    },
  };
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
