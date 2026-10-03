import type { Run, TraceExporter } from '../types/tracing.js';
import { w3cSpanId, w3cTraceId } from './tracer.js';

/** Options for `OtlpTraceExporter`. */
export interface OtlpTraceExporterOptions {
  /**
   * The collector's OTLP/HTTP base URL, such as `http://localhost:4318`. Spans are posted to
   * `/v1/traces` under it, as JSON.
   */
  endpoint: string;
  /** Headers on every request, such as an API key a hosted backend wants. */
  headers?: Record<string, string>;
  /** `service.name` on every span. Defaults to `nexus-ai-pro`. */
  serviceName?: string;
  /** More resource attributes, such as `deployment.environment.name` or `service.version`. */
  resource?: Record<string, string | number | boolean>;
  /** Spans sent per request. Defaults to 100. */
  maxBatch?: number;
  /** How long a span waits for others to batch with, in milliseconds. Defaults to 2,000. */
  flushIntervalMs?: number;
  /** Replaces the global `fetch`, for tests or a proxy. */
  fetch?: typeof globalThis.fetch;
  /** Called when a batch cannot be sent. The batch is dropped; a trace is never worth a retry storm. */
  onError?: (error: unknown) => void;
}

type AttributeValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

/** One span in OTLP's JSON encoding. */
export interface OtlpSpan {
  /** 32 hex digits. */
  traceId: string;
  /** 16 hex digits. */
  spanId: string;
  /** 16 hex digits, absent for a root span. */
  parentSpanId?: string;
  /** The span's name. */
  name: string;
  /** 1 internal, 3 client. */
  kind: number;
  /** Nanoseconds since the epoch, as a decimal string. */
  startTimeUnixNano: string;
  /** Nanoseconds since the epoch, as a decimal string. */
  endTimeUnixNano: string;
  /** Typed attributes. */
  attributes: Array<{ key: string; value: AttributeValue }>;
  /** 1 ok, 2 error. */
  status: { code: number; message?: string };
}

const OPERATIONS: Partial<Record<Run['kind'], string>> = {
  model: 'chat',
  embedding: 'embeddings',
  tool: 'execute_tool',
  agent: 'invoke_agent',
};

/**
 * Turns one finished run into an OpenTelemetry span, with the GenAI semantic conventions.
 *
 * A model run is a client span named `chat <model>` with `gen_ai.operation.name`,
 * `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, and
 * `gen_ai.usage.input_tokens` and `output_tokens`. A tool run carries `gen_ai.tool.name`, an agent
 * run `gen_ai.agent.name`. What only Nexus knows goes under `nexus.*`: the run kind, a graph node and
 * its step, the cost, and the run id. A failed run has `error.type` and an error status.
 */
export function runToOtlpSpan(run: Run): OtlpSpan {
  const attributes: Record<string, string | number | boolean> = { 'nexus.run.kind': run.kind, 'nexus.run.id': run.id };
  const operation = OPERATIONS[run.kind];
  if (operation) attributes['gen_ai.operation.name'] = operation;
  if (run.provider) attributes['gen_ai.provider.name'] = run.provider;
  if (run.kind === 'model' || run.kind === 'embedding') {
    const requested = run.metadata?.requestedModel;
    if (typeof requested === 'string') attributes['gen_ai.request.model'] = requested;
    else if (run.model) attributes['gen_ai.request.model'] = run.model;
    if (run.model) attributes['gen_ai.response.model'] = run.model;
    const input = run.usage?.inputTokens ?? run.usage?.promptTokens;
    const output = run.usage?.outputTokens ?? run.usage?.completionTokens;
    if (input !== undefined) attributes['gen_ai.usage.input_tokens'] = input;
    if (output !== undefined) attributes['gen_ai.usage.output_tokens'] = output;
  }
  if (run.kind === 'tool') attributes['gen_ai.tool.name'] = run.name;
  if (run.kind === 'agent') attributes['gen_ai.agent.name'] = run.name;
  if (run.kind === 'node') {
    attributes['nexus.graph.node'] = run.name;
    if (typeof run.metadata?.step === 'number') attributes['nexus.graph.step'] = run.metadata.step;
  }
  if (run.cost !== undefined) attributes['nexus.cost.usd'] = run.cost;
  if (run.error) attributes['error.type'] = run.error.name;
  for (const tag of run.tags ?? []) attributes[`nexus.tag.${tag}`] = true;

  const started = Date.parse(run.startedAt);
  const ended = run.endedAt ? Date.parse(run.endedAt) : started + (run.latencyMs ?? 0);
  const name =
    run.kind === 'model' && run.model ? `chat ${run.model}` : operation ? `${operation} ${run.name}` : run.name;
  return {
    traceId: w3cTraceId(run.traceId),
    spanId: w3cSpanId(run.id),
    ...(run.parentId ? { parentSpanId: w3cSpanId(run.parentId) } : {}),
    name,
    kind: run.kind === 'model' || run.kind === 'embedding' ? 3 : 1,
    startTimeUnixNano: nanos(started),
    endTimeUnixNano: nanos(ended),
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: typed(value) })),
    status: run.status === 'error' ? { code: 2, ...(run.error ? { message: run.error.message } : {}) } : { code: 1 },
  };
}

/**
 * Sends finished runs to any OpenTelemetry collector as OTLP/HTTP JSON, with no SDK to install.
 *
 * Pass it to a tracer's `exporters`, and every run the tracer keeps arrives as a span with the GenAI
 * semantic conventions, so Grafana Tempo, Jaeger, Honeycomb, Datadog, New Relic, or any OTLP backend
 * reads it as it reads the rest of the application. Spans are batched; `flush()` sends what is
 * waiting. Trace ids are the W3C ids `RunHandle.traceparent()` propagates, so a trace that crossed
 * processes arrives as one.
 */
export class OtlpTraceExporter implements TraceExporter {
  private readonly queue: OtlpSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(private readonly options: OtlpTraceExporterOptions) {}

  /** Queues a run, sending a batch when one is full. Runs still in progress are skipped. */
  export(run: Run): void {
    if (run.status === 'running') return;
    this.queue.push(runToOtlpSpan(run));
    if (this.queue.length >= (this.options.maxBatch ?? 100)) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.flushIntervalMs ?? 2_000);
      // A trace waiting to be sent must never keep the process alive on its own.
      this.timer.unref?.();
    }
  }

  /** Sends every span waiting. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.maxBatch ?? 100);
      this.sending = this.sending.then(() => this.send(batch));
    }
    await this.sending;
  }

  private async send(spans: OtlpSpan[]): Promise<void> {
    const resource = { 'service.name': this.options.serviceName ?? 'nexus-ai-pro', ...this.options.resource };
    const body = {
      resourceSpans: [
        {
          resource: { attributes: Object.entries(resource).map(([key, value]) => ({ key, value: typed(value) })) },
          scopeSpans: [{ scope: { name: 'nexus-ai-pro' }, spans }],
        },
      ],
    };
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(
        `${this.options.endpoint.replace(/\/+$/, '')}/v1/traces`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.options.headers },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(`The collector answered ${response.status}`);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}

function nanos(milliseconds: number): string {
  return `${BigInt(Math.round(milliseconds)) * 1_000_000n}`;
}

function typed(value: string | number | boolean): AttributeValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}
