/**
 * A self-hosted agent server: one graph assistant, threads, runs, and a nightly cron job.
 *
 * Run it with `npx tsx examples/agent-server.ts`, then:
 *
 *   curl localhost:8080/health
 *   curl -X POST localhost:8080/threads -d '{"assistant":"support"}' -H 'content-type: application/json'
 *   curl -X POST localhost:8080/threads/<id>/runs -d '{"input":{"messages":["hello"]}}' -H 'content-type: application/json'
 *   curl -N localhost:8080/runs/<runId>/events
 *
 * Everything here is in memory, which suits one process. To scale out, give every replica the same
 * Redis-backed stores; `deploy/app/server.mjs` does that from `REDIS_URL`, with API and worker roles,
 * and `deploy/compose.yaml`, `deploy/kubernetes`, and `deploy/helm` run it.
 */
import { createServer } from 'node:http';
import { appendList, lastValue } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { createGraph } from '../src/graph/graph.js';
import { createAgentServer, graphAssistant, toNodeListener } from '../src/server/index.js';
import { END } from '../src/types/graph.js';

const support = createGraph({
  channels: { messages: appendList<string>(), answer: lastValue<string>() },
})
  .addNode('answer', async (context) => {
    const question = context.state.messages.at(-1) ?? '';
    // A real server would call a model here, through NexusAI or a prompt from the registry.
    return { messages: [`answered: ${question}`], answer: `answered: ${question}` };
  })
  .setEntry('answer')
  .addEdge('answer', END)
  .compile({ checkpointer: new MemoryGraphCheckpointer() });

const server = createAgentServer({
  assistants: { support: graphAssistant(support, { description: 'Answers support questions' }) },
  // Every request is anonymous here. In production, read a token and return a principal:
  // authenticate: (request) => verify(request.headers.get('authorization')),
  onBusy: 'enqueue',
  cron: {
    tickMs: 30_000,
    jobs: [{ assistant: 'support', schedule: { cron: '0 2 * * *' }, input: { messages: ['nightly summary'] } }],
  },
  onError: (error) => console.error('server error', error),
});

await server.start();
const port = Number(process.env.PORT ?? 8080);
createServer(toNodeListener(server)).listen(port, () => {
  console.log(`agent server on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
