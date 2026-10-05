/**
 * The proof for `toolSelector()`: an agent over 150 tools completes a task set at equal quality,
 * sending a fraction of the tokens, measured end to end and reported by an experiment.
 *
 * The model is an oracle that knows each task's plan but can only call a tool it was offered, so
 * quality measures exactly what the selector risks: leaving out a tool the task needs. Tokens are
 * counted on the requests actually sent. Latency is measured end to end, with model time that grows
 * with the input as a provider's time to first token does, and the selector's own work included.
 * The embedding is a lexical one, so the run is deterministic and needs no network; a real
 * embedding model drops into `embed` unchanged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { estimateRequestTokens, type ToolSelection, toolSelector } from '../src/agent/middleware/index.js';
import { tool } from '../src/agent/tool.js';
import { compareExperiments, formatComparison } from '../src/evaluate/compare.js';
import { createDataset } from '../src/evaluate/datasets.js';
import { evaluate } from '../src/evaluate/run.js';
import type { CompletionRequest, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const DOMAINS = [
  ['calendar', 'event', 'the team calendar'],
  ['email', 'message', 'the mailbox'],
  ['crm', 'customer', 'the customer database'],
  ['github', 'issue', 'the code repository'],
  ['files', 'document', 'shared drive storage'],
  ['payments', 'invoice', 'the billing system'],
  ['weather', 'forecast', 'the weather service'],
  ['analytics', 'report', 'the analytics warehouse'],
  ['support', 'ticket', 'the helpdesk queue'],
  ['inventory', 'product', 'the warehouse stock'],
  ['hr', 'employee', 'the people directory'],
  ['travel', 'flight', 'the booking service'],
  ['chat', 'channel', 'the team chat'],
  ['database', 'record', 'the operational tables'],
  ['monitoring', 'alert', 'the observability platform'],
] as const;
const ACTIONS = [
  ['create', 'Creates a new'],
  ['get', 'Gets one'],
  ['list', 'Lists every'],
  ['update', 'Updates the fields of a'],
  ['delete', 'Deletes a'],
  ['search', 'Searches for a'],
  ['archive', 'Archives an old'],
  ['share', 'Shares a'],
  ['export', 'Exports a'],
  ['summarize', 'Summarizes a'],
] as const;

/** 150 tools with schemas the size real integrations have: six documented parameters each. */
function catalog(): ToolDefinition[] {
  return DOMAINS.flatMap(([domain, noun, place]) =>
    ACTIONS.map(([action, phrase]) =>
      tool({
        name: `${domain}_${action}_${noun}`,
        description: `${phrase} ${noun} in ${place}. Use it to ${action} a ${domain} ${noun}.`,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: `The ${noun} identifier, as ${place} returns it` },
            query: { type: 'string', description: `Free text matched against the ${noun} title and body` },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: `Which ${noun} fields to return or change`,
            },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'The most results to return' },
            cursor: { type: 'string', description: 'Continues a previous page of results' },
            dryRun: { type: 'boolean', description: 'Validates the request without changing anything' },
          },
          required: action === 'list' ? [] : ['id'],
        },
        execute: async (args) => ({ ok: true, tool: `${domain}_${action}_${noun}`, args }),
      }),
    ),
  );
}

interface Task {
  text: string;
  plan: string[];
}

/** 40 tasks: 25 that need one tool and 15 that need two, across every domain. */
function tasks(): Task[] {
  const list: Task[] = [];
  for (let index = 0; index < 25; index += 1) {
    const [domain, noun, place] = DOMAINS[index % DOMAINS.length] as (typeof DOMAINS)[number];
    const [action] = ACTIONS[(index * 3) % ACTIONS.length] as (typeof ACTIONS)[number];
    list.push({
      text: `Please ${action} the ${domain} ${noun} named item-${index} in ${place}.`,
      plan: [`${domain}_${action}_${noun}`],
    });
  }
  for (let index = 0; index < 15; index += 1) {
    const [d1, n1, p1] = DOMAINS[index % DOMAINS.length] as (typeof DOMAINS)[number];
    const [d2, n2] = DOMAINS[(index + 5) % DOMAINS.length] as (typeof DOMAINS)[number];
    const [a1] = ACTIONS[index % ACTIONS.length] as (typeof ACTIONS)[number];
    const [a2] = ACTIONS[(index + 4) % ACTIONS.length] as (typeof ACTIONS)[number];
    list.push({
      text: `First ${a1} the ${d1} ${n1} for the launch in ${p1}, then ${a2} the related ${d2} ${n2}.`,
      plan: [`${d1}_${a1}_${n1}`, `${d2}_${a2}_${n2}`],
    });
  }
  return list;
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'in',
  'of',
  'for',
  'to',
  'it',
  'use',
  'then',
  'first',
  'please',
  'one',
  'every',
  'new',
  'old',
  'named',
  'related',
  'launch',
  'item',
]);
/** A lexical embedding: hashed, lightly stemmed words without stop words, in 512 dimensions. */
function lexicalEmbed(texts: string[]): number[][] {
  return texts.map((text) => {
    const vector = new Array(512).fill(0);
    for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (STOP.has(raw)) continue;
      const word = raw.replace(/(?:es|s|d)$/, '').replace(/e$/, '');
      let hash = 7;
      for (const char of word) hash = (hash * 131 + char.charCodeAt(0)) % 512;
      vector[hash] += 1;
    }
    return vector;
  });
}

/** Model time grows with input: 2 ms, plus 1 ms per 2,000 input tokens, as prefill does. */
const modelMs = (inputTokens: number) => 2 + inputTokens / 2_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RunOutput {
  answer: string;
  called: string[];
  inputTokens: number;
  modelCalls: number;
}

/** The oracle: calls the next tool of the task's plan when it was offered, and gives up when it was not. */
function oracle(plans: Map<string, string[]>, usage: { inputTokens: number; modelCalls: number }) {
  return {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      const tokens = estimateRequestTokens(request);
      usage.inputTokens += tokens;
      usage.modelCalls += 1;
      await sleep(modelMs(tokens));
      const task = String(request.messages.find((message) => message.role === 'user')?.content ?? '');
      const plan = plans.get(task) ?? [];
      const done = request.messages.filter((message) => message.role === 'tool').length;
      const next = plan[done];
      const base = { role: 'assistant' as const, meta: {} as never };
      if (next === undefined) return { ...base, content: 'Done.', finishReason: 'stop' };
      if (!request.tools?.some((offered) => offered.name === next)) {
        return { ...base, content: `I cannot do this: no tool for ${next}.`, finishReason: 'stop' };
      }
      return {
        ...base,
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: `call-${done}`, type: 'function', function: { name: next, arguments: '{"id":"x"}' } }],
      };
    },
  };
}

test('toolSelector over 150 tools: equal quality, a fraction of the tokens, and lower latency', async (t) => {
  const tools = catalog();
  assert.equal(tools.length, 150);
  const taskList = tasks();
  const plans = new Map(taskList.map((task) => [task.text, task.plan]));
  const dataset = createDataset<{ text: string }, string[]>({
    name: 'tool-selection-150',
    examples: taskList.map((task, index) => ({
      id: `task-${index + 1}`,
      inputs: { text: task.text },
      expected: task.plan,
    })),
  });

  const selections: ToolSelection[] = [];
  const target =
    (withSelector: boolean) =>
    async (inputs: { text: string }): Promise<RunOutput> => {
      const usage = { inputTokens: 0, modelCalls: 0 };
      const agent = createAgent({
        client: oracle(plans, usage),
        tools,
        middleware: withSelector
          ? [toolSelector({ embed: lexicalEmbed, maxTools: 12, onSelect: (selection) => selections.push(selection) })]
          : [],
      });
      const result = await agent.invoke(agentInput(inputs.text));
      const called = result.state.messages.flatMap(
        (message) => message.toolCalls?.map((made) => made.function.name) ?? [],
      );
      return { answer: result.state.answer, called, ...usage };
    };
  const evaluators = [
    ({ output, example }: { output: unknown; example: { expected?: string[] } }) => ({
      key: 'success',
      score:
        (output as RunOutput).answer === 'Done.' &&
        JSON.stringify((output as RunOutput).called) === JSON.stringify(example.expected)
          ? 1
          : 0,
    }),
    ({ output }: { output: unknown }) => ({ key: 'input-tokens', score: (output as RunOutput).inputTokens }),
    ({ latencyMs }: { latencyMs: number }) => ({ key: 'latency', score: latencyMs }),
  ];

  const all = await evaluate(target(false), dataset, evaluators, { name: 'all 150 tools', concurrency: 4 });
  const selected = await evaluate(target(true), dataset, evaluators, {
    name: 'toolSelector, 12 tools',
    concurrency: 4,
  });
  const comparison = compareExperiments(all, selected, { lowerIsBetter: ['latency', 'input-tokens'] });
  t.diagnostic(formatComparison(comparison));

  const metric = (key: string) => comparison.metrics.find((entry) => entry.key === key);
  const success = metric('success');
  const tokens = metric('input-tokens');
  const latency = metric('latency');
  assert.equal(success?.baseline, 1, 'every task succeeds with every tool offered');
  assert.equal(success?.candidate, 1, 'and every task still succeeds with the selector');
  assert.equal(success?.verdict, 'unchanged');
  assert.ok(
    tokens && tokens.candidate < tokens.baseline * 0.2,
    `input tokens cut by more than 80%: ${tokens?.baseline} -> ${tokens?.candidate}`,
  );
  assert.equal(tokens?.verdict, 'better');
  assert.ok(
    latency && latency.candidate < latency.baseline * 0.7,
    `latency cut by more than 30%: ${latency?.baseline} -> ${latency?.candidate}`,
  );
  assert.equal(latency?.verdict, 'better');
  assert.equal(comparison.regressed, false);
  assert.ok(selections.every((selection) => selection.offered === 150 && selection.selected.length <= 12));
  t.diagnostic(
    `input tokens per task: ${Math.round(tokens?.baseline ?? 0)} -> ${Math.round(tokens?.candidate ?? 0)}; ` +
      `latency per task: ${(latency?.baseline ?? 0).toFixed(1)} ms -> ${(latency?.candidate ?? 0).toFixed(1)} ms`,
  );
});
