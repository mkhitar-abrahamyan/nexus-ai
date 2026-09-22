import type { PipelineTrace, PipelineTraceStep } from '../pipeline/types.js';

/** The part of an OpenTelemetry span the exporter uses. */
export interface OpenTelemetryLikeSpan {
  /** Sets an attribute. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Records an exception. */
  recordException?(error: Error): void;
  /** Sets the span status. */
  setStatus?(status: { code: number; message?: string }): void;
  /** Ends the span. */
  end(endTime?: Date): void;
}

/** The part of an OpenTelemetry tracer the exporter uses. */
export interface OpenTelemetryLikeTracer {
  /** Starts a span. */
  startSpan(name: string, options?: Record<string, unknown>): OpenTelemetryLikeSpan;
}

/** Exports pipeline traces as OpenTelemetry spans: one for the pipeline and one per step. */
export class OpenTelemetryTraceExporter {
  constructor(
    private tracer: OpenTelemetryLikeTracer,
    private spanPrefix = 'nexus-ai-pro',
  ) {}

  /** Exports one pipeline trace, with extra attributes on the root span. */
  exportTrace(trace: PipelineTrace, attributes: Record<string, string | number | boolean> = {}): void {
    const root = this.tracer.startSpan(`${this.spanPrefix}.pipeline`, {
      startTime: new Date(trace.startedAt),
    });

    for (const [key, value] of Object.entries(attributes)) {
      root.setAttribute(key, value);
    }
    if (trace.durationMs !== undefined) root.setAttribute('pipeline.duration_ms', trace.durationMs);
    if (trace.requestId) root.setAttribute('request.id', trace.requestId);

    for (const step of trace.steps) {
      this.exportStep(step, attributes);
    }

    root.end(trace.endedAt ? new Date(trace.endedAt) : undefined);
  }

  private exportStep(step: PipelineTraceStep, attributes: Record<string, string | number | boolean>): void {
    const span = this.tracer.startSpan(`${this.spanPrefix}.${step.name}`, {
      startTime: new Date(step.startedAt),
    });
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    span.setAttribute('pipeline.step', String(step.name));
    span.setAttribute('pipeline.step.ok', step.ok);
    span.setAttribute('pipeline.step.duration_ms', step.durationMs);

    if (step.metadata) {
      for (const [key, value] of Object.entries(step.metadata)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          span.setAttribute(`pipeline.step.${key}`, value);
        }
      }
    }

    if (step.error) {
      span.recordException?.(new Error(step.error));
      span.setStatus?.({ code: 2, message: step.error });
    } else {
      span.setStatus?.({ code: 1 });
    }

    span.end(new Date(step.endedAt));
  }
}
