import type { PipelineTrace, PipelineTraceStep } from '../pipeline/types.js';

export interface OpenTelemetryLikeSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException?(error: Error): void;
  setStatus?(status: { code: number; message?: string }): void;
  end(endTime?: Date): void;
}

export interface OpenTelemetryLikeTracer {
  startSpan(name: string, options?: Record<string, unknown>): OpenTelemetryLikeSpan;
}

export class OpenTelemetryTraceExporter {
  constructor(private tracer: OpenTelemetryLikeTracer, private spanPrefix = 'nexus-ai-pro') {}

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
