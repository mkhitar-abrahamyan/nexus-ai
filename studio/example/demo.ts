/**
 * A small application with something in every studio view, for trying the studio and for its tests.
 *
 *   npm run studio:demo
 *
 * It records a traced agent run, leaves a support thread waiting for a human to approve a refund,
 * runs two experiments to compare, commits two prompt versions, and queues an answer for review.
 * Everything is in memory; a real application passes its own stores instead.
 */
import {
  AnnotationQueue,
  createDataset,
  evaluate,
  exactMatch,
  MemoryDatasetStore,
  MemoryExperimentStore,
} from 'nexus-ai-pro/evaluate';
import { appendList, createGraph, END, lastValue, MemoryGraphCheckpointer } from 'nexus-ai-pro/graph';
import { MemoryOperationStore, OperationRunner } from 'nexus-ai-pro/operations';
import { definePrompt } from 'nexus-ai-pro/prompts';
import { PromptRegistry } from 'nexus-ai-pro/prompts/registry';
import { MemoryTraceStore, Tracer, traceModelClient } from 'nexus-ai-pro/tracing';
import type { CompletionRequest, NexusResponse } from 'nexus-ai-pro';
import type { StudioSources } from '../src/types.js';

/** A model client that answers from a table, and prices its answers, so the demo needs no key. */
function scriptedClient() {
  return {
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      const question = String(request.messages.at(-1)?.content ?? '');
      const content = question.includes('refund') ? 'A refund of $40 is due.' : `Answer to: ${question}`;
      return {
        content,
        role: 'assistant' as const,
        finishReason: 'stop' as const,
        meta: {
          requestId: 'demo',
          providerUsed: 'openai',
          modelUsed: request.model ?? 'gpt-5.4-mini',
          latencyMs: 640,
          tokensInput: 120,
          tokensOutput: 30,
          tokensSaved: 0,
          estimatedCost: '$0.0004',
          usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
          cost: { amount: 0.00042, currency: 'USD', basis: 'estimated' },
          cacheHit: false,
          guardrailsApplied: [],
        } as NexusResponse['meta'],
      };
    },
    getProviderHealth: () => [
      {
        providerName: 'openai',
        healthy: true,
        successes: 42,
        failures: 1,
        consecutiveFailures: 0,
        avgLatencyMs: 640,
        score: 99,
      },
    ],
    getCircuitBreakerStatus: () => [
      { providerName: 'openai', state: 'closed', consecutiveFailures: 0, failureRate: 0.02 },
    ],
    getMetricsSnapshot: () => ({ counters: { nexus_ai_requests_total: 43 } }),
  };
}

/** Builds every source the studio shows, with data already in it. */
export async function createDemoSources(): Promise<StudioSources & { threadId: string; experimentIds: string[] }> {
  const client = scriptedClient();

  // A traced agent run: one root with two model calls under it, each with its cost.
  const traces = new MemoryTraceStore();
  const tracer = new Tracer({ store: traces });
  const root = tracer.startRun({ name: 'support-agent', kind: 'agent', inputs: { question: 'Where is my refund?' } });
  const traced = traceModelClient(client, tracer, { parent: () => root });
  await traced.complete({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'Look up order 1182' }] });
  const answer = await traced.complete({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Explain the refund' }],
  });
  await root.finish({ outputs: { answer: answer.content } });

  // A support thread paused for a human to approve the refund.
  const checkpointer = new MemoryGraphCheckpointer();
  const support = createGraph({ channels: { messages: appendList<string>(), approved: lastValue<boolean>() } })
    .addNode('draft', () => ({ messages: ['Refund $40 for order 1182'] }))
    .addNode('approve', async (context) => {
      const decision = await context.interrupt({
        reason: 'Approve this refund?',
        payload: { order: 1182, amount: 40 },
      });
      return { approved: decision === true || (decision as { approved?: boolean })?.approved === true };
    })
    .addNode('send', (context) => ({ messages: [context.state.approved ? 'Refund sent' : 'Refund declined'] }))
    .setEntry('draft')
    .addEdge('draft', 'approve')
    .addEdge('approve', 'send')
    .addEdge('send', END)
    .compile({ checkpointer });
  const threadId = 'refund-1182';
  await support.invoke({ messages: ['Customer asked for a refund'] }, { threadId });

  // Two experiments over one dataset: the candidate answers fewer examples correctly.
  const datasets = new MemoryDatasetStore();
  const experiments = new MemoryExperimentStore();
  const dataset = createDataset({
    name: 'support-answers',
    examples: [
      { id: 'a', inputs: 'refund status', expected: 'A refund of $40 is due.' },
      { id: 'b', inputs: 'shipping time', expected: 'Answer to: shipping time' },
      { id: 'c', inputs: 'refund policy', expected: 'A refund of $40 is due.' },
    ],
  });
  datasets.save(dataset);
  const baseline = await evaluate(
    async (inputs) =>
      (await client.complete({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: String(inputs) }] })).content,
    dataset,
    [exactMatch()],
    { name: 'baseline', store: experiments },
  );
  const candidate = await evaluate(async () => 'I do not know.', dataset, [exactMatch()], {
    name: 'candidate',
    store: experiments,
  });

  // Two prompt versions, one in production and one in staging.
  const prompts = new PromptRegistry();
  const v1 = definePrompt({
    name: 'support-reply',
    messages: [{ role: 'user', content: 'Answer: {{question}}' }],
    config: { model: 'gpt-5.4-mini' },
  });
  const v2 = definePrompt({
    name: 'support-reply',
    messages: [
      { role: 'system', content: 'You are a concise support agent.' },
      { role: 'user', content: 'Answer: {{question}}' },
    ],
    config: { model: 'gpt-5.4-mini', temperature: 0 },
  });
  await prompts.commit(v1, { message: 'First version', author: 'ada', label: 'production' });
  await prompts.commit(v2, { message: 'Add a system prompt', author: 'ada', label: 'staging' });

  // An answer waiting for a person to grade it.
  const reviews = new AnnotationQueue({
    rubric: [
      { key: 'correct', prompt: 'Is the answer correct?', type: 'boolean' },
      { key: 'tone', prompt: 'How is the tone, from 0 to 1?', type: 'score' },
    ],
  });
  reviews.enqueue({ inputs: 'Where is my refund?', output: answer.content });

  // A couple of background operations.
  const operations = new MemoryOperationStore();
  const runner = new OperationRunner({ store: operations });
  await (await runner.submit(async () => 'done', { kind: 'report.nightly' })).result();
  await (
    await runner.submit(
      async () => {
        throw new Error('Provider timed out');
      },
      { kind: 'report.weekly' },
    )
  )
    .result()
    .catch(() => undefined);

  return {
    traces,
    graphs: { support: { graph: support, checkpointer } },
    reviews: { answers: reviews },
    datasets,
    experiments,
    prompts,
    client,
    operations,
    budgets: [{ name: 'support', limit: 5, period: 'month' }],
    threadId,
    experimentIds: [baseline.id, candidate.id],
  };
}
