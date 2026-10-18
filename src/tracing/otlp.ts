import type { Run, TraceExporter } from '../types/tracing.js';
import { decodeOtlpTraceResponse, encodeOtlpTraceRequest } from './otlp-proto.js';
import { w3cSpanId, w3cTraceId } from './tracer.js';

/** Options for `OtlpTraceExporter`. */
export interface OtlpTraceExporterOptions {
  /**
   * The collector's OTLP/HTTP base URL, such as `http://localhost:4318`. Spans are posted to
   * `/v1/traces` under it.
   */
  endpoint: string;
  /**
   * How spans are encoded: `http/json`, the default, or `http/protobuf`, OTLP's binary encoding,
   * smaller and faster for a collector to read. For OTLP over gRPC, use `OtlpGrpcTraceExporter`
   * from `nexus-ai-pro/tracing/otlp-grpc`.
   */
  protocol?: 'http/json' | 'http/protobuf';
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
  /**
   * Called when a batch cannot be sent. The batch is dropped; a trace is never worth a retry storm.
   * To keep it instead, send through `spoolingExporter()`, from `nexus-ai-pro/tracing/spool`. Also
   * called, with an `OtlpPartialSuccessError`, when the collector took a batch but rejected some of
   * its spans, which sending again would not change.
   */
  onError?: (error: unknown) => void;
}

/** A typed attribute value, in OTLP's JSON encoding. */
export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

/** One attribute, in OTLP's JSON encoding. */
export interface OtlpKeyValue {
  /** The attribute's name. */
  key: string;
  /** Its typed value. */
  value: OtlpAttributeValue;
}

/** An `ExportTraceServiceRequest` in OTLP's JSON encoding: spans grouped by resource and scope. */
export interface OtlpExportRequest {
  /** One entry per resource. */
  resourceSpans: Array<{
    /** The resource's attributes, such as `service.name`. */
    resource: { attributes: OtlpKeyValue[] };
    /** The spans, grouped by the instrumentation scope that made them. */
    scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtlpSpan[] }>;
  }>;
}

/** Thrown to `onError` when a collector took a batch but rejected some of its spans. */
export class OtlpPartialSuccessError extends Error {
  constructor(
    /** Spans the collector rejected. */
    public readonly rejectedSpans: number,
    /** Why, in its words. */
    public readonly errorMessage?: string,
  ) {
    super(`The collector rejected ${rejectedSpans} span(s)${errorMessage ? `: ${errorMessage}` : ''}`);
    this.name = 'OtlpPartialSuccessError';
  }
}

type AttributeValue = OtlpAttributeValue;

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
  attributes: OtlpKeyValue[];
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

  constructor(protected readonly options: OtlpTraceExporterOptions) {}

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
      this.sending = this.sending.then(() =>
        this.post(batch).catch((error: unknown) => {
          this.options.onError?.(error);
        }),
      );
    }
    await this.sending;
  }

  /**
   * Sends finished runs as one batch now, and rejects when the collector does not take them: what a
   * spooling exporter sends through, so a batch the collector refuses is kept, not dropped.
   */
  async send(runs: Run[]): Promise<void> {
    const spans = runs.filter((run) => run.status !== 'running').map(runToOtlpSpan);
    if (spans.length) await this.post(spans);
  }

  /** The export request a batch of spans makes, under this exporter's resource. */
  protected request(spans: OtlpSpan[]): OtlpExportRequest {
    const resource = { 'service.name': this.options.serviceName ?? 'nexus-ai-pro', ...this.options.resource };
    return {
      resourceSpans: [
        {
          resource: { attributes: Object.entries(resource).map(([key, value]) => ({ key, value: typed(value) })) },
          scopeSpans: [{ scope: { name: 'nexus-ai-pro' }, spans }],
        },
      ],
    };
  }

  /** Sends one batch, rejecting when the collector does not take it. */
  protected async post(spans: OtlpSpan[]): Promise<void> {
    const protobuf = this.options.protocol === 'http/protobuf';
    const request = this.request(spans);
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.options.endpoint.replace(/\/+$/, '')}/v1/traces`,
      {
        method: 'POST',
        headers: {
          'content-type': protobuf ? 'application/x-protobuf' : 'application/json',
          ...this.options.headers,
        },
        body: protobuf
          ? (encodeOtlpTraceRequest(request) as NonNullable<RequestInit['body']>)
          : JSON.stringify(request),
      },
    );
    if (!response.ok) throw new Error(`The collector answered ${response.status}`);
    this.partial(protobuf ? await partialFromProtobuf(response) : await partialFromJson(response));
  }

  /** Reports spans the collector rejected from a batch it took. */
  protected partial(partial: { rejectedSpans: number; errorMessage?: string } | undefined): void {
    if (partial && partial.rejectedSpans > 0) {
      this.options.onError?.(new OtlpPartialSuccessError(partial.rejectedSpans, partial.errorMessage));
    }
  }
}

async function partialFromJson(
  response: Response,
): Promise<{ rejectedSpans: number; errorMessage?: string } | undefined> {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as { partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } };
    const rejected = Number(body.partialSuccess?.rejectedSpans ?? 0);
    return rejected > 0
      ? {
          rejectedSpans: rejected,
          ...(body.partialSuccess?.errorMessage ? { errorMessage: body.partialSuccess.errorMessage } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function partialFromProtobuf(
  response: Response,
): Promise<{ rejectedSpans: number; errorMessage?: string } | undefined> {
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  return bytes.length ? decodeOtlpTraceResponse(bytes) : undefined;
}

export { decodeOtlpTraceResponse, encodeOtlpTraceRequest, type OtlpPartialSuccess } from './otlp-proto.js';

function nanos(milliseconds: number): string {
  return `${BigInt(Math.round(milliseconds)) * 1_000_000n}`;
}

function typed(value: string | number | boolean): AttributeValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}
