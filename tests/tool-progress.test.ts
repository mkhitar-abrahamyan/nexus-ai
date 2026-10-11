/**
 * Tool progress, end to end: a tool reports progress while it runs, with `stream` or with
 * `context.progress`, and each report reaches the event stream, the server's events, AG-UI, A2A, ACP,
 * MCP, and traces, in order and before the result. "While it runs" is proven by a tool that will not
 * go on until a reader has seen its first report: a stream that held reports until the end would
 * never finish.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { ToolExecutor, tool } from '../src/agent/tool.js';
import { McpClient } from '../src/mcp/client.js';
import type { JsonRpcMessage, McpTransport } from '../src/mcp/protocol.js';
import { McpServer } from '../src/mcp/server.js';
import { a2aHandler } from '../src/protocols/a2a.js';
import { agUiEvents } from '../src/protocols/ag-ui.js';
import { graphAssistant } from '../src/server/assistant.js';
import { createAgentServer } from '../src/server/server.js';
import { traceGraph } from '../src/tracing/instrument.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { CompletionRequest, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { acpEditor } from './acp-editor.js';

/** Opens once, and fails the test rather than hanging when nothing ever opens it. */
function gate(label: string) {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    open: () => open(),
    wait: () =>
      Promise.race([
        opened,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${label}: nobody saw the first report while the tool ran`)),
            3_000,
          ).unref(),
        ),
      ]),
  };
}

/** An import that reports each file, and waits after the first until a reader has seen it. */
function importer(seen: ReturnType<typeof gate>) {
  return tool({
    name: 'import_files',
    description: 'Imports files',
    parameters: { type: 'object' },
    async *stream() {
      yield { done: 1, of: 3 };
      await seen.wait();
      yield { done: 2, of: 3 };
      yield { done: 3, of: 3 };
      return 'imported 3 files';
    },
  });
}

/** A model that calls the tool once, then answers with what it returned. */
function client() {
  let calls = 0;
  return {
    async complete(request: CompletionRequest) {
      calls += 1;
      if (calls % 2 === 1) {
        return {
          content: '',
          role: 'assistant',
          finishReason: 'tool_calls',
          toolCalls: [{ id: `call-${calls}`, type: 'function', function: { name: 'import_files', arguments: '{}' } }],
          meta: {},
        } as unknown as NexusResponse;
      }
      const result = request.messages.at(-1)?.content;
      return { content: `Done: ${String(result)}`, role: 'assistant', finishReason: 'stop', meta: {} } as NexusResponse;
    },
  };
}

const agentWith = (tools: ToolDefinition[]) => createAgent({ client: client(), model: 'mock', tools });

test('a stream tool’s progress reaches the event stream while it runs, in order, before its result', async () => {
  const seen = gate('events');
  const agent = agentWith([importer(seen)]);
  const tools: Array<{ phase: string; progress?: unknown }> = [];
  for await (const event of agent.events(agentInput('import'), { include: ['tools'] })) {
    if (event.type !== 'tools') continue;
    tools.push({
      phase: event.tool.phase,
      ...(event.tool.progress === undefined ? {} : { progress: event.tool.progress }),
    });
    if (event.tool.phase === 'progress') seen.open();
  }
  assert.deepEqual(tools, [
    { phase: 'start' },
    { phase: 'progress', progress: { done: 1, of: 3 } },
    { phase: 'progress', progress: { done: 2, of: 3 } },
    { phase: 'progress', progress: { done: 3, of: 3 } },
    { phase: 'result' },
  ]);
});

test('an execute tool reports through context.progress, and a stream tool runs anywhere a tool is executed', async () => {
  const reports: unknown[] = [];
  const counting = tool({
    name: 'count',
    description: 'Counts',
    parameters: { type: 'object' },
    execute: async (_args, context) => {
      for (let index = 1; index <= 2; index += 1) context.progress?.(`step ${index}`);
      return 'counted';
    },
  });
  const executor = new ToolExecutor([counting, importer({ open() {}, wait: async () => undefined })]);
  assert.deepEqual(await executor.execute('count', {}, { progress: (value) => reports.push(value) }), {
    ok: true,
    result: 'counted',
  });
  assert.deepEqual(reports, ['step 1', 'step 2']);
  // A stream given to an executor without anyone listening still returns its result.
  assert.deepEqual(await executor.execute('import_files', {}), { ok: true, result: 'imported 3 files' });
  // A listener that throws never fails the tool.
  const failing = await executor.execute(
    'import_files',
    {},
    {
      progress: () => {
        throw new Error('the screen is gone');
      },
    },
  );
  assert.equal(failing.ok, true);
  // A bare definition with only a stream runs too, and so does its execute from tool().
  const bare: ToolDefinition = {
    name: 'bare',
    description: 'Bare',
    parameters: { type: 'object' },
    async *stream() {
      yield 'half';
      return 'whole';
    },
  };
  assert.deepEqual(await new ToolExecutor([bare]).execute('bare', {}), { ok: true, result: 'whole' });
  const drained: unknown[] = [];
  const built = importer({ open() {}, wait: async () => undefined });
  assert.equal(await built.execute?.({}, { progress: (value) => drained.push(value) }), 'imported 3 files');
  assert.equal(drained.length, 3);
});

test('progress reaches AG-UI as custom events, A2A as working status, and ACP as tool call updates', async () => {
  // AG-UI: a custom tool_progress event per report, between the call and its result.
  const agUi = gate('AG-UI');
  const events: Array<Record<string, unknown>> = [];
  for await (const event of agUiEvents(agentWith([importer(agUi)]), {
    threadId: 't-ag',
    runId: 'r-ag',
    messages: [{ id: 'm1', role: 'user', content: 'import' }],
  })) {
    events.push(event);
    if (event.type === 'CUSTOM') agUi.open();
  }
  const types = events.map((event) => event.type);
  const progressAt = types.indexOf('CUSTOM');
  assert.ok(progressAt > types.indexOf('TOOL_CALL_END') && progressAt < types.indexOf('TOOL_CALL_RESULT'));
  assert.deepEqual(
    events.filter((event) => event.type === 'CUSTOM').map((event) => (event.value as { progress: unknown }).progress),
    [
      { done: 1, of: 3 },
      { done: 2, of: 3 },
      { done: 3, of: 3 },
    ],
  );
  assert.equal(events.find((event) => event.type === 'CUSTOM')?.name, 'tool_progress');

  // A2A: a working status update per report, before the task completes.
  const a2a = gate('A2A');
  const handler = a2aHandler(agentWith([importer(a2a)]), {
    card: { name: 'Importer', description: 'Imports', version: '1.0.0', url: 'http://a2a.test/a2a', skills: [] },
  });
  const response = await handler(
    new Request('http://a2a.test/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendStreamingMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'import' }] } },
      }),
    }),
  );
  const states: Array<{ state: string; progress?: unknown }> = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const result = JSON.parse(frame.slice(frame.indexOf('{'))).result as {
        statusUpdate?: { status: { state: string; message?: { parts: Array<{ data?: { progress?: unknown } }> } } };
      };
      if (!result.statusUpdate) continue;
      const progress = result.statusUpdate.status.message?.parts.find((part) => part.data)?.data?.progress;
      states.push({ state: result.statusUpdate.status.state, ...(progress ? { progress } : {}) });
      if (progress) a2a.open();
    }
  }
  assert.deepEqual(states, [
    { state: 'TASK_STATE_WORKING', progress: { done: 1, of: 3 } },
    { state: 'TASK_STATE_WORKING', progress: { done: 2, of: 3 } },
    { state: 'TASK_STATE_WORKING', progress: { done: 3, of: 3 } },
    { state: 'TASK_STATE_COMPLETED' },
  ]);

  // ACP: the tool call the editor shows is updated in progress, then completed.
  const acp = gate('ACP');
  const editor = acpEditor(agentWith([importer(acp)]));
  await editor.request('initialize', { protocolVersion: 1 });
  const { result } = await editor.request('session/new', { cwd: '/work', mcpServers: [] });
  const watching = setInterval(() => {
    if (editor.updates.some((update) => update.status === 'in_progress' && update.sessionUpdate === 'tool_call_update'))
      acp.open();
  }, 2);
  await editor.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'import' }] });
  clearInterval(watching);
  editor.close();
  const calls = editor.updates.filter((update) => update.sessionUpdate.startsWith('tool_call'));
  assert.deepEqual(
    calls.map((update) => update.status),
    ['in_progress', 'in_progress', 'in_progress', 'in_progress', 'completed'],
  );
  assert.match(JSON.stringify(calls[1]?.content), /\\"done\\":1/);
});

test('progress reaches the server’s run events, traces, and an MCP client calling a stream tool', async () => {
  // The server's event stream, for a graph assistant asked to record tool events.
  const seen = gate('server');
  const app = createAgentServer({
    assistants: { importer: graphAssistant(agentWith([importer(seen)]), { events: ['tools'] }) },
  });
  const response = await app.handle(
    new Request('http://server.test/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assistant: 'importer', input: agentInput('import'), stream: true }),
    }),
  );
  const phases: string[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice(5)) as { type: string; data: { tool?: { phase: string } } };
      if (event.type !== 'tools') continue;
      phases.push(event.data.tool?.phase ?? '');
      if (event.data.tool?.phase === 'progress') seen.open();
    }
  }
  assert.deepEqual(phases, ['start', 'progress', 'progress', 'progress', 'result']);

  // Traces: the tool's run keeps its progress, in order.
  const store = new MemoryTraceStore();
  const tracer = new Tracer({ store });
  const tracing = traceGraph(tracer, { name: 'importer', kind: 'agent' });
  const traced = agentWith([importer({ open() {}, wait: async () => undefined })]);
  const result = await traced.invoke(agentInput('import'), { threadId: 'traced', ...tracing.runOptions });
  await tracing.finish(result as never);
  const [toolRun] = store.query({ kind: 'tool' });
  const progress = toolRun?.metadata?.progress as Array<{ at: string; progress: unknown }>;
  assert.deepEqual(
    progress.map((report) => report.progress),
    [
      { done: 1, of: 3 },
      { done: 2, of: 3 },
      { done: 3, of: 3 },
    ],
  );
  assert.ok(progress.every((report) => !Number.isNaN(Date.parse(report.at))));
  assert.equal(toolRun?.metadata?.callId, 'call-1', 'the call id stays beside it');

  // MCP: a stream tool served over MCP reports as notifications/progress, and an agent's MCP tool
  // passes them on to its own progress.
  let toClient: (message: JsonRpcMessage) => void = () => undefined;
  let toServer: (message: JsonRpcMessage) => void = () => undefined;
  const clientSide: McpTransport = {
    send: (message) => toServer(message),
    onMessage: (handler) => {
      toClient = handler;
    },
    close: () => undefined,
  };
  const serverSide: McpTransport = {
    send: (message) => toClient(message),
    onMessage: (handler) => {
      toServer = handler;
    },
    close: () => undefined,
  };
  await new McpServer({ tools: [importer({ open() {}, wait: async () => undefined })] }).connect(serverSide);
  const mcp = new McpClient(clientSide, { timeoutMs: 2_000 });
  const [remote] = await mcp.toNexusTools();
  const reports: unknown[] = [];
  assert.equal(await remote?.execute?.({}, { progress: (value) => reports.push(value) }), 'imported 3 files');
  assert.deepEqual(reports, [
    { progress: 1, message: '{"done":1,"of":3}' },
    { progress: 2, message: '{"done":2,"of":3}' },
    { progress: 3, message: '{"done":3,"of":3}' },
  ]);
  // Without a listener, no token is asked for, and nothing is reported.
  assert.equal((await mcp.callTool('import_files')).content[0]?.text, 'imported 3 files');
});
