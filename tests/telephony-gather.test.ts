/**
 * A gather of speech on both providers: Twilio's `<Gather input="speech">`, and on Telnyx a
 * transcription of the caller's side started with the gather and stopped by `endGather()`; and what
 * either collected, speech or keys, parsed into one shape.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelephonyManager } from '../src/telephony/manager.js';
import { TelnyxTelephonyProvider } from '../src/telephony/providers/telnyx.js';
import { TwilioTelephonyProvider } from '../src/telephony/providers/twilio.js';

/** Telnyx's Call Control in this process: every command recorded and accepted. */
function telnyxApi() {
  const sent: Array<{ action: string; body: Record<string, unknown>; url: string }> = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = decodeURIComponent(String(input));
    sent.push({ action: url.split('/').pop() ?? '', body: JSON.parse(String(init.body ?? '{}')), url });
    return Response.json({ data: { result: 'ok' } });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const telnyxWebhook = (event_type: string, payload: Record<string, unknown>) => ({
  data: { event_type, id: 'evt-1', payload: { call_control_id: 'v3:call-1', ...payload } },
});

test('on Telnyx, a speech gather transcribes the caller, with its prompts spoken and keys still taken', async () => {
  const calls = telnyxApi();
  const manager = new TelephonyManager({
    providers: {
      telnyx: new TelnyxTelephonyProvider({ apiKey: 'KEY', fetch: calls.fetch, transcriptionEngine: 'Deepgram' }),
    },
  });
  await manager.answer({
    provider: 'telnyx',
    callId: 'v3:call-1',
    gather: { input: ['speech'], language: 'nl-NL', prompts: ['Waar kan ik u mee helpen?'] },
  });
  assert.deepEqual(
    calls.sent.map((sent) => sent.action),
    ['answer', 'transcription_start', 'speak'],
  );
  assert.deepEqual(calls.sent[1]?.body, {
    language: 'nl-NL',
    transcription_tracks: 'inbound',
    transcription_engine: 'Deepgram',
  });
  assert.deepEqual(calls.sent[2]?.body, { payload: 'Waar kan ik u mee helpen?', voice: 'female', language: 'nl-NL' });
  assert.ok(calls.sent[1]?.url.endsWith('/calls/v3:call-1/actions/transcription_start'));

  // Speech and keys at once: transcribed, and keys gathered while the prompt is spoken.
  const both = telnyxApi();
  await new TelephonyManager({
    providers: { telnyx: new TelnyxTelephonyProvider({ apiKey: 'KEY', fetch: both.fetch }) },
  }).answer({
    provider: 'telnyx',
    callId: 'v3:call-1',
    gather: { input: ['speech', 'dtmf'], prompts: ['Say or press your account number.'], numDigits: 6 },
  });
  assert.deepEqual(
    both.sent.map((sent) => sent.action),
    ['answer', 'transcription_start', 'gather_using_speak'],
  );
  assert.deepEqual(
    both.sent[1]?.body,
    { language: 'en-US', transcription_tracks: 'inbound' },
    'Telnyx’s own engine, by default',
  );
  assert.equal(both.sent[2]?.body.maximum_digits, 6);

  // Speech alone, without prompts, only listens; keys alone stay as they were.
  const quiet = telnyxApi();
  const provider = new TelnyxTelephonyProvider({ apiKey: 'KEY', fetch: quiet.fetch, language: 'de-DE' });
  await provider.answerCall({ callId: 'v3:call-1', gather: { input: ['speech'] } });
  await provider.answerCall({ callId: 'v3:call-1', gather: { numDigits: 4 } });
  assert.deepEqual(
    quiet.sent.map((sent) => sent.action),
    ['answer', 'transcription_start', 'answer', 'gather'],
  );
  assert.equal(quiet.sent[1]?.body.language, 'de-DE', 'the call’s language');

  // endGather() stops listening.
  await manager.endGather({ provider: 'telnyx', callId: 'v3:call-1' });
  assert.equal(calls.sent.at(-1)?.action, 'transcription_stop');
  assert.ok(calls.sent.at(-1)?.url.endsWith('/calls/v3:call-1/actions/transcription_stop'));
});

test('what a gather collected is one shape on both providers: speech with its confidence, keys, and whether it is final', () => {
  const manager = new TelephonyManager({
    providers: {
      telnyx: new TelnyxTelephonyProvider({ apiKey: 'KEY', fetch: telnyxApi().fetch }),
      twilio: new TwilioTelephonyProvider({ accountSid: 'AC1', authToken: 'token' }),
    },
  });
  const interim = telnyxWebhook('call.transcription', {
    transcription_data: { transcript: 'my account is', confidence: 0.71, is_final: false },
  });
  assert.deepEqual(manager.parseGatherResult('telnyx', interim), {
    providerUsed: 'telnyx',
    callId: 'v3:call-1',
    speech: 'my account is',
    confidence: 0.71,
    final: false,
    raw: interim,
  });
  const finished = JSON.stringify(
    telnyxWebhook('call.transcription', { transcription_data: { transcript: 'my account is 4 2 1', is_final: true } }),
  );
  assert.deepEqual(manager.parseGatherResult('telnyx', finished), {
    providerUsed: 'telnyx',
    callId: 'v3:call-1',
    speech: 'my account is 4 2 1',
    final: true,
    raw: JSON.parse(finished),
  });
  assert.deepEqual(
    manager.parseGatherResult('telnyx', telnyxWebhook('call.gather.ended', { digits: '421', status: 'valid' })),
    {
      providerUsed: 'telnyx',
      callId: 'v3:call-1',
      digits: '421',
      final: true,
      raw: telnyxWebhook('call.gather.ended', { digits: '421', status: 'valid' }),
    },
  );
  assert.equal(
    manager.parseGatherResult('telnyx', telnyxWebhook('call.gather.ended', { status: 'timeout' }))?.digits,
    '',
    'nothing pressed',
  );
  for (const other of [
    telnyxWebhook('call.answered', {}),
    telnyxWebhook('call.speak.ended', { transcription_data: { transcript: 'not a gather', is_final: true } }),
    telnyxWebhook('call.transcription', { transcription_data: {} }),
    'not json',
    { data: {} },
  ]) {
    assert.equal(manager.parseGatherResult('telnyx', other), undefined);
  }

  const spoken = new URLSearchParams({ CallSid: 'CA1', SpeechResult: 'cancel my order', Confidence: '0.92' });
  assert.deepEqual(manager.parseGatherResult('twilio', spoken), {
    providerUsed: 'twilio',
    callId: 'CA1',
    speech: 'cancel my order',
    confidence: 0.92,
    final: true,
    raw: { CallSid: 'CA1', SpeechResult: 'cancel my order', Confidence: '0.92' },
  });
  assert.deepEqual(manager.parseGatherResult('twilio', { CallSid: 'CA1', Digits: '1#' }), {
    providerUsed: 'twilio',
    callId: 'CA1',
    digits: '1#',
    final: true,
    raw: { CallSid: 'CA1', Digits: '1#' },
  });
  assert.deepEqual(
    manager.parseGatherResult('twilio', 'CallSid=CA1&SpeechResult=&Digits=7'),
    {
      providerUsed: 'twilio',
      callId: 'CA1',
      speech: '',
      digits: '7',
      final: true,
      raw: { CallSid: 'CA1', SpeechResult: '', Digits: '7' },
    },
    'speech heard as nothing, and a key',
  );
  assert.equal(
    manager.parseGatherResult('twilio', { CallSid: 'CA1', CallStatus: 'completed' }),
    undefined,
    'a status, not a gather',
  );
  assert.equal(manager.parseGatherResult('twilio', { SpeechResult: 'hi' }), undefined, 'no call');
});

test('a gather that ends by itself, as Twilio’s, has nothing to stop', async () => {
  let requests = 0;
  const manager = new TelephonyManager({
    providers: {
      twilio: new TwilioTelephonyProvider({
        accountSid: 'AC1',
        authToken: 'token',
        fetch: (async () => {
          requests += 1;
          return Response.json({});
        }) as typeof globalThis.fetch,
      }),
    },
  });
  await manager.endGather({ provider: 'twilio', callId: 'CA1' });
  assert.equal(requests, 0);
  const markup = await manager.answer({
    provider: 'twilio',
    callId: 'CA1',
    gather: { input: ['speech'], actionUrl: 'https://agent.example/heard', language: 'en-GB', speechTimeout: 'auto' },
  });
  assert.match(
    markup.body,
    /<Gather input="speech" action="https:\/\/agent.example\/heard"[^>]*speechTimeout="auto"[^>]*language="en-GB"/,
  );
});
