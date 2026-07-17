import assert from 'node:assert/strict';
import test from 'node:test';
import { MockRealtimeTransport } from '../src/realtime/mock.transport.js';
import { RealtimeSession } from '../src/realtime/session.js';
import { defineTool, RealtimeToolExecutor, toOpenAIRealtimeTools } from '../src/realtime/tools.js';
import type {
  RealtimeClock,
  RealtimeSchemaResult,
  RealtimeSessionEvents,
  RealtimeTool,
  RealtimeToolCall,
} from '../src/realtime/types.js';

class FakeClock implements RealtimeClock {
  nowMs = 1_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.sleeps.push(ms);
    this.nowMs += ms;
    return Promise.resolve();
  }
}

function call(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  idempotencyKey = `realtime:${callId}`,
): RealtimeToolCall {
  return {
    callId,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
    idempotencyKey,
  };
}

function nextEvent<EventName extends 'tool.call.completed' | 'tool.confirmation.required'>(
  session: RealtimeSession,
  event: EventName,
): Promise<RealtimeSessionEvents[EventName]> {
  return new Promise((resolve) => {
    session.once(event, (payload) => resolve(payload));
  });
}

test('defineTool validates definitions and OpenAI serialization omits execute handlers', () => {
  assert.throws(
    () => defineTool({ name: ' ', description: 'bad', execute: async () => undefined }),
    /name must not be empty/,
  );
  assert.throws(
    () => defineTool({ name: 'lookup', description: ' ', execute: async () => undefined }),
    /requires a description/,
  );

  const lookup = defineTool({
    name: 'lookup',
    description: 'Look up a value',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    execute: async ({ query }) => ({ query }),
  });

  assert.deepEqual(toOpenAIRealtimeTools([lookup]), [
    {
      type: 'function',
      name: 'lookup',
      description: 'Look up a value',
      parameters: lookup.parameters,
    },
  ]);
  assert.equal('execute' in toOpenAIRealtimeTools([lookup])[0], false);
});

test('tool executor validates and transforms input, emits lifecycle hooks, and deduplicates calls', async () => {
  const lifecycle: string[] = [];
  let executions = 0;
  const schema = {
    safeParse(input: unknown): RealtimeSchemaResult<{ value: number }> {
      const value = (input as { value?: unknown })?.value;
      return typeof value === 'string' && /^\d+$/.test(value)
        ? { success: true, data: { value: Number(value) } }
        : { success: false, error: 'value must be an integer string' };
    },
  };
  const tool: RealtimeTool<{ value: number }, number> = {
    name: 'double',
    description: 'Double a validated number',
    schema,
    execute: async (input, context) => {
      executions += 1;
      assert.equal(context.sessionId, 'session_tools');
      assert.equal(context.callId, 'call_double');
      assert.equal(context.idempotencyKey, 'idem_double');
      assert.equal(context.attempt, 1);
      assert.equal(context.signal.aborted, false);
      return input.value * 2;
    },
  };
  const executor = new RealtimeToolExecutor([tool as unknown as RealtimeTool], {
    sessionId: 'session_tools',
    onStarted: (value) => lifecycle.push(`started:${value.callId}`),
    onCompleted: (value) => lifecycle.push(`completed:${value.call.callId}:${value.ok}`),
  });

  const request = call('call_double', 'double', { value: '21' }, 'idem_double');
  const first = executor.execute(request);
  const duplicate = executor.execute(request);
  assert.equal(first, duplicate);

  const result = await first;
  const cached = await executor.execute(request);
  assert.equal(cached, result);
  assert.deepEqual(result, {
    call: request,
    ok: true,
    result: 42,
    durationMs: result.durationMs,
    attempts: 1,
  });
  assert.equal(executions, 1);
  assert.deepEqual(lifecycle, ['started:call_double', 'completed:call_double:true']);
  assert.equal(executor.has('double'), true);
  assert.equal(executor.list().length, 1);

  executor.clearCompleted('call_double');
  await executor.execute(request);
  assert.equal(executions, 2);
});

test('tool executor returns validation, allowlist, and confirmation failures without executing', async () => {
  let executions = 0;
  const tool: RealtimeTool<Record<string, unknown>> = {
    name: 'write_booking',
    description: 'Create a booking',
    requiresConfirmation: true,
    schema: {
      safeParse(input): RealtimeSchemaResult<Record<string, unknown>> {
        return typeof input === 'object' && input !== null && 'slot' in input
          ? { success: true, data: input as Record<string, unknown> }
          : { success: false, error: { message: 'slot is required' } };
      },
    },
    execute: async () => {
      executions += 1;
      return { created: true };
    },
  };

  const invalid = await new RealtimeToolExecutor([tool], { sessionId: 's' }).execute(
    call('invalid', 'write_booking', {}),
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.error || '', /slot is required/);
  assert.equal(invalid.attempts, 0);

  const disallowed = await new RealtimeToolExecutor([tool], {
    sessionId: 's',
    allowedTools: ['read_calendar'],
  }).execute(call('disallowed', 'write_booking', { slot: '10:00' }));
  assert.equal(disallowed.ok, false);
  assert.match(disallowed.error || '', /is not allowed/);

  let confirmationRequests = 0;
  const rejected = await new RealtimeToolExecutor([tool], {
    sessionId: 's',
    onConfirmationRequired: () => {
      confirmationRequests += 1;
    },
    confirm: async () => false,
  }).execute(call('rejected', 'write_booking', { slot: '10:00' }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.error || '', /was rejected/);
  assert.equal(confirmationRequests, 1);
  assert.equal(executions, 0);
});

test('safe tools retry with exponential delays while unsafe tools fail once', async () => {
  const clock = new FakeClock();
  let safeAttempts = 0;
  const safeTool: RealtimeTool = {
    name: 'read_calendar',
    description: 'Read calendar data',
    safe: true,
    execute: async () => {
      safeAttempts += 1;
      if (safeAttempts < 3) throw new Error(`temporary ${safeAttempts}`);
      return 'available';
    },
  };
  const safe = await new RealtimeToolExecutor([safeTool], {
    sessionId: 's',
    maxRetries: 2,
    retryDelayMs: 5,
    clock,
  }).execute(call('safe', 'read_calendar', {}));

  assert.equal(safe.ok, true);
  assert.equal(safe.result, 'available');
  assert.equal(safe.attempts, 3);
  assert.deepEqual(clock.sleeps, [5, 10]);
  assert.equal(safe.durationMs, 15);

  let unsafeAttempts = 0;
  const unsafeTool: RealtimeTool = {
    name: 'delete_booking',
    description: 'Delete a booking',
    safe: false,
    execute: async () => {
      unsafeAttempts += 1;
      throw new Error('do not retry');
    },
  };
  const unsafe = await new RealtimeToolExecutor([unsafeTool], {
    sessionId: 's',
    maxRetries: 5,
    clock,
  }).execute(call('unsafe', 'delete_booking', {}));
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.attempts, 1);
  assert.equal(unsafeAttempts, 1);
});

test('safe tools can opt into a structural cross-call result cache', async () => {
  const values = new Map<string, unknown>();
  const writes: Array<{ key: string; ttlMs?: number }> = [];
  let executions = 0;
  const tool: RealtimeTool = {
    name: 'cached_lookup',
    description: 'Cache a read-only lookup',
    safe: true,
    cache: { ttlMs: 5_000 },
    execute: async (input) => {
      executions += 1;
      return { input };
    },
  };
  const executor = new RealtimeToolExecutor([tool], {
    sessionId: 'cache_session',
    cache: {
      get: (key) => values.get(key),
      set: (key, value, ttlMs) => {
        values.set(key, value);
        writes.push({ key, ttlMs });
      },
    },
  });

  const first = await executor.execute(call('cache_1', 'cached_lookup', { city: 'Yerevan', day: 17 }));
  const second = await executor.execute(call('cache_2', 'cached_lookup', { day: 17, city: 'Yerevan' }));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.attempts, 0);
  assert.equal(executions, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.ttlMs, 5_000);
});

test('tool executor enforces maxParallelCalls without overlapping queued executions', async () => {
  let releaseFirst: () => void = () => undefined;
  const blocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const tool: RealtimeTool = {
    name: 'limited',
    description: 'Exercise concurrency',
    execute: async (input) => {
      const id = String(input.id);
      started.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (id === 'first') await blocker;
      active -= 1;
      return id;
    },
  };
  const executor = new RealtimeToolExecutor([tool], { sessionId: 's', maxParallelCalls: 1 });
  const first = executor.execute(call('first', 'limited', { id: 'first' }));
  const second = executor.execute(call('second', 'limited', { id: 'second' }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ['first']);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(maximumActive, 1);
});

test('realtime session automatically validates, confirms, executes, and deduplicates provider tool calls', async () => {
  const transport = new MockRealtimeTransport({ autoPlay: false, sessionId: 'provider_session' });
  let executions = 0;
  const tool: RealtimeTool<{ slot: string }, { booked: string }> = {
    name: 'create_booking',
    description: 'Create a confirmed booking',
    requiresConfirmation: true,
    schema: {
      safeParse(input): RealtimeSchemaResult<{ slot: string }> {
        const slot = (input as { slot?: unknown })?.slot;
        return typeof slot === 'string'
          ? { success: true, data: { slot } }
          : { success: false, error: 'slot must be a string' };
      },
    },
    execute: async ({ slot }) => {
      executions += 1;
      return { booked: slot };
    },
  };
  const session = new RealtimeSession({
    id: 'session_auto_tools',
    model: 'gpt-realtime',
    transport,
    tools: [tool as unknown as RealtimeTool],
    toolExecution: { mode: 'automatic', timeoutMs: 1_000 },
  });
  await session.connect();

  let requiredCallId: string | undefined;
  session.on('tool.confirmation.required', ({ call: requiredCall }) => {
    requiredCallId = requiredCall.callId;
    assert.equal(session.confirmTool(requiredCall.callId, true), true);
  });
  const completed = nextEvent(session, 'tool.call.completed');
  const providerCall = {
    type: 'response.function_call_arguments.done',
    call_id: 'call_booking',
    name: 'create_booking',
    arguments: '{"slot":"10:00"}',
    item_id: 'item_booking',
    response_id: 'response_booking',
  };
  transport.emitData(providerCall);
  transport.emitData(providerCall);

  const event = await completed;
  assert.equal(requiredCallId, 'call_booking');
  assert.equal(event.result.ok, true);
  assert.deepEqual(event.result.result, { booked: '10:00' });
  assert.equal(executions, 1);
  assert.equal(session.confirmTool('call_booking', true), false);
  assert.equal(session.getConversation().metrics.toolCalls, 1);
  assert.deepEqual(
    transport.sentEvents.slice(-2).map((item) => item.type),
    ['conversation.item.create', 'response.create'],
  );
  const output = transport.sentEvents.at(-2)?.item as { call_id?: string; output?: string };
  assert.equal(output.call_id, 'call_booking');
  assert.deepEqual(JSON.parse(output.output || ''), { booked: '10:00' });

  const invalidCompleted = nextEvent(session, 'tool.call.completed');
  transport.emitData({
    type: 'response.function_call_arguments.done',
    call_id: 'call_invalid',
    name: 'create_booking',
    arguments: '{"slot":42}',
  });
  const invalid = await invalidCompleted;
  assert.equal(invalid.result.ok, false);
  assert.match(invalid.result.error || '', /slot must be a string/);
  assert.equal(executions, 1);

  const malformedCompleted = nextEvent(session, 'tool.call.completed');
  transport.emitData({
    type: 'response.function_call_arguments.done',
    call_id: 'call_malformed',
    name: 'create_booking',
    arguments: '{"slot":',
  });
  const malformed = await malformedCompleted;
  assert.equal(malformed.result.ok, false);
  assert.match(malformed.result.error || '', /malformed JSON arguments/);
  assert.equal(executions, 1);

  await session.disconnect();
});

test('session security allowlists filter advertised and executed tools', async () => {
  const transport = new MockRealtimeTransport({ autoPlay: false });
  let blockedExecutions = 0;
  const allowed: RealtimeTool = {
    name: 'allowed_read',
    description: 'An allowed read',
    safe: true,
    execute: async () => 'ok',
  };
  const blocked: RealtimeTool = {
    name: 'blocked_write',
    description: 'A blocked write',
    execute: async () => {
      blockedExecutions += 1;
      return 'unsafe';
    },
  };
  const session = new RealtimeSession({
    id: 'session_allowlist',
    model: 'gpt-realtime',
    transport,
    tools: [allowed, blocked],
    toolExecution: { allowedTools: ['allowed_read', 'blocked_write'] },
    security: { toolAllowlist: ['allowed_read'] },
    providerSession: {
      tools: [{ type: 'function', name: 'provider_override' }],
      tool_choice: 'required',
    },
  });
  await session.connect();

  const update = transport.sentEvents[0] as {
    session?: { tools?: Array<{ name?: string }>; tool_choice?: string };
  };
  assert.deepEqual(
    update.session?.tools?.map((tool) => tool.name),
    ['allowed_read'],
  );
  assert.equal(update.session?.tool_choice, 'auto');

  const completed = nextEvent(session, 'tool.call.completed');
  transport.emitData({
    type: 'response.function_call_arguments.done',
    call_id: 'blocked_call',
    name: 'blocked_write',
    arguments: '{}',
  });
  const result = await completed;
  assert.equal(result.result.ok, false);
  assert.match(result.result.error || '', /is not allowed/);
  assert.equal(blockedExecutions, 0);
  await session.disconnect();
});

test('manual realtime tool mode waits for executeTool or submitToolResult', async () => {
  const transport = new MockRealtimeTransport({ autoPlay: false });
  let executions = 0;
  const tool: RealtimeTool = {
    name: 'lookup',
    description: 'Look up data',
    execute: async ({ query }) => {
      executions += 1;
      return { query };
    },
  };
  const session = new RealtimeSession({
    id: 'session_manual_tools',
    model: 'gpt-realtime',
    transport,
    tools: [tool],
    toolExecution: { mode: 'manual' },
  });
  await session.connect();

  transport.emitData({
    type: 'response.function_call_arguments.done',
    call_id: 'manual_1',
    name: 'lookup',
    arguments: '{"query":"weather"}',
  });
  await session.whenIdle();
  assert.equal(executions, 0);
  const executed = await session.executeTool('manual_1');
  assert.equal(executed.ok, true);
  assert.deepEqual(executed.result, { query: 'weather' });
  assert.equal(executions, 1);

  transport.emitData({
    type: 'response.function_call_arguments.done',
    call_id: 'manual_2',
    name: 'lookup',
    arguments: '{"query":"time"}',
  });
  await session.whenIdle();
  const submitted = await session.submitToolResult('manual_2', { externallyResolved: true });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.attempts, 0);
  assert.equal(executions, 1);
  await assert.rejects(() => session.executeTool('missing'), /is not pending/);

  await session.disconnect();
});
