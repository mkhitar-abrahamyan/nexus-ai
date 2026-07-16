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
import { VoiceProviderError } from '../errors.js';

export interface OpenAIVoiceProviderConfig {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  transcriptionModel?: string;
  speechModel?: string;
  defaultVoice?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

interface PreparedAudio {
  blob: Blob;
  filename: string;
  mimeType?: string;
}

const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';

export class OpenAIVoiceProvider implements VoiceProvider {
  readonly info: VoiceProviderInfo = {
    name: 'openai',
    isLocal: false,
    supports: {
      transcription: true,
      speech: true,
      realtime: false,
    },
  };

  constructor(private config: OpenAIVoiceProviderConfig) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const model = request.model || this.config.transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL;
    const form = new FormData();
    const audio = await this.prepareAudio(request.audio, request.signal);

    form.append('file', audio.blob, audio.filename);
    form.append('model', model);
    if (request.language) form.append('language', request.language);
    if (request.prompt) form.append('prompt', request.prompt);
    if (request.temperature !== undefined) form.append('temperature', String(request.temperature));
    if (request.responseFormat) form.append('response_format', request.responseFormat);
    for (const granularity of request.timestampGranularities || []) {
      form.append('timestamp_granularities[]', granularity);
    }

    const response = await this.request('/audio/transcriptions', {
      method: 'POST',
      body: form,
      signal: request.signal,
    });

    if (request.responseFormat === 'text' || request.responseFormat === 'srt' || request.responseFormat === 'vtt') {
      const text = await response.text();
      return {
        text,
        providerUsed: 'openai',
        modelUsed: model,
        raw: text,
      };
    }

    const raw = (await response.json()) as Record<string, unknown>;
    return {
      text: typeof raw.text === 'string' ? raw.text : '',
      providerUsed: 'openai',
      modelUsed: model,
      language: typeof raw.language === 'string' ? raw.language : undefined,
      durationSeconds: typeof raw.duration === 'number' ? raw.duration : undefined,
      segments: Array.isArray(raw.segments)
        ? (raw.segments
            .map((segment) => this.normalizeSegment(segment))
            .filter(Boolean) as TranscriptionResponse['segments'])
        : undefined,
      words: Array.isArray(raw.words)
        ? (raw.words.map((word) => this.normalizeWord(word)).filter(Boolean) as TranscriptionResponse['words'])
        : undefined,
      raw,
    };
  }

  async speak(request: SpeechRequest): Promise<SpeechResponse> {
    const model = request.model || this.config.speechModel || DEFAULT_SPEECH_MODEL;
    const format = request.format || 'mp3';
    const voice = request.voice || this.config.defaultVoice || DEFAULT_VOICE;
    const body: Record<string, unknown> = {
      model,
      input: request.text,
      voice,
      response_format: this.openAiFormat(format),
    };

    if (request.speed !== undefined) body.speed = request.speed;
    if (request.instructions) body.instructions = request.instructions;

    const response = await this.request('/audio/speech', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal: request.signal,
    });
    const data = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type') || this.mimeType(format);

    return {
      audio: {
        data,
        format,
        mimeType,
      },
      providerUsed: 'openai',
      modelUsed: model,
      voice,
      format,
      mimeType,
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.config.fetch || fetch;
    const response = await fetchImpl(`${this.baseUrl()}${path}`, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new VoiceProviderError(`OpenAI voice request failed: ${response.status} ${message}`, 'openai');
    }

    return response;
  }

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.organization ? { 'openai-organization': this.config.organization } : {}),
      ...(this.config.headers || {}),
    };
  }

  private baseUrl(): string {
    return (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  private async prepareAudio(input: VoiceAudioInput, signal?: AbortSignal): Promise<PreparedAudio> {
    const mimeType = input.mimeType || 'audio/mpeg';
    const filename = input.filename || this.filename(input);

    if ('url' in input) {
      const response = await (this.config.fetch || fetch)(input.url, { signal });
      if (!response.ok) {
        throw new VoiceProviderError(`Failed to fetch audio URL: ${response.status} ${response.statusText}`, 'openai');
      }
      const blob = await response.blob();
      return {
        blob,
        filename,
        mimeType: blob.type || mimeType,
      };
    }

    if ('path' in input) {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(input.path);
      return {
        blob: new Blob([new Uint8Array(data)], { type: mimeType }),
        filename,
        mimeType,
      };
    }

    if ('buffer' in input) {
      const data = this.toUint8Array(input.buffer);
      return {
        blob: new Blob([data], { type: mimeType }),
        filename,
        mimeType,
      };
    }

    if ('base64' in input) {
      const data = Buffer.from(input.base64, 'base64');
      return {
        blob: new Blob([new Uint8Array(data)], { type: mimeType }),
        filename,
        mimeType,
      };
    }

    const data = await this.streamToBuffer(input.stream);
    return {
      blob: new Blob([data], { type: mimeType }),
      filename,
      mimeType,
    };
  }

  private toUint8Array(data: Buffer | Uint8Array | ArrayBuffer): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
      else chunks.push(this.toUint8Array(chunk as Buffer | Uint8Array | ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }

  private filename(input: VoiceAudioInput): string {
    if ('path' in input) return input.path.split(/[\\/]/).pop() || 'audio.mp3';
    if ('url' in input) {
      try {
        return new URL(input.url).pathname.split('/').pop() || 'audio.mp3';
      } catch {
        return 'audio.mp3';
      }
    }
    return 'audio.mp3';
  }

  private normalizeSegment(segment: unknown): NonNullable<TranscriptionResponse['segments']>[number] | undefined {
    if (!segment || typeof segment !== 'object') return undefined;
    const value = segment as Record<string, unknown>;
    return {
      id: typeof value.id === 'number' ? value.id : undefined,
      text: typeof value.text === 'string' ? value.text : '',
      start: typeof value.start === 'number' ? value.start : undefined,
      end: typeof value.end === 'number' ? value.end : undefined,
    };
  }

  private normalizeWord(word: unknown): NonNullable<TranscriptionResponse['words']>[number] | undefined {
    if (!word || typeof word !== 'object') return undefined;
    const value = word as Record<string, unknown>;
    if (typeof value.word !== 'string') return undefined;
    return {
      word: value.word,
      start: typeof value.start === 'number' ? value.start : undefined,
      end: typeof value.end === 'number' ? value.end : undefined,
    };
  }

  private openAiFormat(format: VoiceAudioFormat): string {
    if (format === 'ogg') return 'opus';
    if (format === 'webm') return 'opus';
    return format;
  }

  private mimeType(format: VoiceAudioFormat): string {
    if (format === 'mp3') return 'audio/mpeg';
    if (format === 'wav') return 'audio/wav';
    if (format === 'opus') return 'audio/opus';
    if (format === 'aac') return 'audio/aac';
    if (format === 'flac') return 'audio/flac';
    if (format === 'pcm') return 'audio/pcm';
    if (format === 'webm') return 'audio/webm';
    return 'audio/ogg';
  }
}
