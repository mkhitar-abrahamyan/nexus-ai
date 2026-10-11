/**
 * Tools that depend on the run: a tool source supplies them per run, by thread and principal, and the
 * agent offers and runs them like its own, which still win a name and still pass its permission policy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput, createAgent, type ToolSourceContext } from '../src/agent/create-agent.js';
import { permissionPolicy } from '../src/agent/permissions.js';
import { tool } from '../src/agent/tool.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

function calling(name: string) {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      async complete(request: CompletionRequest) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: '',
            role: 'assistant',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'c1', type: 'function', function: { name, arguments: '{"path":"notes.md"}' } }],
            meta: {},
          } as unknown as NexusResponse;
        }
        return {
          content: String(request.messages.at(-1)?.content),
          role: 'assistant',
          finishReason: 'stop',
          meta: {},
        } as NexusResponse;
      },
    },
  };
}

const readFor = (owner: string) =>
  tool({
    name: 'read_note',
    description: `Reads ${owner}'s notes`,
    parameters: { type: 'object' },
    capabilities: (args) => [`filesystem:read:${String(args.path)}`],
    execute: async (args) => `${owner}:${String(args.path)}`,
  });

test('a tool source supplies tools per run, which the agent offers and runs', async () => {
  const asked: ToolSourceContext[] = [];
  const { client, requests } = calling('read_note');
  const agent = createAgent({
    client,
    model: 'mock',
    toolSource: (context) => {
      asked.push(context);
      return [readFor(context.principal?.userId ?? 'nobody')];
    },
  });
  const result = await agent.invoke(agentInput('read my notes'), {
    threadId: 'session-1',
    principal: { userId: 'ana', tenantId: 'acme' },
  });
  assert.equal(result.state.answer, '"ana:notes.md"');
  assert.deepEqual(
    requests[0]?.tools?.map((item) => item.name),
    ['read_note'],
  );
  assert.equal(asked[0]?.threadId, 'session-1');
  assert.equal(asked[0]?.principal?.userId, 'ana');
  assert.equal(asked[0]?.tenantId, 'acme');
  assert.ok(asked[0]?.signal instanceof AbortSignal);
});

test('the agent’s own tool wins a name, and a source’s tool passes the permission policy', async () => {
  const own = tool({
    name: 'read_note',
    description: 'The agent’s own',
    parameters: { type: 'object' },
    execute: async () => 'own',
  });
  const { client } = calling('read_note');
  const agent = createAgent({ client, model: 'mock', tools: [own], toolSource: () => [readFor('source')] });
  assert.equal((await agent.invoke(agentInput('read'))).state.answer, '"own"');

  const denied = calling('read_note');
  const guarded = createAgent({
    client: denied.client,
    model: 'mock',
    toolSource: () => [readFor('source')],
    // Reading is granted elsewhere only, so this read is denied.
    permissions: permissionPolicy({ filesystem: { read: ['/elsewhere/**'] } }),
  });
  const refused = await guarded.invoke(agentInput('read'));
  assert.match(refused.state.answer, /Permission denied/);
});
