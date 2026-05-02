import express from 'express';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { NexusAI, OpenTelemetryTraceExporter } from '../src/index.js';

// Optional example dependency install:
// npm install express @opentelemetry/sdk-node @opentelemetry/sdk-trace-node

const sdk = new NodeSDK({
  traceExporter: new ConsoleSpanExporter(),
});
await sdk.start();

const tracer = sdk['_tracerProvider'].getTracer('nexus-ai-pro-express');
const traceExporter = new OpenTelemetryTraceExporter(tracer);

const ai = new NexusAI({
  providers: {
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  routing: { mode: 'auto', strategy: 'privacy' },
  pipeline: { includeTraceInResponse: true },
});

const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const response = await ai.complete({
    model: 'auto',
    messages: [{ role: 'user', content: String(req.body.message || '') }],
  });

  if (response.meta.pipeline) {
    traceExporter.exportTrace(response.meta.pipeline, {
      route: '/chat',
      provider: response.meta.providerUsed,
      model: response.meta.modelUsed,
    });
  }

  res.json({ content: response.content, meta: response.meta });
});

app.listen(3000, () => {
  console.log('Listening on http://localhost:3000');
});
