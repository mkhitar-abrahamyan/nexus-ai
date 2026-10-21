/**
 * Media that knows its length: read from the file's own headers, for every container the package
 * reads, against the length its encoder wrote.
 *
 * The fixtures in `tests/fixtures/media` were encoded by ffmpeg 7.1, and `durations.json` holds the
 * length ffprobe reads from each. Every one is read to the millisecond. A media check holds a clip to a
 * range, and a video longer than Gemini Omni Flash takes is refused before anything is sent.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mediaChecks, readMediaDuration, resolveMedia } from '../src/evaluate/media.js';
import type { EvaluationContext, EvaluationScore } from '../src/types/evaluate.js';
import { GoogleVideoProvider } from '../src/video/google.js';
import { VideoManager } from '../src/video/index.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url)));
const encoded = JSON.parse(readFileSync(new URL('./fixtures/media/durations.json', import.meta.url), 'utf8')) as Record<
  string,
  number
>;

test('proof: the length of every container is read from its headers, as its encoder wrote it', () => {
  const kinds: Record<string, [string, 'audio' | 'video']> = {
    'clip.mp4': ['video/mp4', 'video'],
    'clip.mov': ['video/quicktime', 'video'],
    'clip-fragmented.mp4': ['video/mp4', 'video'],
    'tone.m4a': ['audio/mp4', 'audio'],
    'clip.webm': ['video/webm', 'video'],
    'tone.webm': ['audio/webm', 'audio'],
    'clip.mkv': ['video/x-matroska', 'video'],
    'tone-vbr.mp3': ['audio/mpeg', 'audio'],
    'tone-cbr.mp3': ['audio/mpeg', 'audio'],
    'tone-bare.mp3': ['audio/mpeg', 'audio'],
    'tone.ogg': ['audio/ogg', 'audio'],
    'tone.opus': ['audio/ogg', 'audio'],
    'tone.flac': ['audio/flac', 'audio'],
    'tone.wav': ['audio/wav', 'audio'],
  };
  assert.deepEqual(Object.keys(encoded).sort(), Object.keys(kinds).sort(), 'every fixture is checked');
  for (const [file, [mimeType, kind]] of Object.entries(kinds)) {
    let expected = Math.round((encoded[file] as number) * 1000);
    // ffprobe counts an Opus stream's pre-skip, 312 samples at 48 kHz; its length leaves them out,
    // as RFC 7845 says, which is the 2.6 seconds the encoder was asked for.
    if (file === 'tone.opus') expected -= Math.round((312 / 48_000) * 1000);
    assert.deepEqual(readMediaDuration(fixture(file)), { durationMs: expected, mimeType, kind }, file);
  }
  assert.equal(readMediaDuration(fixture('tone.opus'))?.durationMs, 2600);

  // Matroska's ticks are TimecodeScale nanoseconds: ffmpeg writes the default, a million; at twice
  // that, the same Duration is twice as long.
  const webm = fixture('clip.webm').slice();
  const scale = Buffer.from(webm).indexOf(Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]));
  assert.ok(scale > 0, 'the fixture writes the default TimecodeScale');
  webm.set([0x1e, 0x84, 0x80], scale + 4);
  assert.equal(readMediaDuration(webm)?.durationMs, 4000);
});

/** An ISO base media box: its size, its type, and its payload. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of payload) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test('an MP4 whose movie header is version 1 says a length past 32 bits, as fourteen hours at 90 kHz does', () => {
  // mvhd version 1: version and flags, 64-bit creation and modification times, timescale, 64-bit duration.
  const mvhd = new Uint8Array(4 + 8 + 8 + 4 + 8);
  mvhd[0] = 1;
  const fields = new DataView(mvhd.buffer);
  fields.setUint32(20, 90_000);
  fields.setBigUint64(24, 90_000n * 60n * 60n * 14n);
  // hdlr: version and flags, pre-defined, then the handler type.
  const hdlr = new Uint8Array(12);
  hdlr.set(new TextEncoder().encode('vide'), 8);
  const file = Uint8Array.from([
    ...box('ftyp', new TextEncoder().encode('isom\0\0\0\0')),
    ...box('moov', box('mvhd', mvhd), box('trak', box('mdia', box('hdlr', hdlr)))),
  ]);
  assert.deepEqual(readMediaDuration(file), { durationMs: 14 * 60 * 60 * 1000, mimeType: 'video/mp4', kind: 'video' });
});

test('bytes that are no container, or that stop short, or that lie, have no length, and never throw', () => {
  assert.equal(readMediaDuration(new Uint8Array(0)), undefined);
  assert.equal(readMediaDuration(new TextEncoder().encode('just some text, not a video')), undefined);
  // Noise that happens to hold one MPEG sync word is not read as an MP3.
  assert.equal(readMediaDuration(Uint8Array.from([0x00, 0xff, 0xfb, 0x90, 0x00, 0x13, 0x37, 0x42])), undefined);
  const mp4 = fixture('clip.mp4');
  // ffmpeg writes the movie header last: a file cut before it says no length.
  assert.equal(readMediaDuration(mp4.subarray(0, 4096)), undefined);
  const lying = mp4.slice();
  new DataView(lying.buffer).setUint32(0, 0xffffff00);
  assert.doesNotThrow(() => readMediaDuration(lying));
  assert.equal(
    readMediaDuration(fixture('tone.ogg').subarray(0, 100)),
    undefined,
    'an Ogg stream cut before its last page',
  );
});

const context = (output: unknown): EvaluationContext => ({
  example: { id: 'ex', inputs: {} },
  output,
  latencyMs: 1,
  run: 0,
});
const byKey = (scores: unknown) => new Map((scores as EvaluationScore[]).map((score) => [score.key, score]));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

test('a media check holds video and compressed audio to their lengths', async () => {
  // A video by its path, read with the checks' `readFile`; audio inline.
  const readFile = async (path: string) => fixture(path);
  const output = {
    clip: { type: 'video', source: { path: 'clip.webm' } },
    voice: { type: 'audio', source: { base64: b64(fixture('tone-vbr.mp3')) } },
  };
  const short = byKey(await mediaChecks({ durationMs: { max: 2_500 }, readFile })(context(output)));
  assert.equal(short.get('media.duration')?.score, 0.5, 'the 2,000 ms video fits, the 2,880 ms MP3 does not');
  assert.match(short.get('media.duration')?.comment ?? '', /2880 ms is not at most 2500 ms/);
  const fits = byKey(
    await mediaChecks({ durationMs: { min: 1_500, max: 3_000 }, kinds: ['video', 'audio'], readFile })(context(output)),
  );
  assert.deepEqual([fits.get('media.duration')?.score, fits.get('media.format')?.score], [1, 1]);
  const resolved = await resolveMedia({ type: 'video', source: { path: 'clip.mp4' } }, { readFile });
  assert.deepEqual([resolved.kind, resolved.mimeType, resolved.durationMs], ['video', 'video/mp4', 2500]);
});

test('a video longer than the model takes is refused before anything is sent, and one within is sent', async () => {
  const sent: string[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push(`${init.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify({ id: 'int-1', status: 'in_progress' }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  const manager = new VideoManager({ providers: { omni: new GoogleVideoProvider({ apiKey: 'key', fetch }) } });
  // The same clip, its movie header saying twelve seconds.
  const long = fixture('clip.mp4').slice();
  const at = Buffer.from(long).indexOf('mvhd') + 4;
  const view = new DataView(long.buffer);
  const timescale = view.getUint32(at + 12);
  view.setUint32(at + 16, timescale * 12);
  assert.equal(readMediaDuration(long)?.durationMs, 12_000);
  await assert.rejects(
    manager.start({
      prompt: 'Make it night',
      video: { mode: 'edit', input: { location: { kind: 'bytes', data: long }, mimeType: 'video/mp4' } },
    }),
    /does not take a 12\.0-second video for "gemini-omni-1\.1-flash"; it takes at most 10 seconds/,
  );
  assert.deepEqual(sent, [], 'nothing was uploaded');
  await manager.start({
    prompt: 'Make it night',
    video: { mode: 'edit', input: { location: { kind: 'bytes', data: fixture('clip.mp4') }, mimeType: 'video/mp4' } },
  });
  assert.deepEqual(
    sent,
    ['POST https://generativelanguage.googleapis.com/v1beta/interactions'],
    'a 2.5-second clip is sent',
  );
});
