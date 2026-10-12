/**
 * Tool search, proved on 500 deferred tools through the real Anthropic, OpenAI, and Google adapters.
 *
 * The model is an oracle at the wire: it knows each task's plan, but calls a tool only when that
 * provider's request has the tool loaded, and otherwise searches for it once. On Anthropic a tool is
 * loaded when it is sent without `defer_loading` or a tool reference in the conversation names it; on
 * the others, when the request sends it at all. So the run passes only if the search finds each tool
 * and each adapter then loads it, the way that provider loads tools.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { searchTools, toolSearchTool } from '../src/agent/tool-search.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { ToolDefinition, ToolOutput } from '../src/types/messages.js';

const DOMAINS = [
  ['calendar', 'event'],
  ['email', 'message'],
  ['crm', 'customer'],
  ['github', 'issue'],
  ['files', 'document'],
  ['payments', 'invoice'],
  ['weather', 'forecast'],
  ['analytics', 'report'],
  ['support', 'ticket'],
  ['inventory', 'product'],
  ['hr', 'employee'],
  ['travel', 'flight'],
  ['chat', 'channel'],
  ['database', 'record'],
  ['monitoring', 'alert'],
  ['marketing', 'campaign'],
  ['legal', 'contract'],
  ['shipping', 'parcel'],
  ['learning', 'course'],
  ['wiki', 'page'],
  ['security', 'incident'],
  ['sales', 'opportunity'],
  ['design', 'mockup'],
  ['finance', 'budget'],
  ['events', 'venue'],
] as const;
const ACTIONS = [
  'create',
  'get',
  'list',
  'update',
  'delete',
  'search',
  'archive',
  'share',
  'export',
  'summarize',
  'approve',
  'assign',
  'tag',
  'comment',
  'duplicate',
  'restore',
  'schedule',
  'lock',
  'merge',
  'publish',
] as const;

/** 500 deferred tools, each with documented arguments, as real integrations have. */
function catalog(): ToolDefinition[] {
  return DOMAINS.flatMap(([domain, noun]) =>
    ACTIONS.map((action) =>
      tool({
        name: `${domain}_${action}_${noun}`,
        description: `${action[0]?.toUpperCase()}${action.slice(1)}s a ${noun} in ${domain}.`,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: `The ${noun} identifier` },
            fields: { type: 'array', items: { type: 'string' }, description: `Which ${noun} fields to use` },
            dryRun: { type: 'boolean', description: 'Validates without changing anything' },
          },
        },
        deferred: true,
        execute: async () => ({ ok: true }),
      }),
    ),
  );
}

interface Task {
  text: string;
  plan: string[];
}

/** 40 tasks: 30 that need one tool and 10 that need two, across every domain. */
function tasks(): Task[] {
  const list: Task[] = [];
  const name = (index: number, shift: number) => {
    const [domain, noun] = DOMAINS[(index + shift) % DOMAINS.length] as (typeof DOMAINS)[number];
    const action = ACTIONS[(index * 7 + shift) % ACTIONS.length] as (typeof ACTIONS)[number];
    return `${domain}_${action}_${noun}`;
  };
  for (let index = 0; index < 30; index += 1) list.push({ text: `Task ${index}: one step.`, plan: [name(index, 0)] });
  for (let index = 0; index < 10; index += 1) {
    list.push({ text: `Task ${30 + index}: two steps.`, plan: [name(index, 3), name(index, 11)] });
  }
  return list;
}

/** What the model sees on one provider's wire, in the same terms everywhere. */
interface WireView {
  task: string;
  called: string[];
  lastWasSearch: boolean;
  loaded: Set<string>;
}

type Move = { call: string; args: Record<string, unknown> } | { say: string };

/** The oracle: the plan's next tool if it is loaded, a search for it if not yet searched, else give up. */
function oracle(plans: Map<string, string[]>, view: WireView): Move {
  const plan = plans.get(view.task) ?? [];
  const done = view.called.filter((name) => name !== 'search_tools');
  const next = plan[done.length];
  if (next === undefined) return { say: 'Done.' };
  if (view.loaded.has(next)) return { call: next, args: { id: 'x' } };
  if (view.lastWasSearch) return { say: `I cannot find a tool for ${next}.` };
  // The model asks for what the step does, in its own words.
  return { call: 'search_tools', args: { query: next.split('_').join(' ') } };
}

let ids = 0;

function anthropicClient(plans: Map<string, string[]>, wires: Array<Record<string, unknown>>) {
  return {
    messages: {
      async create(params: Record<string, unknown>) {
        wires.push(params);
        const messages = params.messages as Array<{ role: string; content: unknown }>;
        const tools = (params.tools as Array<{ name: string; defer_loading?: boolean }>) ?? [];
        const loaded = new Set(tools.filter((item) => !item.defer_loading).map((item) => item.name));
        const called: string[] = [];
        let lastWasSearch = false;
        for (const message of messages) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_use') {
              called.push(String(block.name));
              lastWasSearch = block.name === 'search_tools';
            }
            if (block.type === 'tool_result') {
              for (const inner of (block.content as Array<Record<string, unknown>>) ?? []) {
                if (inner.type === 'tool_reference') loaded.add(String(inner.tool_name));
              }
            }
          }
        }
        const first = messages.find((message) => message.role === 'user')?.content;
        const move = oracle(plans, { task: String(first), called, lastWasSearch, loaded });
        return 'say' in move
          ? {
              model: 'claude-sonnet-5-5',
              content: [{ type: 'text', text: move.say }],
              stop_reason: 'end_turn',
              usage: {},
            }
          : {
              model: 'claude-sonnet-5-5',
              content: [{ type: 'tool_use', id: `t${++ids}`, name: move.call, input: move.args }],
              stop_reason: 'tool_use',
              usage: {},
            };
      },
    },
  };
}

function openaiClient(plans: Map<string, string[]>, wires: Array<Record<string, unknown>>) {
  return {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          wires.push(params);
          const messages = params.messages as Array<Record<string, unknown>>;
          const loaded = new Set(
            ((params.tools as Array<{ function: { name: string } }>) ?? []).map((item) => item.function.name),
          );
          const calls = messages.flatMap(
            (message) => (message.tool_calls as Array<{ function: { name: string } }> | undefined) ?? [],
          );
          const called = calls.map((made) => made.function.name);
          const move = oracle(plans, {
            task: String(messages.find((message) => message.role === 'user')?.content),
            called,
            lastWasSearch: called.at(-1) === 'search_tools',
            loaded,
          });
          return 'say' in move
            ? { model: 'gpt-4o', choices: [{ message: { content: move.say }, finish_reason: 'stop' }] }
            : {
                model: 'gpt-4o',
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: `o${++ids}`,
                          type: 'function',
                          function: { name: move.call, arguments: JSON.stringify(move.args) },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              };
        },
      },
    },
  };
}

function googleFetch(plans: Map<string, string[]>, wires: Array<Record<string, unknown>>): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    wires.push(body);
    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const declarations =
      (body.tools as Array<{ functionDeclarations?: Array<{ name: string }> }> | undefined)?.[0]
        ?.functionDeclarations ?? [];
    const called = contents.flatMap((content) =>
      content.parts.flatMap((part) =>
        part.functionCall ? [String((part.functionCall as { name: string }).name)] : [],
      ),
    );
    const move = oracle(plans, {
      task: String(contents[0]?.parts[0]?.text),
      called,
      lastWasSearch: called.at(-1) === 'search_tools',
      loaded: new Set(declarations.map((item) => item.name)),
    });
    const parts = 'say' in move ? [{ text: move.say }] : [{ functionCall: { name: move.call, args: move.args } }];
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

/** Runs every task on one client, and reports how many finished their plan exactly. */
async function experiment(client: { complete: AnthropicProvider['complete'] }, model: string, taskList: Task[]) {
  const tools = catalog();
  let passed = 0;
  for (const task of taskList) {
    const agent = createAgent({ client, model, tools, maxIterations: 8 });
    const run = await agent.invoke(agentInput(task.text));
    const called = run.state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .map((made) => made.function.name)
      .filter((name) => name !== 'search_tools');
    if (run.state.answer === 'Done.' && JSON.stringify(called) === JSON.stringify(task.plan)) passed += 1;
  }
  return passed / taskList.length;
}

test('the search ranks the tool a step describes first, among 500', () => {
  const tools = catalog();
  assert.equal(tools.length, 500);
  let first = 0;
  for (const candidate of tools) {
    const hits = searchTools(tools, candidate.name.split('_').join(' '));
    if (hits[0]?.tool.name === candidate.name) first += 1;
  }
  assert.equal(first, 500);
  assert.deepEqual(searchTools(tools, 'xylophone'), []);
});

test('the search tool answers with tool references and a list the model reads', async () => {
  const search = toolSearchTool(catalog());
  assert.match(search.description, /among 500 more tools/);
  const output = (await search.execute?.({ query: 'schedule a venue', limit: 2 })) as ToolOutput;
  assert.equal(output.content.length, 3);
  assert.match(
    output.content[0]?.type === 'text' ? output.content[0].text : '',
    /^Found 2, which you can call now:\n- events_schedule_venue/,
  );
  assert.deepEqual(output.content[1], { type: 'tool_reference', name: 'events_schedule_venue' });
  const none = (await search.execute?.({ query: 'xylophone' })) as ToolOutput;
  assert.deepEqual(none.content, [{ type: 'text', text: 'No tool matches "xylophone". Try other words.' }]);
});

test('an agent with 500 deferred tools finishes every task on Anthropic, OpenAI, and Google', async () => {
  const taskList = tasks();
  const plans = new Map(taskList.map((task) => [task.text, task.plan]));

  const anthropicWires: Array<Record<string, unknown>> = [];
  const anthropic = new AnthropicProvider({ apiKey: 'test' });
  (anthropic as unknown as { client: unknown }).client = anthropicClient(plans, anthropicWires);
  assert.equal(await experiment(anthropic, 'claude-sonnet-5-5', taskList), 1);

  const openaiWires: Array<Record<string, unknown>> = [];
  const openai = new OpenAIProvider({ apiKey: 'test' });
  (openai as unknown as { client: unknown }).client = openaiClient(plans, openaiWires);
  assert.equal(await experiment(openai, 'gpt-4o', taskList), 1);

  const googleWires: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = googleFetch(plans, googleWires);
  try {
    assert.equal(await experiment(new GoogleProvider({ apiKey: 'test' }), 'gemini-3.5-flash', taskList), 1);
  } finally {
    globalThis.fetch = original;
  }

  // Anthropic is sent every tool on every call, the 500 deferred, so the tool list never changes.
  for (const wire of anthropicWires) {
    const tools = wire.tools as Array<{ name: string; defer_loading?: boolean }>;
    assert.equal(tools.length, 501);
    assert.equal(tools.filter((item) => item.defer_loading).length, 500);
    assert.equal(tools.find((item) => !item.defer_loading)?.name, 'search_tools');
  }
  // The others are sent the search and what it has found: never more than a step's search adds.
  const largest = (wires: Array<Record<string, unknown>>, count: (wire: Record<string, unknown>) => number) =>
    Math.max(...wires.map(count));
  assert.ok(largest(openaiWires, (wire) => (wire.tools as unknown[]).length) <= 11);
  assert.ok(
    largest(
      googleWires,
      (wire) => (wire.tools as Array<{ functionDeclarations: unknown[] }>)[0]?.functionDeclarations.length ?? 0,
    ) <= 11,
  );
});

test('a Claude model before 4.5 is sent only the tools found, and no tool references', async () => {
  const taskList = tasks().slice(0, 3);
  const plans = new Map(taskList.map((task) => [task.text, task.plan]));
  const wires: Array<Record<string, unknown>> = [];
  const provider = new AnthropicProvider({ apiKey: 'test' });
  (provider as unknown as { client: unknown }).client = anthropicClient(plans, wires);
  assert.equal(await experiment(provider, 'claude-opus-4-1', taskList), 1);
  for (const wire of wires) {
    const tools = wire.tools as Array<{ defer_loading?: boolean }>;
    assert.ok(tools.length <= 6 && tools.every((item) => !item.defer_loading));
    assert.doesNotMatch(JSON.stringify(wire.messages), /tool_reference/);
  }
});

test('an agent without deferred tools offers no search', async () => {
  let offered: string[] = [];
  const agent = createAgent({
    client: {
      complete: async (request) => {
        offered = request.tools?.map((item) => item.name) ?? [];
        return { content: 'ok', role: 'assistant', finishReason: 'stop', meta: {} as never };
      },
    },
    tools: [
      tool({
        name: 'lookup',
        description: 'Looks up',
        parameters: { type: 'object', properties: {} },
        execute: () => 'found',
      }),
    ],
  });
  await agent.invoke(agentInput('hi'));
  assert.deepEqual(offered, ['lookup']);
});
