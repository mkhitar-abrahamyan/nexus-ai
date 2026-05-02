import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { PeriodicExportingMetricReader, ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { NexusAI, OpenTelemetryMetricsSink, OpenTelemetryTraceExporter } from '../src/index.js';

// Optional example dependency install:
// npm install @opentelemetry/sdk-node @opentelemetry/sdk-trace-node @opentelemetry/sdk-metrics

const sdk = new NodeSDK({
  traceExporter: new ConsoleSpanExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
  }),
});

await sdk.start();

const meter = sdk['_meterProvider'].getMeter('nexus-ai-pro-example');
const tracer = sdk['_tracerProvider'].getTracer('nexus-ai-pro-example');

const ai = new NexusAI({
  providers: {
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  routing: { mode: 'auto', strategy: 'privacy' },
  pipeline: { includeTraceInResponse: true },
  metrics: {
    enabled: true,
    sink: new OpenTelemetryMetricsSink(meter),
  },
});

const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
});

if (response.meta.pipeline) {
  new OpenTelemetryTraceExporter(tracer).exportTrace(response.meta.pipeline, {
    provider: response.meta.providerUsed,
    model: response.meta.modelUsed,
  });
}

console.log(response.content);
await sdk.shutdown();
