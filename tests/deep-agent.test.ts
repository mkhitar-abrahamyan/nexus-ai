/**
 * The deep-agent preset, proved on a fixture repository inside the reference sandbox: the agent plans,
 * runs the failing test, reads and edits the code, verifies the fix, delegates a review to a helper,
 * loads a skill, and records the change.
 *
 * The model is scripted, but it reacts to what its tools return: it learns the test fails from the
 * command's output, finds the bug in the file it read, and decides it is done when the test passes.
 * Along the way the agent's own machinery is exercised for real:
 * - instruction files reach the model;
 * - a 30,000-character log is offloaded to a file;
 * - the plan survives in the transcript;
 * - the helper works in the same sandbox;
 * - the permission policy refuses what was not granted.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { agentInput } from '../src/agent/create-agent.js';
import { processSandbox } from '../src/agent/sandbox.js';
import { tool } from '../src/agent/tool.js';
import { createDeepAgent } from '../src/deep-agent/index.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-deep-agent-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function fixtureRepository(name: string) {
  const root = path.join(scratch, name);
  const sandbox = processSandbox({ root, timeoutMs: 20_000 });
  await sandbox.writeFile('AGENTS.md', 'Run the tests with `node test.js`. Record every fix in CHANGES.md.');
  await sandbox.writeFile('src/math.js', 'exports.add = (a, b) => a - b;\nexports.double = (a) => a * 2;\n');
  await sandbox.writeFile(
    'test.js',
    [
      "const { add } = require('./src/math.js');",
      'const ok = add(2, 3) === 5;',
      "console.log(ok ? 'PASS' : 'FAIL: add(2, 3) returned ' + add(2, 3));",
      "console.log('debug: ' + 'x'.repeat(30000));",
      'process.exit(ok ? 0 : 1);',
    ].join('\n'),
  );
  return { root, sandbox };
}

let ids = 0;
const call = (name: string, args: unknown) => ({
  id: `call-${++ids}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (partial: Partial<NexusResponse>): NexusResponse =>
  ({ content: '', role: 'assistant', finishReason: 'stop', meta: {} as never, ...partial }) as NexusResponse;
const textOf = (message: Message | undefined) => (typeof message?.content === 'string' ? message.content : '');

/** A scripted model that reacts to its tool results, for the main agent and its reviewer. */
function scriptedModel() {
  const requests: CompletionRequest[] = [];
  const plan = (statuses: string[]) => ({
    todos: ['Run the tests', 'Find and fix the bug', 'Verify the fix', 'Have it reviewed', 'Record the change'].map(
      (content, index) => ({ content, status: statuses[index] ?? 'pending' }),
    ),
  });
  return {
    requests,
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const system = textOf(request.messages.find((message) => message.role === 'system'));
      const results = request.messages.filter((message) => message.role === 'tool');
      const calls = request.messages.flatMap((message) => message.toolCalls ?? []);
      const called = (name: string) => calls.filter((made) => made.function.name === name);
      const resultOf = (id: string | undefined) => textOf(results.find((message) => message.toolCallId === id));

      // The reviewer: reads the file it is asked about, then answers.
      if (system.startsWith('You review changes')) {
        if (called('read_file').length === 0) return reply({ toolCalls: [call('read_file', { path: 'src/math.js' })] });
        const code = resultOf(called('read_file')[0]?.id);
        return reply({
          content: code.includes('a + b') ? 'Approved: add() now adds.' : 'Rejected: add() still subtracts.',
        });
      }

      if (called('write_todos').length === 0) return reply({ toolCalls: [call('write_todos', plan(['in_progress']))] });
      const runs = called('run_command');
      if (runs.length === 0) return reply({ toolCalls: [call('run_command', { command: 'node test.js' })] });
      const firstRun = resultOf(runs[0]?.id);
      if (called('read_file').length === 0 && firstRun.includes('FAIL')) {
        return reply({ toolCalls: [call('read_file', { path: '/workspace/src/math.js' })] });
      }
      if (called('edit_file').length === 0) {
        const code = resultOf(called('read_file')[0]?.id);
        const buggy = /exports\.add = \(a, b\) => a - b;/.exec(JSON.parse(code))?.[0];
        if (!buggy) return reply({ content: 'I could not find the bug.' });
        return reply({
          toolCalls: [
            call('edit_file', { path: 'src/math.js', old_text: buggy, new_text: buggy.replace('a - b', 'a + b') }),
            call('write_todos', plan(['completed', 'completed', 'in_progress'])),
          ],
        });
      }
      if (runs.length === 1) return reply({ toolCalls: [call('run_command', { command: 'node test.js' })] });
      if (!resultOf(runs[1]?.id).includes('PASS')) return reply({ content: 'The fix did not work.' });
      if (called('delegate').length === 0) {
        return reply({
          toolCalls: [call('delegate', { agent: 'reviewer', task: 'Review src/math.js: add() should add.' })],
        });
      }
      if (!resultOf(called('delegate')[0]?.id).includes('Approved')) return reply({ content: 'The review failed.' });
      if (called('load_skill').length === 0) return reply({ toolCalls: [call('load_skill', { name: 'changelog' })] });
      if (called('write_file').length === 0) {
        const style = resultOf(called('load_skill')[0]?.id);
        const prefix = style.includes("'- Fixed:'") ? '- Fixed:' : '-';
        return reply({
          toolCalls: [
            call('write_file', { path: 'CHANGES.md', content: `${prefix} add() subtracted instead of adding.\n` }),
          ],
        });
      }
      if (called('write_todos').length < 3) {
        return reply({
          toolCalls: [call('write_todos', plan(['completed', 'completed', 'completed', 'completed', 'completed']))],
        });
      }
      return reply({
        content: 'Fixed add() in src/math.js; the test passes, the review approved it, and CHANGES.md records it.',
      });
    },
  };
}

test('a deep agent fixes a failing test in a fixture repository, inside the reference sandbox', async () => {
  const { root, sandbox } = await fixtureRepository('repo');
  const model = scriptedModel();
  const agent = createDeepAgent({
    client: model,
    instructions: 'You maintain this repository.',
    sandbox,
    commands: ['node'],
    subagents: [
      {
        name: 'reviewer',
        description: 'Reviews a change for bugs',
        instructions: 'You review changes for bugs.',
        tools: ['read_file'],
      },
    ],
    skills: [
      {
        name: 'changelog',
        description: 'How to record a change',
        instructions: "Write each entry as a bullet starting with '- Fixed:'.",
      },
    ],
  });

  const run = await agent.invoke(agentInput('The test fails. Fix it.'), { threadId: 'fix' });
  assert.equal(run.status, 'completed');
  assert.equal(run.state.stopReason, 'completed');
  assert.match(run.state.answer, /test passes/);

  // The repository is fixed: the test passes when run again, outside the agent.
  assert.equal(
    readFileSync(path.join(root, 'src/math.js'), 'utf8'),
    'exports.add = (a, b) => a + b;\nexports.double = (a) => a * 2;\n',
  );
  const verified = await sandbox.exec('node test.js');
  assert.equal(verified.exitCode, 0);
  assert.match(verified.stdout, /^PASS/);
  assert.equal(readFileSync(path.join(root, 'CHANGES.md'), 'utf8'), '- Fixed: add() subtracted instead of adding.\n');

  // The instruction file reached the model, and the skill list was in its prompt until loaded.
  const first = model.requests[0] as CompletionRequest;
  assert.match(textOf(first.messages[0]), /You maintain this repository[\s\S]*changelog: How to record a change/);
  assert.ok(first.messages.some((message) => message.role === 'system' && textOf(message).includes('node test.js')));
  // The 30,000-character log was offloaded: the transcript holds a preview and a path.
  const firstRun = run.state.messages.find((message) => message.role === 'tool' && textOf(message).includes('FAIL'));
  assert.ok(textOf(firstRun).length < 2_000);
  assert.match(textOf(firstRun), /\.context\/run_command-call-\d+\.txt/);
  assert.ok(existsSync(path.join(root, '.context')));
  // The plan is in the transcript, finished.
  const plans = run.state.messages.filter((message) => message.role === 'tool' && textOf(message).includes('Plan ('));
  assert.match(textOf(plans.at(-1)), /Plan \(5\/5 done\)/);
  // The reviewer ran in a fresh context, in the same sandbox, with only the tool it was given.
  const reviewer = model.requests.filter((request) => textOf(request.messages[0]).startsWith('You review changes'));
  assert.equal(reviewer.length, 2);
  assert.deepEqual(
    reviewer[0]?.tools?.map((offered) => offered.name),
    ['read_file'],
  );
  assert.equal(reviewer[0]?.messages.filter((message) => message.role === 'user').length, 1);
});

test('the deep agent’s default policy grants the workspace and the named commands, and nothing else', async () => {
  const { sandbox } = await fixtureRepository('policy');
  const attempts = [
    call('run_command', { command: 'curl https://example.com' }),
    call('run_command', { command: 'node test.js; rm -rf src' }),
    call('write_file', { path: '../outside.txt', content: 'x' }),
    call('notify', { to: 'ops' }),
    call('list_files', { path: '.' }),
  ];
  let step = 0;
  const agent = createDeepAgent({
    client: { complete: async () => reply(step++ === 0 ? { toolCalls: attempts } : { content: 'done' }) },
    sandbox,
    commands: ['node'],
    planning: false,
    tools: [
      tool({
        name: 'notify',
        description: 'Notifies a team',
        parameters: { type: 'object' },
        capabilities: ['notifications:send'],
        execute: async () => 'sent',
      }),
    ],
  });
  const run = await agent.invoke(agentInput('try things'));
  const answers = run.state.messages.filter((message) => message.role === 'tool').map(textOf);
  assert.match(answers[0] ?? '', /Permission denied: shell:curl/);
  assert.match(answers[1] ?? '', /Permission denied/);
  assert.match(answers[2] ?? '', /Permission denied: filesystem:write:\/outside\.txt/);
  assert.match(answers[3] ?? '', /Permission denied: notifications:send is not granted/);
  assert.match(answers[4] ?? '', /AGENTS\.md/);
  assert.ok(!existsSync(path.join(scratch, 'outside.txt')));

  // Without commands there is no command tool at all; without a sandbox, no workspace.
  const quiet = createDeepAgent({ client: { complete: async () => reply({ content: 'ok' }) }, sandbox });
  assert.ok(!quiet.describe().tools?.some((described) => described.name === 'run_command'));
  const bare = createDeepAgent({ client: { complete: async () => reply({ content: 'ok' }) } });
  assert.deepEqual(
    bare.describe().tools?.map((described) => described.name),
    ['write_todos'],
  );
});

test('a helper never gets a tool that needs approval, since it cannot pause for one', async () => {
  const { sandbox } = await fixtureRepository('approvals');
  const seen: string[][] = [];
  const agent = createDeepAgent({
    client: {
      complete: async (request: CompletionRequest) => {
        const system = textOf(request.messages[0]);
        if (system.startsWith('You summarize')) {
          seen.push(request.tools?.map((offered) => offered.name) ?? []);
          return reply({ content: 'summary' });
        }
        const delegated = request.messages.some((message) => message.role === 'tool');
        return reply(
          delegated
            ? { content: 'done' }
            : { toolCalls: [call('delegate', { agent: 'summarizer', task: 'Summarize the repo' })] },
        );
      },
    },
    sandbox,
    planning: false,
    interruptOn: { write_file: true },
    subagents: [{ name: 'summarizer', description: 'Summarizes files', instructions: 'You summarize files.' }],
  });
  const run = await agent.invoke(agentInput('summarize'), { threadId: 'approvals' });
  assert.equal(run.state.answer, 'done');
  assert.ok(seen[0]?.includes('read_file'));
  assert.ok(!seen[0]?.includes('write_file'), 'the tool that needs approval stays with the main agent');
  assert.ok(!seen[0]?.includes('delegate'), 'and a helper cannot delegate in turn');
});
