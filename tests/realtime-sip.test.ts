/**
 * Phone calls answered by a realtime agent over OpenAI's SIP interface, proved: a signed
 * `realtime.call.incoming` delivery reaches the handler; the call is accepted with the agent's
 * session, chosen from who is calling; the session attaches to the call by its id and runs it, its
 * tool and its conversation record included; and the call is hung up. A delivery not signed by the
 * endpoint's secret, altered, or too old answers nothing; a delivery whose accept failed is acted on
 * when OpenAI retries it, and a duplicate, on this replica or another, answers its call once.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifyOpenAIWebhook } from '../src/realtime/openai-server.js';
import { answerOpenAISipCalls, type OpenAISipCall, type OpenAISipOptions } from '../src/realtime/openai-sip.js';
import type {
  OpenAIWebSocketFactoryOptions,
  RealtimeWebSocketLike,
} from '../src/realtime/openai-websocket.transport.js';
import type { RealtimeSession } from '../src/realtime/session.js';
import { defineTool } from '../src/realtime/tools.js';

// biome-ignore lint/suspicious/noExplicitAny: the other side of the wire has no types to borrow.
type Message = Record<string, any>;

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const SECRET_BYTES = Buffer.from('the endpoint signing secret');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

/** A delivery as OpenAI signs it: Standard Webhooks, HMAC-SHA256 over id, timestamp, and body. */
function delivery(
  event: Record<string, unknown>,
  { id = 'wh_1', at = NOW, key = SECRET_BYTES }: { id?: string; at?: number; key?: Buffer } = {},
) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(at / 1_000));
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    headers: { 'Webhook-Id': id, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}` },
    body,
  };
}

const incoming = (callId = 'rtc_1', from = '"Ana" <sip:+14155550100@trunk.example>;tag=1') => ({
  object: 'event',
  id: `evt_${callId}`,
  type: 'realtime.call.incoming',
  created_at: NOW / 1_000,
  data: {
    call_id: callId,
    sip_headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'sip:+18005550199@trunk.example' },
      { name: 'X-Account', value: 'acct_9' },
    ],
  },
});

/** OpenAI's REST side: the call-control requests it received, failing the first `failures`. */
function api(failures = 0) {
  const requests: Array<{ url: string; method: string; body?: Message; authorization?: string }> = [];
  let failing = failures;
  const fetch: OpenAISipOptions['fetch'] = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: init.headers?.Authorization,
    });
    if (failing > 0) {
      failing -= 1;
      return { ok: false, status: 500, text: async () => 'upstream unavailable' };
    }
    return { ok: true, status: 200, text: async () => '' };
  };
  return { requests, fetch };
}

/** The call's WebSocket at OpenAI: it hears the session and answers as the model would. */
class CallSocket implements RealtimeWebSocketLike {
  readyState = 0;
  binaryType?: string;
  readonly sent: Message[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly options: OpenAIWebSocketFactoryOptions,
  ) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', { type: 'open' });
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    const message = JSON.parse(String(data)) as Message;
    this.sent.push(message);
    if (message.type === 'response.create' && this.sent.some((sent) => sent.item?.type === 'function_call_output')) {
      this.reply({ type: 'response.created', response: { id: 'resp_2' } });
      this.reply({
        type: 'response.output_audio_transcript.done',
        response_id: 'resp_2',
        item_id: 'item_2',
        transcript: 'Booked: a table for four at seven.',
      });
      this.reply({ type: 'response.done', response: { id: 'resp_2', status: 'completed', output: [] } });
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', { code, reason });
  }

  /** The caller asks for a table, and the model calls the tool. */
  caller(): void {
    this.reply({ type: 'input_audio_buffer.speech_started', item_id: 'user_1' });
    this.reply({ type: 'input_audio_buffer.speech_stopped', item_id: 'user_1' });
    this.reply({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_1',
      transcript: 'A table for four at seven, please.',
    });
    this.reply({ type: 'response.created', response: { id: 'resp_1' } });
    this.reply({
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'book_table', arguments: '{"party":4,"time":"19:00"}' },
        ],
      },
    });
  }

  reply(message: Message): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
}

const bookings: unknown[] = [];
const bookTable = defineTool({
  name: 'book_table',
  description: 'Books a table',
  parameters: {
    type: 'object',
    properties: { party: { type: 'number' }, time: { type: 'string' } },
    required: ['party', 'time'],
  },
  execute: async (booking) => {
    bookings.push(booking);
    return { confirmed: true };
  },
});

function calls(extra: Partial<OpenAISipOptions> = {}) {
  const sockets: CallSocket[] = [];
  const answered: OpenAISipCall[] = [];
  const { requests, fetch } = api((extra as { failures?: number }).failures);
  const connected: Array<[RealtimeSession, OpenAISipCall]> = [];
  let onConnected: () => void = () => undefined;
  const handler = answerOpenAISipCalls({
    apiKey: 'server-key',
    webhookSecret: SECRET,
    verify: { now: () => NOW },
    fetch,
    webSocketFactory: (url, options) => {
      const socket = new CallSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    answer: (call) => {
      answered.push(call);
      return call.from?.includes('+1415')
        ? {
            model: 'gpt-realtime',
            instructions: "You book tables at Luigi's.",
            tools: [bookTable],
            audio: { output: { voice: 'marin' } },
            conversation: { captureTranscripts: true },
            metadata: { account: call.header('x-account') },
          }
        : { reject: 486 };
    },
    onSession: (session, call) => {
      connected.push([session, call]);
      onConnected();
    },
    ...extra,
  });
  const nextSession = () =>
    new Promise<void>((resolve) => {
      onConnected = resolve;
    });
  return { handler, sockets, answered, requests, connected, nextSession };
}

const settle = async (session: RealtimeSession) => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  await session.whenIdle();
};

test('proof: a phone call reaches the agent, which answers it, books the table, and hangs up', async () => {
  bookings.length = 0;
  const { handler, sockets, answered, requests, connected, nextSession } = calls();
  const ready = nextSession();
  const response = await handler.handle(delivery(incoming()));
  assert.deepEqual(response, { status: 200, body: '{"ok":true,"accepted":"rtc_1"}' });

  // Who is calling decided the answer, and the call was accepted with the agent's session.
  assert.equal(answered[0]?.from, '"Ana" <sip:+14155550100@trunk.example>;tag=1');
  assert.equal(answered[0]?.to, 'sip:+18005550199@trunk.example');
  assert.equal(answered[0]?.header('x-account'), 'acct_9');
  const [accept] = requests;
  assert.equal(accept?.url, 'https://api.openai.com/v1/realtime/calls/rtc_1/accept');
  assert.equal(accept?.authorization, 'Bearer server-key');
  assert.equal(accept?.body?.type, 'realtime');
  assert.equal(accept?.body?.model, 'gpt-realtime');
  assert.equal(accept?.body?.instructions, "You book tables at Luigi's.");
  assert.deepEqual(
    accept?.body?.tools.map((tool: Message) => tool.name),
    ['book_table'],
  );
  assert.equal(accept?.body?.audio.output.voice, 'marin');

  // The session attaches to the call by its id, and runs it.
  await ready;
  const [session, call] = connected[0] as [RealtimeSession, OpenAISipCall];
  const socket = sockets[0] as CallSocket;
  assert.equal(socket.url, 'wss://api.openai.com/v1/realtime?call_id=rtc_1');
  assert.equal(socket.options.headers.authorization, 'Bearer server-key');
  assert.equal(session.id, 'rtc_1', "the conversation is the call's");
  assert.equal(handler.sessions.get('rtc_1'), session);
  socket.caller();
  await settle(session);
  assert.deepEqual(bookings, [{ party: 4, time: '19:00' }], 'the tool ran on the call');
  assert.deepEqual(
    session
      .getConversation()
      .items.flatMap((item) =>
        item.type === 'user_speech'
          ? [`caller: ${item.transcript}`]
          : item.type === 'tool_call'
            ? [`calls ${item.name}`]
            : item.type === 'assistant_speech'
              ? [`agent: ${item.transcript}`]
              : [],
      ),
    ['caller: A table for four at seven, please.', 'calls book_table', 'agent: Booked: a table for four at seven.'],
  );
  assert.deepEqual(session.getConversation().metadata, { account: 'acct_9' });

  await call.hangup();
  assert.equal(requests.at(-1)?.url, 'https://api.openai.com/v1/realtime/calls/rtc_1/hangup');
  assert.equal(session.state, 'disconnected');
  assert.equal(handler.sessions.size, 0, 'the call is over');
});

test('a delivery not signed by the endpoint secret, altered, or too old answers no call', async () => {
  const { handler, requests } = calls();
  const forged = delivery(incoming(), { key: Buffer.from('another secret') });
  const altered = { ...delivery(incoming()), body: JSON.stringify(incoming('rtc_other')) };
  const stale = delivery(incoming(), { at: NOW - 301_000 });
  const unsigned = { headers: {}, body: JSON.stringify(incoming()) };
  for (const [name, request] of Object.entries({ forged, altered, stale, unsigned })) {
    const response = await handler.handle(request);
    assert.equal(response.status, 401, name);
  }
  const notJson = delivery(incoming());
  const garbled = { ...notJson, body: 'not json' };
  const resigned = createHmac('sha256', SECRET_BYTES)
    .update(`wh_1.${notJson.headers['Webhook-Timestamp']}.not json`)
    .digest('base64');
  assert.equal(
    (
      await handler.handle({
        headers: { ...garbled.headers, 'Webhook-Signature': `v1,${resigned}` },
        body: garbled.body,
      })
    ).status,
    400,
  );
  assert.equal(requests.length, 0, 'nothing reached OpenAI');

  // The verifier on its own takes a `Headers` object, and a signature among several.
  const signed = delivery(incoming());
  const headers = new Headers({
    ...signed.headers,
    'Webhook-Signature': `v1,c29tZXRoaW5nIGVsc2U= ${signed.headers['Webhook-Signature']}`,
  });
  const event = await verifyOpenAIWebhook({ headers, body: signed.body }, SECRET, { now: () => NOW });
  assert.equal(event.type, 'realtime.call.incoming');
  assert.equal(event.webhookId, 'wh_1');
});

test('a delivery whose accept failed is acted on when OpenAI retries it, and a duplicate answers its call once', async () => {
  const { handler, requests, nextSession } = calls({ failures: 1 } as Partial<OpenAISipOptions>);
  const first = await handler.handle(delivery(incoming()));
  assert.equal(first.status, 500, 'OpenAI will deliver it again');
  assert.equal(handler.sessions.size, 0);

  const ready = nextSession();
  assert.equal((await handler.handle(delivery(incoming()))).status, 200, 'the retry answers the call');
  await ready;
  const duplicate = await handler.handle(delivery(incoming()));
  assert.deepEqual(JSON.parse(duplicate.body), { ok: true, duplicate: true });
  assert.equal(requests.filter((request) => request.url.endsWith('/accept')).length, 2, 'one failed, one accepted');
  assert.equal(handler.sessions.size, 1);
  await handler.close();
  assert.equal(requests.at(-1)?.url.endsWith('/rtc_1/hangup'), true, 'shutting down hangs up');

  // Two replicas sharing a claim answer a delivery once between them.
  const shared = new Set<string>();
  const claim = (id: string) => {
    if (shared.has(id)) return false;
    shared.add(id);
    return true;
  };
  const one = calls({ claim });
  const other = calls({ claim });
  const answeredOnce = one.nextSession();
  await one.handler.handle(delivery(incoming('rtc_2'), { id: 'wh_2' }));
  await other.handler.handle(delivery(incoming('rtc_2'), { id: 'wh_2' }));
  await answeredOnce;
  assert.equal(one.requests.length + other.requests.length, 1);
  await one.handler.close();
});

test('calls are declined as the agent decides, and other events are handed on', async () => {
  const seen: string[] = [];
  const { handler, requests } = calls({ onEvent: (event) => void seen.push(event.type) });
  await handler.handle(delivery(incoming('rtc_3', 'sip:+442071234567@trunk.example'), { id: 'wh_3' }));
  assert.deepEqual(requests[0], {
    url: 'https://api.openai.com/v1/realtime/calls/rtc_3/reject',
    method: 'POST',
    body: { status_code: 486 },
    authorization: 'Bearer server-key',
  });
  const declining = calls({ answer: () => false });
  await declining.handler.handle(delivery(incoming('rtc_4'), { id: 'wh_4' }));
  assert.deepEqual(declining.requests[0]?.body, { status_code: 603 });

  const other = await handler.handle(
    delivery({ id: 'evt_9', type: 'response.completed', data: { id: 'resp_9' } }, { id: 'wh_9' }),
  );
  assert.equal(other.status, 200);
  assert.deepEqual(seen, ['response.completed']);
  assert.equal(handler.sessions.size, 0);
});
