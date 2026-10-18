/**
 * Telephony in full on both providers: Twilio, answered with markup, and Telnyx, controlled by
 * command. Each places and answers calls, transfers them, puts them in conferences, records them and
 * hands the recording over, and sends and receives messages, against a stand-in for its API that
 * records every request. Telnyx's webhooks are verified with Ed25519, and its media streams parse
 * to the same events Twilio's do.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { webcrypto } from 'node:crypto';
import { OperationLifecycle } from '../src/core/lifecycle.js';
import { TelephonyManager } from '../src/telephony/manager.js';
import { TelnyxTelephonyProvider } from '../src/telephony/providers/telnyx.js';
import { TwilioTelephonyProvider } from '../src/telephony/providers/twilio.js';
import type { AnswerCallRequest } from '../src/types/telephony.js';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A provider's API in this process: it records each request and answers with `respond`. */
function api(respond: (request: Sent) => { status?: number; json?: unknown; bytes?: Uint8Array; type?: string }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const request: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      ...(init.body !== undefined ? { body: String(init.body) } : {}),
    };
    sent.push(request);
    const answer = respond(request);
    const status = answer.status ?? 200;
    if (answer.bytes) {
      return new Response(answer.bytes, { status, headers: { 'content-type': answer.type ?? 'audio/mpeg' } });
    }
    return new Response(status === 204 ? null : JSON.stringify(answer.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch: fetchImpl };
}

const telnyxApi = () =>
  api((request) => {
    const path = decodeURIComponent(new URL(request.url).pathname).replace('/v2', '');
    if (request.method === 'POST' && path === '/calls') return { json: { data: { call_control_id: 'v3:call-1' } } };
    if (path.startsWith('/calls/') && path.includes('/actions/')) return { json: { data: { result: 'ok' } } };
    if (path === '/calls/v3:call-1')
      return { json: { data: { call_control_id: 'v3:call-1', is_alive: true, call_duration: 12 } } };
    if (request.method === 'GET' && path === '/conferences') {
      const name = new URL(request.url).searchParams.get('filter[name]');
      return { json: { data: name === 'standup' ? [{ id: 'conf-9', name, status: 'in_progress' }] : [] } };
    }
    if (request.method === 'POST' && path === '/conferences') return { json: { data: { id: 'conf-new' } } };
    if (path.startsWith('/conferences/')) return { json: { data: { result: 'ok' } } };
    if (path === '/recordings/rec-1' && request.method === 'GET') {
      return { json: { data: { download_urls: { mp3: 'https://s3.example/renewed.mp3' } } } };
    }
    if (path === '/recordings/rec-1' && request.method === 'DELETE') return { status: 204 };
    if (request.url === 'https://s3.example/expired.mp3') return { status: 403 };
    if (request.url === 'https://s3.example/renewed.mp3') return { bytes: new Uint8Array([73, 68, 51, 1]) };
    if (path === '/messages') {
      return { json: { data: { id: 'msg-1', to: [{ phone_number: '+15550001', status: 'queued' }], parts: 1 } } };
    }
    if (path === '/phone_numbers' && request.method === 'GET') {
      return {
        json: {
          data: [{ id: 'num-1', phone_number: '+15559999', connection_id: 'app-1', messaging_profile_id: 'mp-1' }],
        },
      };
    }
    if (path === '/phone_numbers/num-1') {
      return {
        json: {
          data: { id: 'num-1', phone_number: '+15559999', connection_id: 'app-1', messaging_profile_id: 'mp-1' },
        },
      };
    }
    if (path.startsWith('/call_control_applications/') || path.startsWith('/messaging_profiles/'))
      return { json: { data: {} } };
    return { status: 404, json: { errors: [{ detail: `no route ${request.method} ${path}` }] } };
  });

const twilioApi = () =>
  api((request) => {
    const path = new URL(request.url).pathname.replace('/2010-04-01/Accounts/AC1', '');
    if (path === '/Calls/CA1.json') return { json: { sid: 'CA1', status: 'in-progress' } };
    if (path === '/Calls/CA1/Recordings.json') return { json: { sid: 'RE1', status: 'in-progress' } };
    if (path.startsWith('/Calls/CA1/Recordings/')) return { json: { sid: 'RE1', status: 'stopped' } };
    if (path === '/Recordings/RE1.json') return { status: 204 };
    if (request.url === 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3') {
      return { bytes: new Uint8Array([73, 68, 51, 2]) };
    }
    if (path === '/Messages.json')
      return { json: { sid: 'SM1', status: 'queued', num_segments: '1', from: '+15559999', to: '+15550001' } };
    return { status: 404, json: { message: `no route ${request.method} ${path}` } };
  });

const json = (request: Sent | undefined) => JSON.parse(request?.body ?? '{}');
const form = (request: Sent | undefined) => new URLSearchParams(request?.body ?? '');
const telnyx = (fetch: typeof globalThis.fetch, extra = {}) =>
  new TelnyxTelephonyProvider({ apiKey: 'KEY', connectionId: 'app-1', fetch, ...extra });
const twilio = (fetch: typeof globalThis.fetch) =>
  new TwilioTelephonyProvider({ accountSid: 'AC1', authToken: 'token', fetch });

test('one answer for a call webhook: TwiML for Twilio, and the same request as commands on Telnyx', async () => {
  const telnyxCalls = telnyxApi();
  const manager = new TelephonyManager({
    providers: { twilio: twilio(twilioApi().fetch), telnyx: telnyx(telnyxCalls.fetch) },
  });
  const answer: Omit<AnswerCallRequest, 'callId' | 'provider'> = {
    say: 'Connecting you to the assistant.',
    stream: { url: 'wss://agent.example/media', mode: 'bidirectional', parameters: { tenant: 'acme' } },
    hangup: false,
  };

  const markup = await manager.answer({ provider: 'twilio', callId: 'CA1', ...answer });
  assert.equal(markup.contentType, 'text/xml');
  assert.match(
    markup.body,
    /<Say>Connecting you to the assistant\.<\/Say><Connect><Stream url="wss:\/\/agent.example\/media">/,
  );

  const commanded = await manager.answer({ provider: 'telnyx', callId: 'v3:call-1', ...answer });
  assert.deepEqual(commanded, {
    providerUsed: 'telnyx',
    contentType: 'application/json',
    body: '{}',
    raw: commanded.raw,
  });
  const actions = telnyxCalls.sent.map((request) => new URL(request.url).pathname.split('/').pop());
  assert.deepEqual(actions, ['answer', 'speak'], 'answered, then spoken to, in order');
  assert.deepEqual(json(telnyxCalls.sent[0]), {
    stream_url: 'wss://agent.example/media?tenant=acme',
    stream_track: 'inbound_track',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU',
  });
  assert.equal(telnyxCalls.sent[0]?.headers.authorization, 'Bearer KEY');
  assert.deepEqual(json(telnyxCalls.sent[1]), {
    payload: 'Connecting you to the assistant.',
    voice: 'female',
    language: 'en-US',
  });

  await assert.rejects(
    manager.answer({ provider: 'telnyx', callId: 'v3:call-1', redirectUrl: 'https://x.example' }),
    /controlled by command, not redirected/,
  );
});

test('calls are placed, looked up, transferred, conferenced, and ended on both providers', async () => {
  const tx = telnyxApi();
  const telnyxProvider = telnyx(tx.fetch);
  const placed = await telnyxProvider.createCall({
    to: '+15550001',
    from: '+15559999',
    mediaStreamUrl: 'wss://agent.example/media',
  });
  assert.equal(placed.callId, 'v3:call-1');
  assert.equal(json(tx.sent[0]).connection_id, 'app-1');
  assert.equal(json(tx.sent[0]).stream_bidirectional_mode, 'rtp');
  assert.equal((await telnyxProvider.getCall({ callId: 'v3:call-1' })).status, 'in-progress');

  await telnyxProvider.transferCall({ callId: 'v3:call-1', to: 'sip:human@desk.example', timeoutSeconds: 20 });
  assert.deepEqual(json(tx.sent.at(-1)), { to: 'sip:human@desk.example', timeout_secs: 20 });
  const joined = await telnyxProvider.joinConference({ callId: 'v3:call-1', name: 'standup', muted: true });
  assert.equal(joined.conferenceId, 'conf-9', 'a running conference of that name is joined');
  assert.match(tx.sent.at(-1)?.url ?? '', /\/conferences\/conf-9\/actions\/join$/);
  assert.deepEqual(json(tx.sent.at(-1)), { call_control_id: 'v3:call-1', mute: true });
  const created = await telnyxProvider.joinConference({ callId: 'v3:call-1', name: 'new-room', beep: false });
  assert.equal(created.conferenceId, 'conf-new', 'and one is created when none runs');
  assert.deepEqual(json(tx.sent.at(-1)), {
    call_control_id: 'v3:call-1',
    name: 'new-room',
    start_conference_on_create: true,
    beep_enabled: 'never',
  });
  assert.equal((await telnyxProvider.endCall({ callId: 'v3:call-1' })).status, 'completed');
  assert.match(tx.sent.at(-1)?.url ?? '', /\/actions\/hangup$/);

  const tw = twilioApi();
  const twilioProvider = twilio(tw.fetch);
  await twilioProvider.transferCall({ callId: 'CA1', to: '+15551234', from: '+15559999' });
  assert.match(form(tw.sent[0]).get('Twiml') ?? '', /<Dial callerId="\+15559999"><Number>\+15551234<\/Number><\/Dial>/);
  await twilioProvider.joinConference({ callId: 'CA1', name: 'standup', startOnEnter: false, endOnExit: true });
  assert.match(
    form(tw.sent[1]).get('Twiml') ?? '',
    /<Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true">standup<\/Conference><\/Dial>/,
  );
});

test('recordings are started, reported, fetched, and deleted on both providers', async () => {
  const tx = telnyxApi();
  const telnyxProvider = telnyx(tx.fetch);
  await telnyxProvider.startRecording({ callId: 'v3:call-1' });
  assert.deepEqual(json(tx.sent[0]), { format: 'mp3', channels: 'dual' });
  const saved = telnyxProvider.parseRecordingCallback({
    data: {
      event_type: 'call.recording.saved',
      payload: {
        call_control_id: 'v3:call-1',
        recording_id: 'rec-1',
        channels: 'dual',
        recording_started_at: '2026-10-18T10:00:00Z',
        recording_ended_at: '2026-10-18T10:01:30Z',
        recording_urls: { mp3: 'https://s3.example/expired.mp3' },
      },
    },
  });
  assert.equal(saved?.durationSeconds, 90);
  assert.equal(saved?.recordingId, 'rec-1');
  const audio = await telnyxProvider.downloadRecording({ recording: saved as NonNullable<typeof saved> });
  assert.deepEqual(Array.from(audio.bytes), [73, 68, 51, 1], 'an expired link is renewed through the recording');
  assert.equal(
    tx.sent.find((request) => request.url === 'https://s3.example/expired.mp3')?.headers.authorization,
    undefined,
    'a presigned link is fetched without the API key',
  );
  await telnyxProvider.deleteRecording({ recordingId: 'rec-1' });
  assert.equal(tx.sent.at(-1)?.method, 'DELETE');
  assert.equal(
    telnyxProvider.parseRecordingCallback({ data: { event_type: 'call.answered', payload: {} } }),
    undefined,
  );

  const tw = twilioApi();
  const twilioProvider = twilio(tw.fetch);
  const started = await twilioProvider.startRecording({ callId: 'CA1', statusCallbackUrl: 'https://app.example/rec' });
  assert.equal(started.recordingId, 'RE1');
  assert.equal(form(tw.sent[0]).get('RecordingChannels'), 'dual');
  assert.equal(form(tw.sent[0]).get('RecordingStatusCallback'), 'https://app.example/rec');
  const reported = twilioProvider.parseRecordingCallback(
    'RecordingSid=RE1&CallSid=CA1&RecordingStatus=completed&RecordingDuration=42&RecordingChannels=2&RecordingUrl=https%3A%2F%2Fapi.twilio.com%2F2010-04-01%2FAccounts%2FAC1%2FRecordings%2FRE1',
  );
  assert.equal(reported?.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3');
  const twilioAudio = await twilioProvider.downloadRecording({ recording: reported as NonNullable<typeof reported> });
  assert.deepEqual(Array.from(twilioAudio.bytes), [73, 68, 51, 2]);
  assert.match(
    tw.sent.at(-1)?.headers.authorization ?? '',
    /^Basic /,
    "Twilio's media is fetched with the account's credentials",
  );
  await twilioProvider.deleteRecording({ recordingId: 'RE1' });
  assert.equal(tw.sent.at(-1)?.method, 'DELETE');
  assert.equal(
    twilioProvider.parseRecordingCallback('RecordingSid=RE1&RecordingStatus=in-progress&RecordingUrl=x'),
    undefined,
  );
});

test('messages are sent, received, and tracked on both providers, as their own operation family', async () => {
  const seen: Array<{ family: string; operation: string }> = [];
  const tx = telnyxApi();
  const tw = twilioApi();
  const manager = new TelephonyManager(
    { providers: { telnyx: telnyx(tx.fetch, { messagingProfileId: 'mp-1' }), twilio: twilio(tw.fetch) } },
    {
      lifecycle: new OperationLifecycle({
        config: {
          authorize: (operation) => {
            seen.push({ family: operation.family, operation: operation.operation });
            return true;
          },
        },
      }),
    },
  );
  const viaTelnyx = await manager.sendMessage({
    provider: 'telnyx',
    to: '+15550001',
    from: '+15559999',
    body: 'Your order shipped',
  });
  assert.equal(viaTelnyx.status, 'queued');
  assert.deepEqual(json(tx.sent.at(-1)), {
    from: '+15559999',
    to: '+15550001',
    text: 'Your order shipped',
    messaging_profile_id: 'mp-1',
  });
  const viaTwilio = await manager.sendMessage({
    provider: 'twilio',
    to: '+15550001',
    from: '+15559999',
    body: 'Your receipt',
    mediaUrls: ['https://app.example/receipt.png'],
  });
  assert.equal(viaTwilio.messageId, 'SM1');
  assert.equal(form(tw.sent.at(-1)).get('MediaUrl'), 'https://app.example/receipt.png');
  await assert.rejects(
    manager.sendMessage({ provider: 'twilio', to: '+1', from: '+2' }),
    /needs a body, media, or both/,
  );

  const received = manager.parseMessageWebhook('telnyx', {
    data: {
      event_type: 'message.received',
      payload: {
        id: 'msg-in',
        from: { phone_number: '+15550001' },
        to: [{ phone_number: '+15559999' }],
        text: 'STOP',
        media: [{ url: 'https://media.example/a.jpg' }],
      },
    },
  });
  assert.deepEqual(
    [received?.direction, received?.status, received?.body, received?.mediaUrls],
    ['inbound', 'received', 'STOP', ['https://media.example/a.jpg']],
  );
  const finalized = manager.parseMessageWebhook('telnyx', {
    data: {
      event_type: 'message.finalized',
      payload: { id: 'msg-1', to: [{ phone_number: '+15550001', status: 'delivered' }] },
    },
  });
  assert.equal(finalized?.status, 'delivered');
  const twilioIn = manager.parseMessageWebhook(
    'twilio',
    'MessageSid=SM9&SmsStatus=received&From=%2B15550001&To=%2B15559999&Body=hi&NumMedia=1&MediaUrl0=https%3A%2F%2Fm.example%2F1',
  );
  assert.deepEqual([twilioIn?.direction, twilioIn?.mediaUrls], ['inbound', ['https://m.example/1']]);
  assert.equal(
    manager.parseMessageWebhook('twilio', 'MessageSid=SM1&MessageStatus=undelivered&ErrorCode=30003')?.errorCode,
    '30003',
  );
  assert.deepEqual(
    seen.filter((operation) => operation.operation === 'sendMessage').map((operation) => operation.family),
    ['messaging', 'messaging'],
    'a message is a messaging operation, apart from calls',
  );
});

test("Telnyx webhooks are verified with Ed25519, and its call events and media streams read as Twilio's do", async () => {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
  const now = Date.parse('2026-10-18T10:00:00Z');
  const provider = telnyx(telnyxApi().fetch, { publicKey, now: () => now });
  const body = JSON.stringify({
    data: {
      event_type: 'call.hangup',
      payload: {
        call_control_id: 'v3:call-1',
        direction: 'incoming',
        from: '+15550001',
        to: '+15559999',
        hangup_cause: 'normal_clearing',
        start_time: '2026-10-18T09:58:00Z',
        end_time: '2026-10-18T09:59:15Z',
      },
    },
  });
  const sign = async (timestamp: string, signed: string) =>
    Buffer.from(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        new TextEncoder().encode(`${timestamp}|${signed}`),
      ),
    ).toString('base64');
  const timestamp = String(now / 1_000);
  const headers = { 'Telnyx-Signature-Ed25519': await sign(timestamp, body), 'Telnyx-Timestamp': timestamp };
  assert.equal(await provider.validateWebhook({ url: 'https://app.example/telnyx', headers, body }), true);
  assert.equal(
    await provider.validateWebhook({ url: '', headers, body: body.replace('normal_clearing', 'user_busy') }),
    false,
    'altered',
  );
  const stale = String(now / 1_000 - 600);
  assert.equal(
    await provider.validateWebhook({
      url: '',
      headers: { 'Telnyx-Signature-Ed25519': await sign(stale, body), 'Telnyx-Timestamp': stale },
      body,
    }),
    false,
    'too old',
  );
  assert.equal(await provider.validateWebhook({ url: '', headers: {}, body }), false, 'unsigned');

  const hangup = provider.parseStatusCallback(body);
  assert.deepEqual(
    [hangup?.status, hangup?.direction, hangup?.durationSeconds, hangup?.endedReason],
    ['completed', 'inbound', 75, 'normal_clearing'],
  );
  assert.equal(
    provider.parseStatusCallback({
      data: { event_type: 'call.initiated', payload: { direction: 'incoming', call_control_id: 'c' } },
    } as never)?.status,
    'ringing',
  );
  assert.equal(
    provider.parseStatusCallback({
      data: { event_type: 'call.hangup', payload: { hangup_cause: 'user_busy', call_control_id: 'c' } },
    } as never)?.status,
    'busy',
  );

  const start = provider.parseMediaStreamEvent(
    '{"event":"start","stream_id":"s-1","start":{"call_control_id":"v3:call-1","media_format":{"encoding":"PCMU","sample_rate":8000,"channels":1}}}',
  );
  assert.deepEqual(start?.event === 'start' ? [start.streamId, start.callId, start.mediaFormat] : [], [
    's-1',
    'v3:call-1',
    { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  ]);
  const media = provider.parseMediaStreamEvent({
    event: 'media',
    stream_id: 's-1',
    media: { track: 'inbound', payload: 'AAAA', chunk: '2' },
  });
  assert.deepEqual(media?.event === 'media' ? [media.payload, media.track, media.chunk] : [], ['AAAA', 'inbound', 2]);
  assert.equal(
    provider.parseMediaStreamEvent({ event: 'dtmf', stream_id: 's-1', dtmf: { digit: '5' } })?.event,
    'dtmf',
  );
  assert.equal(
    provider.parseMediaStreamEvent({ event: 'stop', stream_id: 's-1', stop: { call_control_id: 'v3:call-1' } })?.event,
    'stop',
  );
  assert.equal(provider.formatAudioMessage('s-1', 'BBBB').body, '{"event":"media","media":{"payload":"BBBB"}}');
  assert.equal(provider.formatAudioMessage('s-1', '', { event: 'clear' }).body, '{"event":"clear"}');
  assert.equal(
    provider.formatAudioMessage('s-1', 'm1', { event: 'mark' }).body,
    '{"event":"mark","mark":{"name":"m1"}}',
  );
});

test("Telnyx numbers send calls and messages to their application's and profile's webhooks", async () => {
  const tx = telnyxApi();
  const provider = telnyx(tx.fetch);
  const [number] = await provider.listPhoneNumbers({ phoneNumber: '+15559999' });
  assert.deepEqual([number?.id, number?.capabilities], ['num-1', { voice: true, sms: true, mms: true }]);
  assert.match(tx.sent[0]?.url ?? '', /filter%5Bphone_number%5D=%2B15559999/);
  const updated = await provider.updatePhoneNumber({
    id: 'num-1',
    voiceUrl: 'https://app.example/voice',
    smsUrl: 'https://app.example/sms',
  });
  assert.deepEqual([updated.voiceUrl, updated.smsUrl], ['https://app.example/voice', 'https://app.example/sms']);
  const patches = tx.sent.filter((request) => request.method === 'PATCH');
  assert.deepEqual(
    patches.map((request) => [new URL(request.url).pathname, json(request)]),
    [
      ['/v2/call_control_applications/app-1', { webhook_event_url: 'https://app.example/voice' }],
      ['/v2/messaging_profiles/mp-1', { webhook_url: 'https://app.example/sms' }],
    ],
  );
});
