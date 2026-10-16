/**
 * Realtime on the client's lifecycle, proved through a real client: the session and each of its turns
 * are operations of the client, authorized for the session's tenant and user and carrying its trace;
 * each turn is admitted as it starts and charged as it finishes, so the budget holds what the turns
 * cost, and the turn the budget cannot cover is cancelled before it runs and ends the session; and a
 * provider that will not connect is reported to the client's provider health and circuit breaker.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NexusAI } from '../src/core/nexus.js';
import { budgetLedger } from '../src/lifecycle/budget.js';
import { TypedEventEmitter } from '../src/realtime/events.js';
import { RealtimeSession } from '../src/realtime/session.js';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from '../src/realtime/types.js';
import type { OperationDescriptor } from '../src/types/lifecycle.js';

class Transport implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  state: RealtimeTransportState = 'idle';
  readonly sent: RealtimeClientEvent[] = [];
  interrupts = 0;
  failConnect = false;
  private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();

  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error('the provider refused the connection');
    this.state = 'connected';
    this.emitter.emit('connected', { sessionId: 'provider', transport: this.kind, timestamp: 0 });
  }
  sendAudio(): void {}
  sendEvent(event: RealtimeClientEvent): void {
    this.sent.push(event);
  }
  interrupt(): void {
    this.interrupts += 1;
  }
  async disconnect(): Promise<void> {
    this.state = 'disconnected';
    this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
  }
  emit(event: RealtimeServerEvent): void {
    this.emitter.emit('data', { event, raw: event });
  }
  /** One model turn: started, then done, with its usage. */
  turn(id: string, done = true): void {
    this.emit({ type: 'response.created', response: { id } });
    if (done) {
      this.emit({
        type: 'response.done',
        response: { id, status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
      });
    }
  }
}

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function client(limit: number, seen: OperationDescriptor[]) {
  const budget = budgetLedger({ limit });
  const ai = new NexusAI({
    providers: {},
    lifecycle: {
      authorize: (operation) => {
        seen.push({ ...operation });
        return true;
      },
      budget,
    },
  });
  return { ai, budget };
}

function session(ai: NexusAI, transport: Transport, extra: Partial<RealtimeSessionConfig> = {}) {
  return new RealtimeSession({
    model: 'gpt-realtime',
    transport,
    lifecycle: ai.lifecycle,
    principal: { tenantId: 'acme', userId: 'ana' },
    traceContext: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    // Two cents a turn: ten input tokens at a tenth of a cent, five output at a fifth.
    telemetry: { estimateCost: ({ inputTokens = 0, outputTokens = 0 }) => inputTokens * 0.001 + outputTokens * 0.002 },
    ...extra,
  });
}

test('proof: each realtime turn is an operation of the client, and the turn the budget cannot cover never runs', async () => {
  const seen: OperationDescriptor[] = [];
  const { ai, budget } = client(0.05, seen);
  const transport = new Transport();
  const live = session(ai, transport);
  const errors: Array<{ code?: string }> = [];
  live.on('error', (error) => errors.push(error));
  await live.connect();

  transport.turn('response_1');
  transport.turn('response_2');
  await live.whenIdle();
  await sleep();
  assert.ok(Math.abs((await budget.spent('acme')) - 0.04) < 1e-9, 'two turns at two cents each');
  assert.equal(live.state, 'connected');

  // A third would bring the session to six cents of a five-cent budget: refused as it starts.
  transport.turn('response_3', false);
  await live.whenIdle();
  await sleep(20);
  assert.equal(transport.interrupts, 1, 'the response the budget cannot cover is cancelled');
  assert.equal(errors.at(-1)?.code, 'lifecycle_refused');
  assert.equal(live.state, 'disconnected', 'and the session ends');
  assert.ok(Math.abs((await budget.spent('acme')) - 0.04) < 1e-9, 'nothing is charged for the cancelled turn');

  assert.deepEqual(
    seen.map((operation) => [operation.operation, operation.tenantId, operation.userId]),
    [
      ['realtime.session', 'acme', 'ana'],
      ['realtime.turn', 'acme', 'ana'],
      ['realtime.turn', 'acme', 'ana'],
      ['realtime.turn', 'acme', 'ana'],
    ],
    "the session's operations are the tenant's and the user's",
  );
  assert.ok(Math.abs((live.getMetrics().estimatedCost ?? 0) - 0.04) < 1e-9, 'the session adds its turns up');
  assert.equal(live.getMetrics().inputTokens, 20, "a session's usage is the sum of its turns'");
});

test('a session whose turns are charged as they finish charges nothing more when it ends', async () => {
  const { ai, budget } = client(10, []);
  const transport = new Transport();
  const live = session(ai, transport);
  await live.connect();
  for (const id of ['a', 'b', 'c']) transport.turn(id);
  await live.whenIdle();
  await live.disconnect();
  assert.ok(Math.abs((await budget.spent('acme')) - 0.06) < 1e-9, 'three turns, charged once each');
});

test("a provider that will not connect is reported to the client's provider health and circuit breaker", async () => {
  const ai = new NexusAI({ providers: {}, circuitBreaker: { enabled: true, failureThreshold: 3 } });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transport = new Transport();
    transport.failConnect = true;
    const failing = session(ai, transport, { reconnect: { enabled: false } });
    await assert.rejects(failing.connect(), /refused the connection/);
  }
  const [circuit] = ai.getCircuitBreakerStatus().filter((entry) => entry.providerName === 'openai');
  assert.equal(circuit?.state, 'open', 'repeated connection failures open the circuit');
  assert.equal(circuit?.consecutiveFailures, 3);
});
