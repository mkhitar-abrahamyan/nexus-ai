import { MockRealtimeTransport } from 'nexus-ai-pro/realtime/mock';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';
import { defineTool } from 'nexus-ai-pro/realtime/tools';

type BookingInput = {
  startTime: string;
  endTime: string;
  timezone: string;
};

const bookings: Array<BookingInput & { id: string }> = [];

const bookingSchema = {
  safeParse(input: unknown): { success: true; data: BookingInput } | { success: false; error: Error } {
    if (!isRecord(input)) return { success: false, error: new Error('Expected an object') };
    const { startTime, endTime, timezone } = input;
    if (typeof startTime !== 'string' || typeof endTime !== 'string' || typeof timezone !== 'string') {
      return { success: false, error: new Error('startTime, endTime, and timezone must be strings') };
    }
    return { success: true, data: { startTime, endTime, timezone } };
  },
};

const createBooking = defineTool({
  name: 'create_calendar_booking',
  description: 'Create a calendar booking after explicit user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      startTime: { type: 'string', format: 'date-time' },
      endTime: { type: 'string', format: 'date-time' },
      timezone: { type: 'string' },
    },
    required: ['startTime', 'endTime', 'timezone'],
    additionalProperties: false,
  },
  schema: bookingSchema,
  requiresConfirmation: true,
  execute: async (input: BookingInput, context) => {
    const booking = { id: context.idempotencyKey, ...input };
    bookings.push(booking);
    return booking;
  },
});

const mock = new MockRealtimeTransport({
  autoPlay: false,
  sessionId: 'session_demo',
  script: [
    { type: 'input_audio_buffer.speech_started', item_id: 'user_1' },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_1',
      transcript: 'Book tomorrow from three to three thirty in Yerevan.',
    },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'user_1', audio_end_ms: 2_100 },
    { type: 'response.created', response: { id: 'response_1' } },
    {
      type: 'response.function_call_arguments.done',
      response_id: 'response_1',
      item_id: 'tool_1',
      call_id: 'call_1',
      name: 'create_calendar_booking',
      arguments: JSON.stringify({
        startTime: '2026-07-17T15:00:00+04:00',
        endTime: '2026-07-17T15:30:00+04:00',
        timezone: 'Asia/Yerevan',
      }),
    },
    {
      type: 'response.output_audio_transcript.done',
      response_id: 'response_1',
      item_id: 'assistant_1',
      transcript: 'Your booking is confirmed for three tomorrow.',
    },
    { type: 'response.done', response: { id: 'response_1', status: 'completed' } },
  ],
});

let remoteAudioBytes = 0;

const session = createRealtimeSession({
  provider: 'openai',
  model: 'gpt-realtime',
  transport: mock,
  modalities: ['audio', 'text'],
  instructions: 'Confirm calendar writes and keep spoken answers concise.',
  tools: [createBooking],
  toolExecution: { mode: 'automatic', timeoutMs: 2_000, maxParallelCalls: 2 },
  interruption: { enabled: true, cancelResponse: true, truncateUnheardAudio: true },
  reconnect: { enabled: true, maxAttempts: 2, initialDelayMs: 10 },
  conversation: { captureTranscripts: true, captureToolCalls: true, maxRawEvents: 100 },
  security: {
    toolAllowlist: ['create_calendar_booking'],
    maxSessionDurationMs: 60_000,
    maxAudioDurationMs: 30_000,
  },
  connection: {
    remoteAudioSink(audio) {
      remoteAudioBytes += audio.data?.byteLength || 0;
      session.markAudioPlayed();
    },
  },
});

session.on('tool.confirmation.required', ({ call }) => {
  console.log(`confirmation requested for ${call.name}`);
  // A real UI must ask the authenticated user. This deterministic demo approves the scripted call.
  session.confirmTool(call.callId, true);
});

const completedTools = new Promise<void>((resolve) => {
  session.on('tool.call.completed', () => resolve());
});

await session.connect();

// Advance through speech end and response creation before simulating the first remote audio bytes.
for (let index = 0; index < 4; index += 1) mock.advance();
await session.whenIdle();
mock.emitAudio({ data: new Uint8Array([1, 2, 3, 4]).buffer, mimeType: 'audio/pcm' });
mock.flush();

await completedTools;
await session.whenIdle();
await session.disconnect();

console.log({
  bookings,
  remoteAudioBytes,
  metrics: session.getMetrics(),
  json: session.export('json'),
  text: session.export('text'),
  analytics: session.export('analytics'),
  retainedProviderEvents: session.export('openai-events').length,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
