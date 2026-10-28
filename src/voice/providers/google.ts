import type { ProviderCallContext } from '../../types/lifecycle.js';
import type {
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceProvider,
  VoiceProviderInfo,
} from '../../types/voice.js';
import { decodeBase64, encodeBase64 } from '../../utils/base64.js';
import { readMediaDuration } from '../../utils/media-duration.js';
import { VoiceProviderError } from '../errors.js';

/** Options for the Gemini voice provider. */
export interface GoogleVoiceProviderConfig {
  /** Gemini API key, sent as `x-goog-api-key`. */
  apiKey: string;
  /** API base URL. Defaults to `https://generativelanguage.googleapis.com/v1beta`. */
  baseUrl?: string;
  /** The model that transcribes. Defaults to `gemini-3.8-flash`. */
  transcriptionModel?: string;
  /** The model that speaks. Defaults to `gemini-3.8-flash-tts`. */
  speechModel?: string;
  /** Voice used when a request names none, one of Gemini's prebuilt voices. Defaults to `Kore`. */
  defaultVoice?: string;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_TRANSCRIPTION_MODEL = 'gemini-3.8-flash';
const DEFAULT_SPEECH_MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE = 'Kore';
/** Gemini's speech: 24 kHz, one channel, 16-bit samples, unless the answer names another rate. */
const SPEECH_RATE = 24_000;
/** A request with audio inline holds at most 20 MB; base64 makes the audio a third larger. */
const INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

/** Audio a request carries: inline, or by the Files API URI it was uploaded to. */
type AudioPart =
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

interface GeminiAnswer {
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
  }>;
}

/**
 * Gemini speech-to-text and text-to-speech, through `generateContent`: a text model transcribes audio
 * it hears, and a speech model speaks text in one of Gemini's voices, as WAV or raw PCM. Experimental
 * until a live run is recorded.
 */
export class GoogleVoiceProvider implements VoiceProvider {
  /** Always `google`, with transcription and speech. */
  readonly info: VoiceProviderInfo = {
    name: 'google',
    isLocal: false,
    supports: { transcription: true, speech: true, realtime: false },
  };

  constructor(private readonly config: GoogleVoiceProviderConfig) {}

  /**
   * Transcribes audio: its words, in the language spoken, and nothing else. `language` and `prompt`
   * guide the model; a request for timings is refused, since Gemini's transcript has none.
   */
  async transcribe(request: TranscriptionRequest, context?: ProviderCallContext): Promise<TranscriptionResponse> {
    if (
      request.timestampGranularities?.length ||
      (request.responseFormat !== undefined && request.responseFormat !== 'json' && request.responseFormat !== 'text')
    ) {
      throw new VoiceProviderError(
        'Gemini transcribes to text alone, without timings or subtitles; ask for json or text',
        'google',
      );
    }
    const model = request.model || this.config.transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL;
    const signal = context?.signal ?? request.signal;
    const { part, bytes } = await this.audioPart(request.audio, signal);
    const instruction = [
      'Transcribe the speech in this audio word for word, in the language it is spoken in.',
      request.language ? `It is in ${request.language}.` : '',
      request.prompt ? `Names and spellings it may hold: ${request.prompt}` : '',
      'Answer with the transcript alone.',
    ]
      .filter(Boolean)
      .join(' ');
    const answer = await this.generate(
      model,
      {
        contents: [{ role: 'user', parts: [{ text: instruction }, part] }],
        generationConfig: { temperature: request.temperature ?? 0 },
      },
      signal,
      context,
    );
    const text = (answer.candidates?.[0]?.content?.parts ?? [])
      .map((item) => item.text ?? '')
      .join('')
      .trim();
    const duration = bytes ? readMediaDuration(bytes) : undefined;
    return {
      text,
      providerUsed: 'google',
      modelUsed: answer.modelVersion ?? model,
      ...(request.language ? { language: request.language } : {}),
      ...(duration ? { durationSeconds: duration.durationMs / 1000 } : {}),
      raw: answer,
    };
  }

  /**
   * Speaks text in one of Gemini's voices, as WAV, the default, or raw 16-bit PCM. `instructions`, and a
   * `speed` other than 1, direct the delivery as a system instruction, never spoken.
   */
  async speak(request: SpeechRequest, context?: ProviderCallContext): Promise<SpeechResponse> {
    const format: VoiceAudioFormat = request.format ?? 'wav';
    if (format !== 'wav' && format !== 'pcm') {
      throw new VoiceProviderError(`Gemini speaks WAV or raw PCM, not ${format}`, 'google');
    }
    const model = request.model || this.config.speechModel || DEFAULT_SPEECH_MODEL;
    const voice = request.voice || this.config.defaultVoice || DEFAULT_VOICE;
    const direction = [
      request.instructions,
      request.speed !== undefined && request.speed !== 1 ? `Speak at ${request.speed} times the usual pace.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const answer = await this.generate(
      model,
      {
        contents: [{ role: 'user', parts: [{ text: request.text }] }],
        ...(direction ? { systemInstruction: { parts: [{ text: direction }] } } : {}),
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      },
      context?.signal ?? request.signal,
      context,
    );
    const inline = (answer.candidates?.[0]?.content?.parts ?? []).find((item) => item.inlineData?.data)?.inlineData;
    if (!inline?.data) throw new VoiceProviderError('Gemini answered with no audio', 'google');
    const received = decodeBase64(inline.data);
    // Older models answer raw PCM, named with its rate; newer ones a WAV file.
    const wav = isWav(received);
    const rate = Number(/rate=(\d+)/i.exec(inline.mimeType ?? '')?.[1] ?? SPEECH_RATE);
    const data = format === 'wav' ? (wav ? received : wavOf(received, rate)) : wav ? samplesOf(received) : received;
    const mimeType = format === 'wav' ? 'audio/wav' : `audio/L16;rate=${wav ? rateOf(received) : rate}`;
    return {
      audio: { data, format, mimeType },
      providerUsed: 'google',
      modelUsed: answer.modelVersion ?? model,
      voice,
      format,
      mimeType,
      raw: answer,
    };
  }

  /** The audio as a part of the request: a Files API URI by reference, anything else read and sent inline. */
  private async audioPart(
    input: VoiceAudioInput,
    signal?: AbortSignal,
  ): Promise<{ part: AudioPart; bytes?: Uint8Array }> {
    if ('url' in input && input.url.startsWith('https://generativelanguage.googleapis.com/')) {
      return {
        part: { fileData: { mimeType: input.mimeType ?? mimeTypeOf(input.url) ?? 'audio/wav', fileUri: input.url } },
      };
    }
    const bytes = await this.read(input, signal);
    if (bytes.byteLength > INLINE_AUDIO_BYTES) {
      throw new VoiceProviderError(
        `The audio is ${Math.ceil(bytes.byteLength / 1024 / 1024)} MB; Gemini takes at most 14 MB inline, so upload it to the Files API and pass its URI as the url`,
        'google',
      );
    }
    const mimeType =
      input.mimeType ??
      ('filename' in input && input.filename ? mimeTypeOf(input.filename) : undefined) ??
      ('path' in input ? mimeTypeOf(input.path) : undefined) ??
      readMediaDuration(bytes)?.mimeType ??
      'audio/wav';
    return { part: { inlineData: { mimeType, data: encodeBase64(bytes) } }, bytes };
  }

  private async read(input: VoiceAudioInput, signal?: AbortSignal): Promise<Uint8Array> {
    if ('url' in input) {
      const response = await (this.config.fetch ?? fetch)(input.url, signal ? { signal } : {});
      if (!response.ok) throw new VoiceProviderError(`The audio at ${input.url} answered ${response.status}`, 'google');
      return new Uint8Array(await response.arrayBuffer());
    }
    if ('path' in input) {
      const { readFile } = await import('node:fs/promises');
      return new Uint8Array(await readFile(input.path));
    }
    if ('base64' in input) return decodeBase64(input.base64);
    if ('buffer' in input) {
      return input.buffer instanceof ArrayBuffer ? new Uint8Array(input.buffer) : new Uint8Array(input.buffer);
    }
    const pieces: Uint8Array[] = [];
    for await (const piece of input.stream) {
      pieces.push(typeof piece === 'string' ? new TextEncoder().encode(piece) : new Uint8Array(piece as Uint8Array));
    }
    const bytes = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.byteLength;
    }
    return bytes;
  }

  private async generate(
    model: string,
    body: unknown,
    signal: AbortSignal | undefined,
    context?: ProviderCallContext,
  ): Promise<GeminiAnswer> {
    const base = (this.config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const qualified = model.startsWith('models/') ? model : `models/${model}`;
    // A credential resolved for the call's tenant replaces the configured key.
    const credential = await context?.credential?.(this.info.name);
    const response = await (this.config.fetch ?? fetch)(`${base}/${qualified}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': credential?.apiKey ?? this.config.apiKey,
        ...this.config.headers,
        ...credential?.headers,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new VoiceProviderError(
        `Gemini voice request failed: ${response.status} ${message.slice(0, 500)}`,
        'google',
      );
    }
    return (await response.json()) as GeminiAnswer;
  }
}

const AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  aiff: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

function mimeTypeOf(name: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(name)?.[1]?.toLowerCase();
  return extension ? AUDIO_TYPES[extension] : undefined;
}

function isWav(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** A WAV file's sample rate, from its format chunk. */
function rateOf(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let at = 12; at + 8 <= wav.length; at += 8 + view.getUint32(at + 4, true)) {
    if (ascii(wav, at, 4) === 'fmt ') return view.getUint32(at + 12, true);
  }
  return SPEECH_RATE;
}

/** A WAV file's samples, its headers removed. */
function samplesOf(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let at = 12; at + 8 <= wav.length; at += 8 + view.getUint32(at + 4, true)) {
    if (ascii(wav, at, 4) === 'data') return wav.subarray(at + 8, at + 8 + view.getUint32(at + 4, true));
  }
  return wav;
}

/** Raw 16-bit mono PCM at a rate, as a WAV file. */
function wavOf(samples: Uint8Array, rate: number): Uint8Array {
  const wav = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(wav.buffer);
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index++) wav[at + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.byteLength, true);
  wav.set(samples, 44);
  return wav;
}
