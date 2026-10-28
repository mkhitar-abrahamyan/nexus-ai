/**
 * Gemini as a voice provider: speech in one of its voices, as WAV or raw PCM whichever its model
 * answers with, directed by a system instruction and never by spoken words; and transcription by a
 * text model that hears the audio, guided by its language and the names it may hold, refused where it
 * cannot answer with timings.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { VoiceProviderError } from '../src/voice/errors.js';
import { VoiceManager } from '../src/voice/manager.js';
import { GoogleVoiceProvider } from '../src/voice/providers/google.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-gemini-voice-'));
after(() => rmSync(work, { recursive: true, force: true }));

const tone = new Uint8Array(readFileSync(new URL('./fixtures/media/tone.wav', import.meta.url)));
const pcm = new Uint8Array(Array.from({ length: 480 }, (_, index) => index % 256));

/** A WAV header and samples, at a rate, as a newer speech model answers. */
function wav(samples: Uint8Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(samples)]));
}

/** Gemini's generateContent, recording each request and answering as told. */
function gemini(answer: (body: Record<string, unknown>) => unknown, status = 200) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.includes(':generateContent')) {
      return url.endsWith('/missing.wav') ? new Response('gone', { status: 404 }) : new Response(Buffer.from(tone));
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, headers: new Headers(init.headers), body });
    return new Response(JSON.stringify(answer(body)), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** The voice a request asked for. */
const voiceNameOf = (call: { body: Record<string, unknown> } | undefined) =>
  (
    call?.body.generationConfig as
      | { speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } } }
      | undefined
  )?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;

const audioAnswer = (data: Uint8Array, mimeType: string) => ({
  modelVersion: 'gemini-3.8-flash-tts-001',
  candidates: [{ content: { parts: [{ inlineData: { mimeType, data: Buffer.from(data).toString('base64') } }] } }],
});

test('speech in a Gemini voice comes back as WAV, whichever its model answers with, or as raw PCM', async () => {
  // An older model's raw PCM is given a WAV header at the rate it names.
  const older = gemini(() => audioAnswer(pcm, 'audio/L16;codec=pcm;rate=16000'));
  const voice = new GoogleVoiceProvider({ apiKey: 'g-key', fetch: older.fetch });
  const spoken = await voice.speak({ text: 'Your order has shipped.' });
  const [call] = older.calls;
  assert.equal(
    call?.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent',
  );
  assert.equal(call?.headers.get('x-goog-api-key'), 'g-key');
  assert.deepEqual(call?.body, {
    contents: [{ role: 'user', parts: [{ text: 'Your order has shipped.' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  });
  const header = Buffer.from(spoken.audio.data);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(24), 16_000, 'the rate the model named');
  assert.equal(header.readUInt32LE(28), 32_000);
  assert.equal(header.readUInt32LE(40), pcm.length);
  assert.equal(header.readUInt32LE(4), 36 + pcm.length);
  assert.deepEqual([...spoken.audio.data.subarray(44)], [...pcm]);
  assert.deepEqual(
    [spoken.format, spoken.mimeType, spoken.audio.mimeType, spoken.voice, spoken.modelUsed, spoken.providerUsed],
    ['wav', 'audio/wav', 'audio/wav', 'Kore', 'gemini-3.8-flash-tts-001', 'google'],
  );
  // Without a rate named, 24 kHz.
  const unnamed = gemini(() => audioAnswer(pcm, 'audio/L16'));
  const plain = await new GoogleVoiceProvider({ apiKey: 'k', fetch: unnamed.fetch }).speak({ text: 'x' });
  assert.equal(Buffer.from(plain.audio.data).readUInt32LE(24), 24_000);

  // A newer model's WAV is kept as it is, or its samples taken alone.
  const newer = gemini(() => audioAnswer(wav(pcm, 24_000), 'audio/wav'));
  const current = new GoogleVoiceProvider({
    apiKey: 'k',
    fetch: newer.fetch,
    defaultVoice: 'Puck',
    speechModel: 'models/tts-x',
  });
  const asWav = await current.speak({ text: 'Hi' });
  assert.deepEqual([...asWav.audio.data], [...wav(pcm, 24_000)]);
  assert.equal(
    newer.calls[0]?.url,
    'https://generativelanguage.googleapis.com/v1beta/models/tts-x:generateContent',
    'a model named in full',
  );
  assert.equal(asWav.voice, 'Puck', 'the configured voice');
  assert.equal(voiceNameOf(newer.calls[0]), 'Puck');
  const asPcm = await current.speak({
    text: 'Hi',
    format: 'pcm',
    voice: 'Charon',
    model: 'gemini-3.1-flash-tts-preview',
  });
  assert.deepEqual([...asPcm.audio.data], [...pcm], 'the header removed');
  assert.deepEqual([asPcm.format, asPcm.mimeType, asPcm.voice], ['pcm', 'audio/L16;rate=24000', 'Charon']);
  assert.equal(voiceNameOf(newer.calls[1]), 'Charon');
  assert.ok(newer.calls[1]?.url.includes('/models/gemini-3.1-flash-tts-preview:'), 'the request’s own model');
  const rawPcm = await new GoogleVoiceProvider({ apiKey: 'k', fetch: older.fetch }).speak({ text: 'x', format: 'pcm' });
  assert.deepEqual([...rawPcm.audio.data], [...pcm], 'raw PCM as it came');
  assert.equal(rawPcm.mimeType, 'audio/L16;rate=16000');
  const rated = gemini(() => audioAnswer(wav(pcm, 16_000), 'audio/wav'));
  const ratedPcm = await new GoogleVoiceProvider({ apiKey: 'k', fetch: rated.fetch }).speak({
    text: 'x',
    format: 'pcm',
  });
  assert.equal(ratedPcm.mimeType, 'audio/L16;rate=16000', 'the WAV’s own rate');

  // Directions go to the model as a system instruction, never into the words it speaks.
  await current.speak({ text: 'We are closed today.', instructions: 'Calm and apologetic.', speed: 1.25 });
  assert.deepEqual(newer.calls.at(-1)?.body.systemInstruction, {
    parts: [{ text: 'Calm and apologetic. Speak at 1.25 times the usual pace.' }],
  });
  assert.deepEqual(newer.calls.at(-1)?.body.contents, [{ role: 'user', parts: [{ text: 'We are closed today.' }] }]);
  await current.speak({ text: 'x', speed: 1 });
  assert.equal(newer.calls.at(-1)?.body.systemInstruction, undefined, 'the usual pace needs no direction');
  await current.speak({ text: 'x', speed: 0.8 });
  assert.deepEqual(newer.calls.at(-1)?.body.systemInstruction, {
    parts: [{ text: 'Speak at 0.8 times the usual pace.' }],
  });

  // A format Gemini cannot produce is refused before any call, and an answer with no audio is a failure.
  const before = newer.calls.length;
  await assert.rejects(current.speak({ text: 'x', format: 'mp3' }), /Gemini speaks WAV or raw PCM, not mp3/);
  assert.equal(newer.calls.length, before);
  const silent = gemini(() => ({ candidates: [{ content: { parts: [{ text: 'no' }] } }] }));
  await assert.rejects(
    new GoogleVoiceProvider({ apiKey: 'k', fetch: silent.fetch }).speak({ text: 'x' }),
    (error: unknown) => error instanceof VoiceProviderError && /answered with no audio/.test(error.message),
  );
});

test('a transcript is the words Gemini hears, guided by the language and the names it may hold', async () => {
  const api = gemini(() => ({
    modelVersion: 'gemini-3.8-flash-002',
    candidates: [{ content: { parts: [{ text: '  Hello, ' }, { text: 'Anouk.\n' }] } }],
  }));
  const voice = new GoogleVoiceProvider({ apiKey: 'k', fetch: api.fetch });
  const heard = await voice.transcribe({
    audio: { buffer: tone },
    language: 'nl',
    prompt: 'Anouk, Zuidas',
    temperature: 0.2,
  });
  assert.deepEqual(
    [heard.text, heard.providerUsed, heard.modelUsed, heard.language, heard.durationSeconds],
    ['Hello, Anouk.', 'google', 'gemini-3.8-flash-002', 'nl', 1.2],
  );
  const [call] = api.calls;
  assert.equal(call?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.deepEqual(call?.body, {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Transcribe the speech in this audio word for word, in the language it is spoken in. It is in nl. Names and spellings it may hold: Anouk, Zuidas Answer with the transcript alone.',
          },
          { inlineData: { mimeType: 'audio/wav', data: Buffer.from(tone).toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0.2 },
  });

  // Every way audio arrives: base64, a file, a stream, a URL fetched, and a Files API URI by reference.
  const file = path.join(work, 'note.mp3');
  writeFileSync(file, Buffer.from('ID3 not really mp3'));
  await voice.transcribe({ audio: { base64: Buffer.from(tone).toString('base64') } });
  await voice.transcribe({ audio: { path: file } });
  await voice.transcribe({
    audio: { stream: Readable.from([Buffer.from(tone.subarray(0, 100)), Buffer.from(tone.subarray(100))]) },
  });
  await voice.transcribe({ audio: { url: 'https://media.example/call.wav' } });
  await voice.transcribe({
    audio: { url: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mp3' },
  });
  await voice.transcribe({ audio: { url: 'https://generativelanguage.googleapis.com/v1beta/files/def.flac' } });
  await voice.transcribe({ audio: { buffer: Buffer.from('raw'), filename: 'call.ogg' } });
  await voice.transcribe({ audio: { buffer: new Uint8Array([1, 2, 3]).buffer } });
  const mp3 = new Uint8Array(readFileSync(new URL('./fixtures/media/tone-cbr.mp3', import.meta.url)));
  await voice.transcribe({ audio: { buffer: mp3 } });
  const parts = api.calls
    .slice(1)
    .map((recorded) => (recorded.body.contents as Array<{ parts: unknown[] }>)[0]?.parts[1]);
  assert.deepEqual(parts, [
    { inlineData: { mimeType: 'audio/wav', data: Buffer.from(tone).toString('base64') } },
    { inlineData: { mimeType: 'audio/mp3', data: Buffer.from('ID3 not really mp3').toString('base64') } },
    { inlineData: { mimeType: 'audio/wav', data: Buffer.from(tone).toString('base64') } },
    { inlineData: { mimeType: 'audio/wav', data: Buffer.from(tone).toString('base64') } },
    { fileData: { mimeType: 'audio/mp3', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } },
    {
      fileData: { mimeType: 'audio/flac', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/def.flac' },
    },
    { inlineData: { mimeType: 'audio/ogg', data: Buffer.from('raw').toString('base64') } },
    { inlineData: { mimeType: 'audio/wav', data: Buffer.from([1, 2, 3]).toString('base64') } },
    { inlineData: { mimeType: 'audio/mpeg', data: Buffer.from(mp3).toString('base64') } },
  ]);
  const plainCall = api.calls[1]?.body as {
    contents: Array<{ parts: Array<{ text?: string }> }>;
    generationConfig: unknown;
  };
  assert.equal(
    plainCall.contents[0]?.parts[0]?.text,
    'Transcribe the speech in this audio word for word, in the language it is spoken in. Answer with the transcript alone.',
  );
  assert.deepEqual(plainCall.generationConfig, { temperature: 0 }, 'as steady as it can be, by default');
  const referenced = await voice.transcribe({
    audio: { url: 'https://generativelanguage.googleapis.com/v1beta/files/x' },
  });
  assert.equal(referenced.durationSeconds, undefined, 'a file it never read has no known length');
  assert.equal(
    (await voice.transcribe({ audio: { buffer: tone }, model: 'gemini-3.5-flash' })).modelUsed,
    'gemini-3.8-flash-002',
  );
  assert.ok(api.calls.at(-1)?.url.includes('/models/gemini-3.5-flash:'));

  // Refused where it cannot answer: timings, subtitles, audio too large to send inline, or a URL that fails.
  for (const asked of [
    { responseFormat: 'verbose_json' as const },
    { responseFormat: 'srt' as const },
    { responseFormat: 'vtt' as const },
    { timestampGranularities: ['word' as const] },
  ]) {
    await assert.rejects(
      voice.transcribe({ audio: { buffer: tone }, ...asked }),
      /without timings or subtitles; ask for json or text/,
    );
  }
  assert.equal((await voice.transcribe({ audio: { buffer: tone }, responseFormat: 'text' })).text, 'Hello, Anouk.');
  await assert.rejects(
    voice.transcribe({ audio: { buffer: new Uint8Array(15 * 1024 * 1024) } }),
    /The audio is 15 MB; Gemini takes at most 14 MB inline, so upload it to the Files API/,
  );
  await assert.rejects(voice.transcribe({ audio: { url: 'https://media.example/missing.wav' } }), /answered 404/);
  const failing = gemini(() => ({ error: { message: 'quota' } }), 429);
  await assert.rejects(
    new GoogleVoiceProvider({ apiKey: 'k', fetch: failing.fetch }).transcribe({ audio: { buffer: tone } }),
    (error: unknown) =>
      error instanceof VoiceProviderError && error.provider === 'google' && /failed: 429/.test(error.message),
  );
});

test('a tenant’s key replaces the configured one, and the manager routes to Gemini by name', async () => {
  const api = gemini(() => audioAnswer(pcm, 'audio/L16;rate=24000'));
  const voice = new VoiceManager({
    providers: { google: new GoogleVoiceProvider({ apiKey: 'shared', fetch: api.fetch, headers: { 'x-trace': 't' } }) },
    defaultSpeechProvider: 'google',
  });
  const spoken = await voice.speak({ text: 'Hello' });
  assert.equal(spoken.providerUsed, 'google');
  assert.equal(api.calls[0]?.headers.get('x-trace'), 't');
  const tenant = new GoogleVoiceProvider({ apiKey: 'shared', fetch: api.fetch });
  await tenant.speak({ text: 'x' }, {
    signal: new AbortController().signal,
    credential: async () => ({ apiKey: 'acme-key', headers: { 'x-tenant': 'acme' } }),
  } as never);
  assert.equal(api.calls.at(-1)?.headers.get('x-goog-api-key'), 'acme-key');
  assert.equal(api.calls.at(-1)?.headers.get('x-tenant'), 'acme');
  assert.equal(new GoogleVoiceProvider({ apiKey: 'k' }).info.supports?.speech, true);
  assert.equal(new GoogleVoiceProvider({ apiKey: 'k' }).info.supports?.transcription, true);
});
