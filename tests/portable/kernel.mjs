/**
 * The portable kernel's tests. They are written against web-standard APIs only: no test framework,
 * no Node built-in, no Node global. So the same file runs on Node.js, Deno, Bun, and an edge runtime,
 * against the built package.
 *
 * `run()` returns what passed and failed; each runner prints it and fails when anything failed.
 */
import { createAgent, agentInput } from '../../dist/agent/index.js';
import { createGraph, END, lastValue } from '../../dist/graph/index.js';
import { NexusAI } from '../../dist/index.js';
import { a2aClient, a2aHandler } from '../../dist/protocols/a2a.js';
import { agUiEvents } from '../../dist/protocols/ag-ui.js';
import { GoogleProvider } from '../../dist/providers/google.js';
import {
  collectStream,
  createTextStream,
  isSensitiveCapability,
  mapStream,
  NexusProviderError,
  parseCapability,
  runtimeInfo,
  ToolExecutor,
  tool,
} from '../../dist/runtime/index.js';

const checks = [];
const check = (name, body) => checks.push({ name, body });

function equal(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

/** A Gemini endpoint written from its documented wire format, behind a `fetch`. */
function geminiFetch(seen) {
  return async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const candidate = (text) => ({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    });
    if (String(url).includes(':streamGenerateContent')) {
      const frames = ['Hello ', 'from ', 'Gemini.'].map((text) => `data: ${JSON.stringify(candidate(text))}\n\n`);
      const bytes = new TextEncoder().encode(frames.join(''));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 20));
            controller.enqueue(bytes.slice(20));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return Response.json({
      ...candidate('Hello from Gemini.'),
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 },
    });
  };
}

/** A model that answers from a script, as a chat client. */
function scriptedClient(responses) {
  let index = 0;
  return {
    complete: async () => {
      const scripted = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        content: '',
        role: 'assistant',
        finishReason: 'stop',
        meta: {
          requestId: `r-${index}`,
          providerUsed: 'mock',
          modelUsed: 'mock',
          latencyMs: 0,
          tokensInput: 0,
          tokensOutput: 0,
          tokensSaved: 0,
          cacheHit: false,
          guardrailsApplied: [],
        },
        ...scripted,
      };
    },
  };
}

const weather = tool({
  name: 'weather',
  description: 'Weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  capabilities: [],
  execute: async ({ city }) => ({ city, sky: 'clear' }),
});

check('the runtime is recognized', () => {
  const expected = globalThis.__NEXUS_EXPECTED_RUNTIME__;
  if (expected) equal(runtimeInfo().name, expected, 'runtimeInfo().name');
});

check('tools and their capabilities', async () => {
  const executor = new ToolExecutor([weather]);
  const result = await executor.execute('weather', { city: 'Yerevan' });
  equal(result.ok, true, 'the tool ran');
  equal(result.result, { city: 'Yerevan', sky: 'clear' }, 'its result');
  equal(parseCapability('network:api.example.com'), { kind: 'network', target: 'api.example.com' }, 'a capability');
  equal([isSensitiveCapability('filesystem:read'), isSensitiveCapability('shell')], [false, true], 'what is sensitive');
});

check('streams', async () => {
  equal(await collectStream(createTextStream('portable')), 'portable', 'a text stream');
  const shouted = mapStream(createTextStream('quiet'), (chunk) =>
    chunk.type === 'text' ? { ...chunk, content: chunk.content.toUpperCase() } : chunk,
  );
  equal(await collectStream(shouted), 'QUIET', 'a mapped stream');
});

check('a provider over fetch completes and streams', async () => {
  const seen = [];
  const provider = new GoogleProvider({ apiKey: 'test-key', fetch: geminiFetch(seen) });
  const request = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Say hello' }] };
  const response = await provider.complete(request);
  equal(response.content, 'Hello from Gemini.', 'the completion');
  equal(seen[0].body.contents[0].parts[0].text, 'Say hello', 'the request on the wire');
  let streamed = '';
  for await (const chunk of provider.stream(request)) if (chunk.type === 'text') streamed += chunk.content;
  equal(streamed, 'Hello from Gemini.', 'the stream, split mid-frame');
  const failing = new GoogleProvider({
    apiKey: 'k',
    fetch: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
  });
  let error;
  try {
    await failing.complete(request);
  } catch (caught) {
    error = caught;
  }
  equal(error instanceof NexusProviderError, true, 'a failure is a provider error');
});

check('the client routes a request to a registered provider', async () => {
  const ai = new NexusAI({ providers: {}, routing: { mode: 'direct' } });
  ai.registerProvider('google', new GoogleProvider({ apiKey: 'test-key', fetch: geminiFetch([]) }));
  const response = await ai.complete({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Say hello' }] });
  equal(response.content, 'Hello from Gemini.', 'the answer');
  equal(response.meta.providerUsed, 'google', 'the provider used');
});

check('a graph runs, and its node cache keys by SHA-256', async () => {
  let calls = 0;
  const graph = createGraph({ channels: { query: lastValue(''), result: lastValue('') } })
    .addNode(
      'lookup',
      ({ state }) => {
        calls += 1;
        return { result: `answer for ${state.query}` };
      },
      { cache: {} },
    )
    .setEntry('lookup')
    .addEdge('lookup', END)
    .compile();
  const first = await graph.invoke({ query: 'weather' });
  const second = await graph.invoke({ query: 'weather' });
  equal([first.state.result, second.state.result, calls], ['answer for weather', 'answer for weather', 1], 'cached');
  equal(/^thread-[0-9a-f]{12}$/.test(first.threadId), true, 'a random thread id');
});

check('an agent calls a tool and answers', async () => {
  const agent = createAgent({
    client: scriptedClient([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Yerevan"}' } }] },
      { content: 'It is clear in Yerevan.' },
    ]),
    tools: [weather],
  });
  const result = await agent.invoke(agentInput('Weather in Yerevan?'));
  equal(result.state.answer, 'It is clear in Yerevan.', 'the answer');
  equal(result.state.messages.filter((message) => message.role === 'tool').length, 1, 'one tool result');
});

check('agents talk over A2A and render over AG-UI', async () => {
  const agent = createAgent({ client: scriptedClient([{ content: 'Paris.' }]) });
  const handler = a2aHandler(agent, {
    card: { name: 'Geo', description: 'Geography', version: '1.0.0', url: 'https://geo.example.test/a2a', skills: [] },
  });
  const client = a2aClient({
    url: 'https://geo.example.test/a2a',
    fetch: (input, init) => handler(new Request(input, init)),
  });
  equal((await client.card()).name, 'Geo', 'the card');
  const task = await client.send('Capital of France?');
  equal([task.status.state, task.artifacts[0].parts[0].text], ['TASK_STATE_COMPLETED', 'Paris.'], 'the task');
  const types = [];
  for await (const event of agUiEvents(agent, {
    threadId: 't',
    runId: 'r',
    messages: [{ id: 'm', role: 'user', content: 'Hi' }],
  })) {
    types.push(event.type);
  }
  equal([types[0], types.at(-1)], ['RUN_STARTED', 'RUN_FINISHED'], 'the run, as events');
});

/** Runs every check, reporting each as it finishes. */
export async function run(log = (line) => console.log(line)) {
  const failed = [];
  for (const { name, body } of checks) {
    try {
      await body();
      log(`ok - ${name}`);
    } catch (error) {
      failed.push(name);
      log(`not ok - ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }
  const info = runtimeInfo();
  log(
    `# ${checks.length - failed.length} of ${checks.length} passed on ${info.name}${info.version ? ` ${info.version}` : ''}`,
  );
  return { passed: checks.length - failed.length, failed };
}
