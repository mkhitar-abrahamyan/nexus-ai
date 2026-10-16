/**
 * Phone calls answered by a realtime agent, over OpenAI's SIP interface. Point a SIP trunk at OpenAI
 * and its `realtime.call.incoming` webhook at `answerOpenAISipCalls().handle`: each verified call is
 * answered with the session you choose for it, and that session, with its tools, its conversation
 * record, and its lifecycle, then runs the call over a WebSocket attached to it.
 */
import { type RealtimeError, toRealtimeError } from './errors.js';
import { createOpenAISessionUpdate } from './openai-events.js';
import {
  acceptOpenAIRealtimeCall,
  hangupOpenAIRealtimeCall,
  type OpenAIRealtimeCallOptions,
  type OpenAIWebhookEvent,
  type OpenAIWebhookHeaders,
  type OpenAIWebhookVerifyOptions,
  referOpenAIRealtimeCall,
  rejectOpenAIRealtimeCall,
  verifyOpenAIWebhook,
} from './openai-server.js';
import {
  type OpenAIWebSocketFactory,
  OpenAIWebSocketTransport,
  type OpenAIWebSocketTransportOptions,
} from './openai-websocket.transport.js';
import { RealtimeSession } from './session.js';
import type { RealtimeSessionConfig } from './types.js';

/** One SIP header of a call, as it arrived. */
export interface OpenAISipHeader {
  /** The header's name, such as `From`. */
  name: string;
  /** Its value. */
  value: string;
}

/** An incoming phone call, and what can be done with it once it is answered. */
export interface OpenAISipCall {
  /** OpenAI's id for the call. */
  readonly callId: string;
  /** Who is calling: the `From` header's value, as it arrived. */
  readonly from?: string;
  /** The number or address they called: the `To` header's value, as it arrived. */
  readonly to?: string;
  /** Every SIP header of the call. */
  readonly headers: readonly OpenAISipHeader[];
  /** The webhook event that announced the call. */
  readonly event: OpenAIWebhookEvent;
  /** One SIP header's value, by its name in any case. */
  header(name: string): string | undefined;
  /** Transfers the call to another number or SIP address, such as `tel:+14155550123`. */
  refer(targetUri: string, signal?: AbortSignal): Promise<void>;
  /** Ends the call, and disconnects its session. */
  hangup(signal?: AbortSignal): Promise<void>;
}

/** The session that answers a call: a session's configuration, less the transport the call provides. */
export type OpenAISipSessionConfig = Omit<RealtimeSessionConfig, 'transport' | 'provider'>;

/** How to answer a call: with the session that runs it, or not at all, with a SIP status. */
export type OpenAISipAnswer = OpenAISipSessionConfig | false | { reject: number };

/** Options for `answerOpenAISipCalls()`. */
export interface OpenAISipOptions extends OpenAIRealtimeCallOptions {
  /** Your webhook endpoint's signing secret, `whsec_...`. */
  webhookSecret: string;
  /**
   * Decides how to answer each call, from who is calling and what they called: a session's
   * configuration answers it; `false` declines it (SIP 603); `{ reject }` declines it with another
   * status, such as 486 when busy. The session's id defaults to the call's.
   */
  answer(call: OpenAISipCall): OpenAISipAnswer | Promise<OpenAISipAnswer>;
  /**
   * Opens each call's socket, with the headers it is given: the API key goes in a header, which the
   * standard `WebSocket` cannot send, so inject one that can, such as the `ws` package's.
   */
  webSocketFactory: OpenAIWebSocketFactory;
  /** Options for each call's WebSocket transport. */
  websocket?: Omit<OpenAIWebSocketTransportOptions, 'apiKey' | 'callId' | 'webSocketFactory'>;
  /** Called with each answered call's session, once it is connected. */
  onSession?(session: RealtimeSession, call: OpenAISipCall): void | Promise<void>;
  /** Called with every other verified event, such as a background response finishing. */
  onEvent?(event: OpenAIWebhookEvent): void | Promise<void>;
  /** Receives what fails after a call was answered, such as a session that could not connect. */
  onError?(error: RealtimeError, call: OpenAISipCall): void;
  /**
   * Claims a delivery before acting on it, by its webhook id, so a retried or duplicated delivery
   * answers its call once: false when it was claimed already. Defaults to remembering the last
   * 10,000 in this process; give one backed by a shared store when several replicas take the webhook.
   */
  claim?(webhookId: string): boolean | Promise<boolean>;
  /** Releases a claim when acting on the delivery failed, so OpenAI's retry of it is acted on. */
  release?(webhookId: string): void | Promise<void>;
  /** How old a delivery may be. */
  verify?: OpenAIWebhookVerifyOptions;
}

/** A webhook delivery, as your HTTP server received it. Pass the body exactly as it arrived. */
export interface OpenAISipWebhookRequest {
  /** The request's headers: a `Headers` object or a plain record. */
  headers: OpenAIWebhookHeaders;
  /** The raw body. */
  body: string | Uint8Array;
}

/** What to reply to a webhook delivery. */
export interface OpenAISipWebhookResponse {
  /**
   * 200 when the delivery was acted on or needs nothing; 401 when it is not signed by your secret;
   * 400 when it is not an event; 500 when answering the call failed, so OpenAI delivers it again.
   */
  status: number;
  /** A JSON body. */
  body: string;
}

/** Phone calls answered by a realtime agent, from `answerOpenAISipCalls()`. */
export interface OpenAISipCalls {
  /** Handles one webhook delivery: verifies it, answers the call it announces, and says what to reply. */
  handle(request: OpenAISipWebhookRequest): Promise<OpenAISipWebhookResponse>;
  /** The sessions of the calls in progress, by call id. */
  readonly sessions: ReadonlyMap<string, RealtimeSession>;
  /** Ends every call in progress: hangs each up and disconnects its session. For shutdown. */
  close(): Promise<void>;
}

const REMEMBERED = 10_000;

/**
 * Answers phone calls with a realtime agent, over OpenAI's SIP interface. Returns the webhook handler
 * and the calls in progress.
 *
 * Each `realtime.call.incoming` delivery is verified against `webhookSecret` and claimed, so a retry
 * answers its call once. `answer()` then decides: the call is accepted with that session's
 * configuration, and the session attaches to it over a WebSocket and runs it, its tools and all, or
 * the call is declined. The delivery is answered once the call is accepted; the session connects
 * after, and `onSession()` receives it.
 */
export function answerOpenAISipCalls(options: OpenAISipOptions): OpenAISipCalls {
  const sessions = new Map<string, RealtimeSession>();
  const seen = new Set<string>();
  const claim =
    options.claim ??
    ((webhookId: string) => {
      if (seen.has(webhookId)) return false;
      seen.add(webhookId);
      if (seen.size > REMEMBERED) seen.delete(seen.values().next().value as string);
      return true;
    });
  const release = options.release ?? ((webhookId: string) => void seen.delete(webhookId));
  const reply = (status: number, body: Record<string, unknown>): OpenAISipWebhookResponse => ({
    status,
    body: JSON.stringify(body),
  });

  const callOf = (event: OpenAIWebhookEvent): OpenAISipCall => {
    const callId = String(event.data.call_id ?? '');
    const headers = (Array.isArray(event.data.sip_headers) ? event.data.sip_headers : [])
      .filter(
        (value): value is OpenAISipHeader =>
          typeof value === 'object' && value !== null && typeof (value as OpenAISipHeader).name === 'string',
      )
      .map(({ name, value }) => ({ name, value: String(value ?? '') }));
    const header = (name: string) => headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
    return {
      callId,
      from: header('From'),
      to: header('To'),
      headers,
      event,
      header,
      refer: (targetUri, signal) => referOpenAIRealtimeCall(callId, targetUri, options, signal),
      async hangup(signal) {
        await hangupOpenAIRealtimeCall(callId, options, signal);
        await sessions.get(callId)?.disconnect();
      },
    };
  };

  const run = (call: OpenAISipCall, config: OpenAISipSessionConfig) => {
    const transport = new OpenAIWebSocketTransport({
      ...options.websocket,
      apiKey: options.apiKey,
      callId: call.callId,
      webSocketFactory: options.webSocketFactory,
    });
    const session = new RealtimeSession({ id: call.callId, ...config, provider: 'openai', transport });
    sessions.set(call.callId, session);
    session.on('session.disconnected', () => {
      if (sessions.get(call.callId) === session) sessions.delete(call.callId);
    });
    void session
      .connect()
      .then(() => options.onSession?.(session, call))
      .catch((error: unknown) => {
        if (sessions.get(call.callId) === session) sessions.delete(call.callId);
        options.onError?.(
          toRealtimeError(error, { code: 'sip_session_failed', category: 'network', provider: 'openai' }),
          call,
        );
      });
  };

  return {
    sessions,
    async handle(request) {
      let event: OpenAIWebhookEvent;
      try {
        event = await verifyOpenAIWebhook(request, options.webhookSecret, options.verify);
      } catch (error) {
        const failure = toRealtimeError(error, { code: 'invalid_webhook_event', category: 'protocol' });
        return reply(failure.code === 'invalid_webhook_signature' ? 401 : 400, { error: failure.message });
      }
      if (event.type !== 'realtime.call.incoming') {
        await options.onEvent?.(event);
        return reply(200, { ok: true });
      }
      if (!(await claim(event.webhookId))) return reply(200, { ok: true, duplicate: true });
      const call = callOf(event);
      try {
        const answer = await options.answer(call);
        if (answer === false || 'reject' in answer) {
          const statusCode = answer === false ? 603 : answer.reject;
          await rejectOpenAIRealtimeCall(call.callId, { ...options, statusCode });
          return reply(200, { ok: true, rejected: statusCode });
        }
        const update = createOpenAISessionUpdate({
          ...answer,
          transport: undefined,
        } as unknown as RealtimeSessionConfig);
        await acceptOpenAIRealtimeCall(call.callId, update.session as Record<string, unknown>, options);
        run(call, answer);
        return reply(200, { ok: true, accepted: call.callId });
      } catch (error) {
        await release(event.webhookId);
        return reply(500, { error: error instanceof Error ? error.message : 'The call could not be answered' });
      }
    },
    async close() {
      await Promise.all(
        [...sessions.entries()].map(async ([callId, session]) => {
          await hangupOpenAIRealtimeCall(callId, options).catch(() => undefined);
          await session.disconnect();
        }),
      );
    },
  };
}
