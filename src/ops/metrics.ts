import type { PipelineTraceStep } from '../pipeline/types.js';

/** Where metrics go: counters, histograms, and gauges, labelled. */
export interface MetricsSink {
  /** Adds to a counter. */
  increment(name: string, value?: number, labels?: Record<string, string>): void | Promise<void>;
  /** Records a value in a histogram, such as a latency. */
  observe(name: string, value: number, labels?: Record<string, string>): void | Promise<void>;
  /** Sets a gauge. */
  gauge?(name: string, value: number, labels?: Record<string, string>): void | Promise<void>;
}

/** Metrics collection for a client. */
export interface MetricsConfig {
  /** Turns collection on. Off by default, and then nothing is recorded. */
  enabled?: boolean;
  /**
   * Where metrics go. Defaults to an in-memory sink, readable through `getMetricsSnapshot()` and
   * `getPrometheusMetrics()`.
   */
  sink?: MetricsSink;
  /** Prefix for metric names. Defaults to `nexus_ai`. */
  prefix?: string;
  /**
   * Ignored: Prometheus text is always available from `getPrometheusMetrics()`.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  prometheus?: boolean;
}

type MetricKey = string;

/** Keeps metrics in memory, for a snapshot or a Prometheus scrape. */
export class InMemoryMetrics implements MetricsSink {
  private counters = new Map<MetricKey, number>();
  private histograms = new Map<MetricKey, number[]>();
  private gauges = new Map<MetricKey, number>();

  /** Adds to a counter. */
  increment(name: string, value = 1, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  /** Records a value in a histogram. */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const values = this.histograms.get(key) || [];
    values.push(value);
    this.histograms.set(key, values);
  }

  /** Sets a gauge. */
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** Every metric as plain data: counters, histogram count, average and maximum, and gauges. */
  snapshot(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms].map(([key, values]) => [
          key,
          {
            count: values.length,
            avg: values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0,
            max: values.length ? Math.max(...values) : 0,
          },
        ]),
      ),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  /** Every metric in Prometheus text exposition format. */
  toPrometheus(prefix = 'nexus_ai'): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) {
      lines.push(`${prefix}_${sanitizeMetric(key)} ${value}`);
    }
    for (const [key, values] of this.histograms) {
      const metric = `${prefix}_${sanitizeMetric(key)}`;
      const sum = values.reduce((total, value) => total + value, 0);
      lines.push(`${metric}_count ${values.length}`);
      lines.push(`${metric}_sum ${sum}`);
    }
    for (const [key, value] of this.gauges) {
      lines.push(`${prefix}_${sanitizeMetric(key)} ${value}`);
    }
    return lines.join('\n');
  }

  private key(name: string, labels: Record<string, string>): string {
    const suffix = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    return suffix ? `${name}{${suffix}}` : name;
  }
}

/** The part of an OpenTelemetry meter the metrics sink uses. */
export interface OpenTelemetryLikeMeter {
  /** Creates a counter. */
  createCounter(name: string): {
    add(value: number, labels?: Record<string, string>): void;
  };
  /** Creates a histogram. */
  createHistogram(name: string): {
    record(value: number, labels?: Record<string, string>): void;
  };
  /** Creates an observable gauge. */
  createObservableGauge?: (name: string) => unknown;
}

/** Sends metrics to OpenTelemetry through a meter. */
export class OpenTelemetryMetricsSink implements MetricsSink {
  private counters = new Map<string, ReturnType<OpenTelemetryLikeMeter['createCounter']>>();
  private histograms = new Map<string, ReturnType<OpenTelemetryLikeMeter['createHistogram']>>();

  constructor(private meter: OpenTelemetryLikeMeter) {}

  /** Adds to a counter, creating it on first use. */
  increment(name: string, value = 1, labels?: Record<string, string>): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, labels);
  }

  /** Records a value in a histogram, creating it on first use. */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    histogram.record(value, labels);
  }
}

/**
 * Records request, response, error, and pipeline-step metrics for a client, when metrics are
 * enabled.
 */
export class MetricsCollector {
  private memory = new InMemoryMetrics();
  private sink?: MetricsSink;
  private prefix: string;

  constructor(private config: MetricsConfig = {}) {
    this.sink = config.sink || this.memory;
    this.prefix = config.prefix || 'nexus_ai';
  }

  /** Counts a request. */
  async recordRequest(labels: Record<string, string>): Promise<void> {
    if (!this.config.enabled) return;
    await this.sink?.increment(`${this.prefix}.requests`, 1, labels);
  }

  /** Counts an error. */
  async recordError(labels: Record<string, string>): Promise<void> {
    if (!this.config.enabled) return;
    await this.sink?.increment(`${this.prefix}.errors`, 1, labels);
  }

  /** Counts a response and records its latency and cost. */
  async recordResponse(labels: Record<string, string>, latencyMs: number, cost?: number): Promise<void> {
    if (!this.config.enabled) return;
    await this.sink?.increment(`${this.prefix}.responses`, 1, labels);
    await this.sink?.observe(`${this.prefix}.latency_ms`, latencyMs, labels);
    if (cost !== undefined) await this.sink?.observe(`${this.prefix}.estimated_cost`, cost, labels);
  }

  /** Records how long a pipeline stage took. */
  async recordStep(step: PipelineTraceStep): Promise<void> {
    if (!this.config.enabled) return;
    await this.sink?.observe(`${this.prefix}.pipeline_step_ms`, step.durationMs, {
      step: String(step.name),
      ok: String(step.ok),
    });
  }

  /** The in-memory metrics, as plain data. */
  snapshot(): Record<string, unknown> {
    return this.memory.snapshot();
  }

  /** The in-memory metrics, in Prometheus text format. */
  toPrometheus(): string {
    return this.memory.toPrometheus(this.prefix.replace(/\./g, '_'));
  }
}

function sanitizeMetric(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
}
