/**
 * The interpreter contract, proved on the reference worker interpreter: it passes the conformance
 * suite; its limits hold; and an agent calls its tools from code in one step, with every call the
 * code makes decided by the same permission policy as the model's own calls.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { codeTool, runInterpreterConformance, workerInterpreter } from '../src/agent/interpreter.js';
import { permissionPolicy } from '../src/agent/permissions.js';
import { processSandbox } from '../src/agent/sandbox.js';
import { tool, toolOutput } from '../src/agent/tool.js';
import { createDeepAgent } from '../src/deep-agent/index.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

test('the worker interpreter passes the interpreter conformance suite', async () => {
  const report = await runInterpreterConformance(workerInterpreter());
  assert.equal(
    report.passed,
    true,
    report.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join('\n'),
  );
  assert.equal(report.checks.length, 5);
});

test('the worker interpreter caps calls and logs, stops when aborted, and reports a value it cannot clone', async () => {
  const interpreter = workerInterpreter({ maxCalls: 3, maxLogChars: 10 });
  const echo = async (args: Record<string, unknown>) => args;
  const capped = await interpreter.run(
    `const seen = [];
     for (let i = 0; i < 5; i++) {
       try { await tools.echo({ i }); seen.push(i); } catch (error) { seen.push(error.message); }
     }
     console.log('a'.repeat(8)); console.log('b'.repeat(8));
     return seen;`,
    { tools: { echo } },
  );
  assert.deepEqual(capped.value, [0, 1, 2, 'The code made more than 3 calls', 'The code made more than 3 calls']);
  assert.deepEqual(capped.logs, ['aaaaaaaa', 'bb'], 'logs stop at the limit');
  assert.equal(capped.calls.filter((call) => call.ok).length, 3);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const aborted = await interpreter.run('await new Promise(() => {});', { signal: controller.signal });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.timedOut, false);
  assert.match(aborted.error ?? '', /aborted/);

  const unclonable = await interpreter.run('return { at: 1, run: () => 2 };');
  assert.equal(unclonable.ok, true);
  assert.equal(typeof unclonable.value, 'string', 'a value with a function comes back as text');
});

const meta = {
  requestId: 'r',
  providerUsed: 'mock',
  modelUsed: 'mock',
  latencyMs: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensSaved: 0,
  cacheHit: false,
  guardrailsApplied: [],
};

test('an agent calls its tools from code in one step, each call decided by its permission policy', async () => {
  const lookups: unknown[] = [];
  const refunds: unknown[] = [];
  const lookupOrder = tool<{ id: string }>({
    name: 'lookup_order',
    description: 'Looks up an order by id',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    capabilities: ['orders:read'],
    execute: ({ id }) => {
      lookups.push(id);
      return { id, total: Number(id.slice(1)) * 10 };
    },
  });
  const describeOrder = tool<{ id: string }>({
    name: 'describe_order',
    description: 'Describes an order',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    capabilities: ['orders:read'],
    execute: ({ id }) => toolOutput(`Order ${id}, shipped.`),
  });
  const refundOrder = tool<{ id: string }>({
    name: 'refund_order',
    description: 'Refunds an order',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    capabilities: ['payments:refund'],
    execute: ({ id }) => {
      refunds.push(id);
      return { refunded: id };
    },
  });
  const tools = [lookupOrder, describeOrder, refundOrder];
  const permissions = permissionPolicy({ code: 'allow', custom: { orders: 'allow', payments: 'ask' } });
  const runCode = codeTool(workerInterpreter(), { tools, permissions });
  assert.match(runCode.description, /lookup_order\(.*\): Looks up an order by id/);

  const requests: CompletionRequest[] = [];
  const code = `
    const orders = await Promise.all(['A1', 'A2', 'A3'].map((id) => tools.lookup_order({ id })));
    const note = await tools.describe_order({ id: 'A1' });
    let refund = '';
    try { await tools.refund_order({ id: 'A2' }); } catch (error) { refund = error.message; }
    console.log('looked up', orders.length);
    return { total: orders.reduce((sum, order) => sum + order.total, 0), note, refund };`;
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const result = request.messages.find((message) => message.role === 'tool');
      if (!result) {
        return {
          content: '',
          role: 'assistant',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code }) } },
          ],
          finishReason: 'tool_calls',
          meta,
        };
      }
      return { content: String(result.content), role: 'assistant', finishReason: 'stop', meta };
    },
  };

  const agent = createAgent({ client: model, model: 'mock', tools: [runCode, ...tools], permissions });
  const run = await agent.invoke(agentInput('Total the three orders, and refund A2.'), { threadId: 'orders' });
  assert.equal(run.status, 'completed');
  assert.equal(requests.length, 2, 'three lookups, a description, and a refused refund took one model round trip');
  const reported = JSON.parse(run.state.answer) as Record<string, unknown>;
  assert.deepEqual(reported, {
    ok: true,
    value: {
      total: 60,
      note: 'Order A1, shipped.',
      refund: "refund_order needs a person's approval, so call it directly: payments:refund needs approval",
    },
    logs: ['looked up 3'],
    calls: ['lookup_order', 'lookup_order', 'lookup_order', 'describe_order', 'refund_order (failed)'],
  });
  assert.deepEqual(lookups.sort(), ['A1', 'A2', 'A3']);
  assert.deepEqual(refunds, [], 'the refund the policy asks about never ran from code');
});

test('a deep agent given an interpreter searches and reads its workspace from code, under its own policy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexus-interpreter-'));
  try {
    const sandbox = processSandbox({ root });
    await sandbox.writeFile('src/a.ts', '// TODO: one\nconst a = 1;\n');
    await sandbox.writeFile('src/b.ts', '// TODO: two\n// TODO: three\n');
    const code = `
      const files = (await tools.glob_files({ pattern: '**/*.ts' })).split('\\n');
      const texts = await Promise.all(files.map((path) => tools.read_file({ path })));
      let refused = '';
      try { await tools.run_command({ command: 'curl https://example.com' }); } catch (error) { refused = error.message; }
      return { files, todos: texts.join('').split('TODO').length - 1, refused };`;
    const requests: CompletionRequest[] = [];
    const model = {
      complete: async (request: CompletionRequest): Promise<NexusResponse> => {
        requests.push(request);
        const result = request.messages.find((message) => message.role === 'tool');
        if (!result) {
          return {
            content: '',
            role: 'assistant',
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code }) } },
            ],
            finishReason: 'tool_calls',
            meta,
          };
        }
        return { content: String(result.content), role: 'assistant', finishReason: 'stop', meta };
      },
    };
    const agent = createDeepAgent({
      client: model,
      planning: false,
      sandbox,
      commands: ['node'],
      interpreter: workerInterpreter(),
    });
    const run = await agent.invoke(agentInput('Count the TODOs.'), { threadId: 'todos' });
    const reported = JSON.parse(run.state.answer) as { ok: boolean; value: Record<string, unknown> };
    assert.equal(reported.ok, true, JSON.stringify(reported));
    assert.deepEqual(reported.value.files, ['src/a.ts', 'src/b.ts']);
    assert.equal(reported.value.todos, 3);
    assert.match(String(reported.value.refused), /Permission denied/);
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.tools?.some((offered) => offered.name === 'run_code'));
    assert.match(String(requests[0]?.messages[0]?.content), /write JavaScript for run_code/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('code does not run at all unless the policy grants code', async () => {
  const runCode = codeTool(workerInterpreter(), { tools: [] });
  assert.deepEqual(runCode.capabilities, ['code']);
  const verdict = permissionPolicy({}).decide({ tool: 'run_code', args: { code: '1' }, capabilities: ['code'] });
  assert.equal(verdict.decision, 'deny');
  const denied = permissionPolicy({ custom: { orders: 'allow' } }).decide({
    tool: 'lookup_order',
    args: {},
    capabilities: ['payments:refund'],
  });
  assert.equal(denied.decision, 'deny', 'an ungranted capability is denied inside code as outside it');
});
