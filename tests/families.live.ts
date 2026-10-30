/**
 * The experimental families against the live services, each where its secret is set: media
 * understanding through a vision model and through Mistral's OCR, the Gemini embedding batch tier,
 * video generation on Veo and on Runway, which costs a few seconds of video and so runs only when
 * `NEXUS_LIVE_VIDEO` is set too, a Gemini Live session that calls a tool, Gemini's voice speaking a
 * sentence and hearing it back, OpenAI's SIP call control,
 * the phone numbers of Twilio and Telnyx, read only, and typed decisions on TypeSafe AI's Jev and from
 * OpenAI's and Gemini's log probabilities. Each check is what graduation asks for: the family's conformance
 * suite, passed against the real service. Writes what it measured to `NEXUS_LIVE_REPORT` when set.
 *
 *   node --import tsx tests/families.live.ts
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { completionDecisions, type DecisionConformanceCase, runDecisionConformance } from '../src/decisions/index.js';
import { TypeSafeDecisionProvider } from '../src/decisions/typesafe.js';
import { EmbeddingBatchManager } from '../src/embeddings/batch.js';
import { GoogleEmbeddingBatchProvider } from '../src/embeddings/batch-google.js';
import { type MediaInput, modelMediaProvider, runMediaConformance } from '../src/media/index.js';
import { MistralOcrProvider } from '../src/media/mistral.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { runVideoConformance, type VideoProvider } from '../src/video/index.js';
import { rejectOpenAIRealtimeCall } from '../src/realtime/openai-server.js';
import { GeminiLiveProvider } from '../src/realtime/provider.js';
import { defineTool } from '../src/realtime/tools.js';
import { TelnyxTelephonyProvider } from '../src/telephony/providers/telnyx.js';
import { TwilioTelephonyProvider } from '../src/telephony/providers/twilio.js';
import { GoogleVideoProvider } from '../src/video/google.js';
import { GoogleVoiceProvider } from '../src/voice/providers/google.js';
import { RunwayVideoProvider } from '../src/video/runway.js';

interface Outcome {
  check: string;
  status: 'ok' | 'not ok' | 'skip';
  detail?: string;
  ms?: number;
}

const outcomes: Outcome[] = [];
const env = process.env;

async function check(name: string, body: () => Promise<string | undefined>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await body();
    outcomes.push({ check: name, status: 'ok', ms: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`ok - ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcomes.push({ check: name, status: 'not ok', detail, ms: Date.now() - started });
    console.log(`not ok - ${name}: ${detail}`);
  }
}

function skip(name: string, why: string): void {
  outcomes.push({ check: name, status: 'skip', detail: why });
  console.log(`skip - ${name} (${why})`);
}

// ── Fixtures ─────────────────────────────────────────────────────────

/** A one-page PDF that prints an invoice line in Helvetica, built by hand so no fixture is needed. */
function invoicePdf(): MediaInput {
  const text = 'Invoice 17. Total due: 42 EUR.';
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return {
    type: 'document',
    source: { base64: Buffer.from(pdf, 'latin1').toString('base64'), mimeType: 'application/pdf' },
    filename: 'invoice.pdf',
  };
}

/** A 64-pixel PNG of a red square on white, encoded by hand. */
function redSquarePng(): MediaInput {
  const size = 64;
  const rows: number[] = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(0);
    for (let x = 0; x < size; x += 1) {
      const inside = x >= 16 && x < 48 && y >= 16 && y < 48;
      rows.push(255, inside ? 0 : 255, inside ? 0 : 255);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { type: 'image', source: { base64: png.toString('base64'), mimeType: 'image/png' } };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Media understanding ──────────────────────────────────────────────

const document = invoicePdf();
const image = redSquarePng();
const vision: Array<{ name: string; provider: ReturnType<typeof modelMediaProvider> }> = [];
if (env.OPENAI_API_KEY) {
  vision.push({
    name: 'openai',
    provider: modelMediaProvider(new OpenAIProvider({ apiKey: env.OPENAI_API_KEY }), {
      model: env.OPENAI_MEDIA_MODEL || 'gpt-6-luna',
    }),
  });
}
if (env.GOOGLE_API_KEY) {
  vision.push({
    name: 'google',
    provider: modelMediaProvider(new GoogleProvider({ apiKey: env.GOOGLE_API_KEY }), {
      model: env.GOOGLE_MEDIA_MODEL || 'gemini-3.5-flash-lite',
    }),
  });
}
if (vision.length === 0) skip('media: a vision model', 'no OPENAI_API_KEY or GOOGLE_API_KEY');
for (const { name, provider } of vision) {
  await check(`media: ${name} vision model reads a document`, async () => {
    const report = await runMediaConformance(provider, { document, expectText: /42/ });
    if (report.failures.length) throw new Error(report.failures.join('; '));
    return report.passed.join(', ');
  });
  await check(`media: ${name} vision model describes and answers about an image`, async () => {
    const report = await runMediaConformance(provider, {
      image,
      question: { ask: 'What color is the square?', expect: /red/i },
    });
    if (report.failures.length) throw new Error(report.failures.join('; '));
    return report.passed.join(', ');
  });
}
if (env.MISTRAL_API_KEY) {
  await check('media: Mistral OCR reads a document and an image', async () => {
    const report = await runMediaConformance(new MistralOcrProvider({ apiKey: env.MISTRAL_API_KEY as string }), {
      document,
      expectText: /42/,
    });
    if (report.failures.length) throw new Error(report.failures.join('; '));
    return report.passed.join(', ');
  });
} else skip('media: Mistral OCR', 'no MISTRAL_API_KEY');

// ── The Gemini embedding batch tier ──────────────────────────────────

if (env.GOOGLE_API_KEY) {
  await check('embeddings: Gemini batch tier submits, completes, and prices a batch', async () => {
    const manager = new EmbeddingBatchManager({
      providers: { gemini: new GoogleEmbeddingBatchProvider({ apiKey: env.GOOGLE_API_KEY as string }) },
      pollIntervalMs: 15_000,
      maxPollIntervalMs: 60_000,
    });
    const wait = Number(env.NEXUS_LIVE_BATCH_WAIT_MS || 20 * 60_000);
    const ref = await manager.start({
      model: env.GOOGLE_EMBEDDING_BATCH_MODEL || 'gemini-embedding-001',
      items: [
        { customId: 'refund', input: 'How do I get a refund?' },
        { customId: 'shipping', input: 'When will my order ship?' },
      ],
    });
    const result = await manager
      .resume(JSON.parse(JSON.stringify(ref)), { signal: AbortSignal.timeout(wait) })
      .catch(async (error: unknown) => {
        // A batch tier promises a day, not minutes: one still running is cancelled, and says so.
        await manager.cancel(ref).catch(() => undefined);
        throw new Error(`the batch did not finish within ${Math.round(wait / 60_000)} minutes: ${String(error)}`);
      });
    if (result.status !== 'completed') throw new Error(`the batch ended ${result.status}`);
    const vectors = result.items.filter((item) => item.vector?.length);
    if (vectors.length !== 2) throw new Error(`${vectors.length} of 2 vectors came back`);
    if (!(result.cost.amount > 0)) throw new Error('the batch was not priced');
    return `${vectors[0]?.vector?.length} dimensions, $${result.cost.amount.toFixed(8)}`;
  });
} else skip('embeddings: Gemini batch tier', 'no GOOGLE_API_KEY');

// ── Video generation ─────────────────────────────────────────────────

const video: Array<{ name: string; provider: VideoProvider; model: string }> = [];
if (env.NEXUS_LIVE_VIDEO) {
  if (env.GOOGLE_API_KEY) {
    video.push({
      name: 'Veo',
      provider: new GoogleVideoProvider({ apiKey: env.GOOGLE_API_KEY }),
      model: env.GOOGLE_VIDEO_MODEL || 'gemini-omni-1.1-flash',
    });
  }
  if (env.RUNWAYML_API_SECRET) {
    video.push({
      name: 'Runway',
      provider: new RunwayVideoProvider({ apiKey: env.RUNWAYML_API_SECRET }),
      model: env.RUNWAY_VIDEO_MODEL || 'gen4.5',
    });
  }
  if (video.length === 0) skip('video', 'no GOOGLE_API_KEY or RUNWAYML_API_SECRET');
} else skip('video', 'NEXUS_LIVE_VIDEO is not set: each run costs a few seconds of video');
for (const { name, provider, model } of video) {
  await check(`video: ${name} passes the conformance suite`, async () => {
    const report = await runVideoConformance(provider, {
      request: { model },
      pollIntervalMs: 10_000,
      timeoutMs: 15 * 60_000,
    });
    if (report.failures.length) throw new Error(report.failures.join('; '));
    return `${model}: ${report.passed.join(', ')}`;
  });
}

// ── Realtime ─────────────────────────────────────────────────────────

const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms)),
  ]);

if (env.GOOGLE_API_KEY) {
  await check('realtime: a Gemini Live session calls a tool and answers with it', async () => {
    const called: string[] = [];
    const time = defineTool({
      name: 'current_time',
      description: 'The current time, in UTC',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        called.push('current_time');
        return { utc: '12:34' };
      },
    });
    const model = env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-preview';
    const session = new GeminiLiveProvider({ apiKey: env.GOOGLE_API_KEY }).createSession({
      model,
      modalities: ['text'],
      instructions: 'When asked the time, call current_time, then say the time it returns.',
      tools: [time],
    });
    const answered = new Promise<string>((resolve) => {
      session.on('message.text.completed', (event) => {
        if (event.role === 'assistant' && called.length > 0) resolve(event.text);
      });
    });
    await within(session.connect(), 30_000, 'connecting');
    try {
      session.sendText('What time is it?');
      const text = await within(answered, 90_000, 'the answer');
      if (!called.length) throw new Error('the model never called the tool');
      if (!text.includes('12:34') && !text.includes('12.34'))
        throw new Error(`the answer did not use the tool: ${text}`);
      const metrics = session.getMetrics();
      return `${model}: ${metrics.inputTokens ?? 0} tokens in, ${metrics.outputTokens ?? 0} out`;
    } finally {
      await session.disconnect();
    }
  });
} else skip('realtime: Gemini Live', 'no GOOGLE_API_KEY');

// ── Voice ────────────────────────────────────────────────────────────

if (env.GOOGLE_API_KEY) {
  await check('voice: Gemini speaks a sentence in one of its voices, and hears it back', async () => {
    const voice = new GoogleVoiceProvider({ apiKey: env.GOOGLE_API_KEY as string });
    const sentence = 'The invoice for forty two euros was paid on Tuesday.';
    const spoken = await within(voice.speak({ text: sentence, voice: 'Puck' }), 60_000, 'speaking');
    const audio = spoken.audio.data;
    // A WAV file: its RIFF header, then at least half a second of 24 kHz, 16-bit, mono speech.
    if (new TextDecoder().decode(audio.subarray(0, 4)) !== 'RIFF') throw new Error('the speech is not a WAV file');
    if (audio.byteLength < 24_000) throw new Error(`only ${audio.byteLength} bytes of speech`);
    const heard = await within(
      voice.transcribe({ audio: { buffer: audio, filename: 'speech.wav', mimeType: 'audio/wav' }, language: 'en' }),
      60_000,
      'transcribing',
    );
    const words = heard.text.toLowerCase();
    const missing = ['invoice', 'paid', 'tuesday'].filter((word) => !words.includes(word));
    if (missing.length) throw new Error(`the transcript lost ${missing.join(', ')}: ${heard.text}`);
    return `${spoken.modelUsed ?? 'speech'} spoke ${audio.byteLength} bytes; ${heard.modelUsed ?? 'transcription'} heard "${heard.text}"`;
  });
} else skip('voice: Gemini', 'no GOOGLE_API_KEY');

if (env.OPENAI_API_KEY) {
  await check("realtime: OpenAI's SIP call control answers for a call it does not know", async () => {
    // A call id no trunk ever sent: the route and the key are right when OpenAI says it is not found.
    const refused = await rejectOpenAIRealtimeCall('rtc_nexus_live_probe_0', {
      apiKey: env.OPENAI_API_KEY as string,
    }).then(
      () => undefined,
      (error: { status?: number; message?: string }) => error,
    );
    if (!refused) throw new Error('OpenAI accepted a decline for a call that does not exist');
    if (refused.status === 401 || refused.status === 403) throw new Error(`the key was refused: ${refused.message}`);
    if (refused.status !== 404 && refused.status !== 400)
      throw new Error(`unexpected answer: ${refused.status} ${refused.message}`);
    return `HTTP ${refused.status} for an unknown call`;
  });
} else skip('realtime: OpenAI SIP call control', 'no OPENAI_API_KEY');

// ── Telephony ────────────────────────────────────────────────────────

if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
  await check('telephony: Twilio lists its phone numbers', async () => {
    const numbers = await new TwilioTelephonyProvider({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
    }).listPhoneNumbers({ pageSize: 5 });
    return `${numbers.length} numbers`;
  });
} else skip('telephony: Twilio', 'no TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');

if (env.TELNYX_API_KEY) {
  await check('telephony: Telnyx lists its phone numbers', async () => {
    const numbers = await new TelnyxTelephonyProvider({ apiKey: env.TELNYX_API_KEY }).listPhoneNumbers({ pageSize: 5 });
    return `${numbers.length} numbers`;
  });
} else skip('telephony: Telnyx', 'no TELNYX_API_KEY');

// ── Typed decisions ──────────────────────────────────────────────────

/** Questions whose answers any reader of the state agrees on. */
const decisionCases: DecisionConformanceCase[] = [
  {
    state: 'Invoice 17 for 42 EUR was paid in full on 2026-10-01.',
    question: { type: 'yes-no', question: 'Was the invoice paid?' },
    expected: true,
  },
  {
    state: 'The app crashes every time I open the settings page.',
    question: {
      type: 'choice',
      question: 'Which team should handle this?',
      options: { billing: 'Charges and invoices', technical: 'Errors and crashes' },
    },
    expected: 'technical',
  },
  {
    state: 'Nothing works at all, and there is no way around it.',
    question: { type: 'score', question: 'How severe is it?', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
    expected: 2,
  },
];
if (env.TYPESAFE_API_KEY) {
  await check("decisions: TypeSafe AI's Jev passes the conformance suite", async () => {
    const report = await runDecisionConformance(
      new TypeSafeDecisionProvider({ apiKey: env.TYPESAFE_API_KEY as string }),
      {
        cases: decisionCases,
      },
    );
    if (report.failures.length) throw new Error(report.failures.join('; '));
    return report.passed.join(', ');
  });
} else skip("decisions: TypeSafe AI's Jev", 'no TYPESAFE_API_KEY');
const deciders: Array<{ name: string; client: OpenAIProvider | GoogleProvider; model: string }> = [];
if (env.OPENAI_API_KEY) {
  deciders.push({
    name: 'openai',
    client: new OpenAIProvider({ apiKey: env.OPENAI_API_KEY }),
    model: env.OPENAI_DECISION_MODEL || 'gpt-4.1-mini',
  });
}
if (env.GOOGLE_API_KEY) {
  deciders.push({
    name: 'google',
    client: new GoogleProvider({ apiKey: env.GOOGLE_API_KEY }),
    model: env.GOOGLE_DECISION_MODEL || 'gemini-2.5-flash',
  });
}
for (const { name, client, model } of deciders) {
  await check(
    `decisions: ${name} passes the conformance suite, from its log probabilities where it reports them`,
    async () => {
      const provider = completionDecisions(client, { model });
      const report = await runDecisionConformance(provider, { cases: decisionCases });
      if (report.failures.length) throw new Error(report.failures.join('; '));
      return provider.sampledModels.has(model)
        ? `${model}: sampled, as it reported no log probabilities`
        : `${model}: log probabilities`;
    },
  );
}

// ── Report ───────────────────────────────────────────────────────────

const failed = outcomes.filter((outcome) => outcome.status === 'not ok');
const ran = outcomes.filter((outcome) => outcome.status !== 'skip');
console.log(
  `${ran.length - failed.length} of ${ran.length} live checks passed; ${outcomes.length - ran.length} skipped.`,
);
if (env.NEXUS_LIVE_REPORT) {
  writeFileSync(env.NEXUS_LIVE_REPORT, `${JSON.stringify({ at: new Date().toISOString(), outcomes }, null, 2)}\n`);
}
process.exitCode = failed.length ? 1 : 0;
