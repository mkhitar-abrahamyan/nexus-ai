import assert from 'node:assert/strict';
import test from 'node:test';
import { NexusAI } from '../src/core/nexus.js';
import { ImageManager } from '../src/images/manager.js';
import { MockImageProvider } from '../src/images/mock.js';
import { AuditLogger } from '../src/ops/audit-logger.js';
import { FamilyTelemetry } from '../src/ops/family-telemetry.js';
import { InMemoryMetrics, MetricsCollector } from '../src/ops/metrics.js';
import { MemoryRateLimitStore } from '../src/ops/rate-limit-adapters.js';
import { NexusRateLimitError, RateLimiter } from '../src/ops/rate-limiter.js';
import { TelephonyManager } from '../src/telephony/manager.js';
import { VoiceProviderError } from '../src/voice/errors.js';
import { VoiceManager } from '../src/voice/manager.js';
import type { AuditLogEvent } from '../src/types/config.js';
import type { TelephonyProvider } from '../src/types/telephony.js';
import type { SpeechResponse, TranscriptionResponse, VoiceProvider } from '../src/types/voice.js';

function collector(): { metrics: MetricsCollector; sink: InMemoryMetrics; counters: () => string[] } {
  const sink = new InMemoryMetrics();
  const metrics = new MetricsCollector({ enabled: true, sink });
  return {
    metrics,
    sink,
    counters: () => Object.keys((sink.snapshot() as { counters: Record<string, number> }).counters),
  };
}

function auditing(): { auditLogger: AuditLogger; events: AuditLogEvent[] } {
  const events: AuditLogEvent[] = [];
  const auditLogger = new AuditLogger({ enabled: true, sink: (event) => void events.push(event) });
  return { auditLogger, events };
}

const mockVoiceProvider: VoiceProvider = {
  info: { name: 'mock-voice', supports: { transcription: true, speech: true } },
  async transcribe(): Promise<TranscriptionResponse> {
    return { text: 'hello', providerUsed: 'mock-voice', modelUsed: 'mock-stt' };
  },
  async speak(): Promise<SpeechResponse> {
    return {
      audio: { data: new Uint8Array([1, 2, 3]), format: 'mp3' },
      providerUsed: 'mock-voice',
      modelUsed: 'mock-tts',
      format: 'mp3',
    };
  },
};

const mockTelephonyProvider: TelephonyProvider = {
  info: { name: 'mock-tel', supports: { outbound: true, callControl: true } },
  async createCall() {
    return {
      callId: 'CA1',
      providerUsed: 'mock-tel',
      status: 'queued' as const,
      direction: 'outbound' as const,
      to: '+15550001111',
      from: '+15550002222',
    };
  },
  async endCall() {
    return { callId: 'CA1', providerUsed: 'mock-tel', status: 'completed' as const };
  },
};

// ── The helper itself ──────────────────────────────────────────────

test('an unwired telemetry is inert and still runs the call', async () => {
  const telemetry = new FamilyTelemetry('images');
  assert.equal(telemetry.inert, true);
  assert.equal(await telemetry.run({ operation: 'generate' }, async () => 'value'), 'value');
});

test('a call records a request, a response, and its latency', async () => {
  const { metrics, counters, sink } = collector();
  const telemetry = new FamilyTelemetry('voice', { metrics });

  await telemetry.run({ operation: 'speak', provider: 'openai', model: 'tts-1' }, async () => 'ok');

  const keys = counters();
  assert.ok(keys.some((key) => key.includes('requests') && key.includes('family=voice')));
  assert.ok(keys.some((key) => key.includes('responses') && key.includes('operation=speak')));
  const histograms = Object.keys((sink.snapshot() as { histograms: Record<string, unknown> }).histograms);
  assert.ok(histograms.some((key) => key.includes('latency_ms')));
});

test('a failing call records an error and rethrows', async () => {
  const { metrics, counters } = collector();
  const telemetry = new FamilyTelemetry('images', { metrics });

  await assert.rejects(
    () => telemetry.run({ operation: 'generate' }, async () => Promise.reject(new Error('provider down'))),
    /provider down/,
  );
  assert.ok(counters().some((key) => key.includes('errors') && key.includes('family=images')));
});

test('a call writes request and response audit events', async () => {
  const { auditLogger, events } = auditing();
  const telemetry = new FamilyTelemetry('telephony', { auditLogger });

  await telemetry.run({ operation: 'createCall', provider: 'twilio', userId: 'u1' }, async () => 'ok');

  assert.deepEqual(
    events.map((event) => event.type),
    ['request', 'response'],
  );
  assert.equal(events[0]?.userId, 'u1');
  assert.equal(events[0]?.metadata?.family, 'telephony');
  assert.equal(events[0]?.metadata?.operation, 'createCall');
});

test('a failing call writes the request event but no response event', async () => {
  const { auditLogger, events } = auditing();
  const telemetry = new FamilyTelemetry('images', { auditLogger });

  await assert.rejects(() => telemetry.run({ operation: 'generate' }, async () => Promise.reject(new Error('no'))));
  assert.deepEqual(
    events.map((event) => event.type),
    ['request'],
  );
});

test('the rate limit applies to a family call', async () => {
  const telemetry = new FamilyTelemetry('images', {
    rateLimiter: new RateLimiter(),
    rateLimit: { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'global' },
  });

  await telemetry.run({ operation: 'generate' }, async () => 'first');
  await assert.rejects(() => telemetry.run({ operation: 'generate' }, async () => 'second'), NexusRateLimitError);
});

test('a rate-limited family call never reaches the provider', async () => {
  let calls = 0;
  const telemetry = new FamilyTelemetry('images', {
    rateLimiter: new RateLimiter(),
    rateLimit: { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'global' },
  });

  const count = async (): Promise<void> => {
    calls += 1;
  };
  await telemetry.run({ operation: 'generate' }, count);
  await assert.rejects(() => telemetry.run({ operation: 'generate' }, count));
  assert.equal(calls, 1);
});

test('a family honors a distributed rate-limit store', async () => {
  const store = new MemoryRateLimitStore();
  const telemetry = new FamilyTelemetry('voice', {
    rateLimiter: new RateLimiter(),
    rateLimit: { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'global', store },
  });

  await telemetry.run({ operation: 'speak' }, async () => 'ok');
  await assert.rejects(() => telemetry.run({ operation: 'speak' }, async () => 'ok'), NexusRateLimitError);
});

// ── Families report through it ─────────────────────────────────────

test('image generation reports metrics and audit events', async () => {
  const { metrics, counters } = collector();
  const { auditLogger, events } = auditing();
  const manager = new ImageManager(
    { providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' },
    { metrics, auditLogger },
  );

  await manager.generate({ prompt: 'a blue square' });

  assert.ok(counters().some((key) => key.includes('family=images') && key.includes('operation=images.generate')));
  assert.equal(events.length, 2);
});

test('voice transcription and speech report separately', async () => {
  const { metrics, counters } = collector();
  const manager = new VoiceManager(
    { providers: { mock: mockVoiceProvider }, defaultTranscriptionProvider: 'mock', defaultSpeechProvider: 'mock' },
    { metrics },
  );

  await manager.transcribe({ audio: { buffer: new Uint8Array([1]), filename: 'a.mp3' } });
  await manager.speak({ text: 'hello' });

  const keys = counters();
  assert.ok(keys.some((key) => key.includes('operation=transcribe')));
  assert.ok(keys.some((key) => key.includes('operation=speak')));
});

test('telephony call control reports metrics', async () => {
  const { metrics, counters } = collector();
  const manager = new TelephonyManager(
    { providers: { mock: mockTelephonyProvider }, defaultProvider: 'mock' },
    { metrics },
  );

  await manager.createCall({ to: '+15550001111', from: '+15550002222' });
  await manager.endCall({ callId: 'CA1' });

  const keys = counters();
  assert.ok(keys.some((key) => key.includes('operation=createCall')));
  assert.ok(keys.some((key) => key.includes('operation=endCall')));
});

test('a family provider error still surfaces unchanged through telemetry', async () => {
  const failing: VoiceProvider = {
    info: { name: 'broken', supports: { speech: true } },
    async speak(): Promise<SpeechResponse> {
      throw new Error('tts exploded');
    },
  };
  const { metrics, counters } = collector();
  const manager = new VoiceManager({ providers: { broken: failing }, defaultSpeechProvider: 'broken' }, { metrics });

  // VoiceManager wraps a provider failure in VoiceProviderError and keeps the original as its
  // cause. Telemetry must not change that.
  await assert.rejects(
    () => manager.speak({ text: 'hi' }),
    (error: unknown) =>
      error instanceof VoiceProviderError &&
      error.provider === 'broken' &&
      (error.cause as Error | undefined)?.message === 'tts exploded',
  );
  assert.ok(counters().some((key) => key.includes('errors') && key.includes('family=voice')));
});

// ── Shared through NexusAI ─────────────────────────────────────────

test('every family reports into one collector reachable from the runtime', async () => {
  const ai = new NexusAI({
    providers: {},
    metrics: { enabled: true },
    images: { providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' },
    voice: { providers: { mock: mockVoiceProvider }, defaultSpeechProvider: 'mock' },
  });

  await ai.images.generate({ prompt: 'a square' });
  await ai.speak({ text: 'hello' });

  const snapshot = ai.getMetricsSnapshot() as { counters: Record<string, number> };
  const keys = Object.keys(snapshot.counters);
  assert.ok(
    keys.some((key) => key.includes('family=images')),
    `expected image metrics, got ${keys.join(', ')}`,
  );
  assert.ok(
    keys.some((key) => key.includes('family=voice')),
    'expected voice metrics in the same snapshot',
  );
});

test('one rate-limit budget covers completions and media families', async () => {
  const ai = new NexusAI({
    providers: {},
    images: { providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' },
    rateLimit: { enabled: true, maxRequests: 2, windowMs: 60_000, key: 'global' },
  });

  await ai.images.generate({ prompt: 'one' });
  await ai.images.generate({ prompt: 'two' });
  await assert.rejects(() => ai.images.generate({ prompt: 'three' }), NexusRateLimitError);
});

test('a runtime with observability disabled still runs every family', async () => {
  const ai = new NexusAI({
    providers: {},
    images: { providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' },
    voice: { providers: { mock: mockVoiceProvider }, defaultSpeechProvider: 'mock' },
  });

  const image = await ai.images.generate({ prompt: 'a square' });
  const speech = await ai.speak({ text: 'hello' });

  assert.ok(image.assets.length > 0);
  assert.ok(speech.audio.data.length > 0);
});
