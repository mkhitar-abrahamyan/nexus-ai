import type { CompletionRequest } from './messages.js';
import type { NexusResponse } from './response.js';

export type VoiceAudioFormat = 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm' | 'webm' | 'ogg';

export type VoiceAudioInput =
  | { path: string; filename?: string; mimeType?: string }
  | { url: string; filename?: string; mimeType?: string }
  | { buffer: Buffer | Uint8Array | ArrayBuffer; filename?: string; mimeType?: string }
  | { base64: string; filename?: string; mimeType?: string }
  | { stream: NodeJS.ReadableStream; filename?: string; mimeType?: string };

export interface VoiceAudioOutput {
  data: Uint8Array;
  format: VoiceAudioFormat;
  mimeType?: string;
}

export interface VoiceProviderInfo {
  name: string;
  isLocal?: boolean;
  supports?: {
    transcription?: boolean;
    speech?: boolean;
    realtime?: boolean;
  };
}

export interface TranscriptionRequest {
  provider?: string;
  model?: string;
  audio: VoiceAudioInput;
  language?: string;
  prompt?: string;
  temperature?: number;
  responseFormat?: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  timestampGranularities?: Array<'word' | 'segment'>;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface TranscriptionSegment {
  id?: number;
  text: string;
  start?: number;
  end?: number;
}

export interface TranscriptionWord {
  word: string;
  start?: number;
  end?: number;
}

export interface TranscriptionResponse {
  text: string;
  providerUsed: string;
  modelUsed?: string;
  language?: string;
  durationSeconds?: number;
  segments?: TranscriptionSegment[];
  words?: TranscriptionWord[];
  raw?: unknown;
}

export interface SpeechRequest {
  provider?: string;
  model?: string;
  text: string;
  voice?: string;
  format?: VoiceAudioFormat;
  speed?: number;
  instructions?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface SpeechResponse {
  audio: VoiceAudioOutput;
  providerUsed: string;
  modelUsed?: string;
  voice?: string;
  format: VoiceAudioFormat;
  mimeType?: string;
  raw?: unknown;
}

export interface VoiceProvider {
  readonly info: VoiceProviderInfo;
  transcribe?(request: TranscriptionRequest): Promise<TranscriptionResponse>;
  speak?(request: SpeechRequest): Promise<SpeechResponse>;
}

export interface VoiceConfig {
  defaultTranscriptionProvider?: string;
  defaultSpeechProvider?: string;
  providers?: Record<string, VoiceProvider>;
}

export interface VoiceTranscriptMessageConfig {
  append?: boolean;
  role?: 'user' | 'system';
  template?: string;
}

export interface VoiceTurnRequest {
  audio?: VoiceAudioInput;
  transcript?: string;
  transcription?: Omit<TranscriptionRequest, 'audio'>;
  completion: CompletionRequest;
  transcriptMessage?: VoiceTranscriptMessageConfig;
  speech?: Omit<SpeechRequest, 'text'> | false;
  metadata?: Record<string, unknown>;
}

export interface VoiceTurnResponse {
  transcript?: TranscriptionResponse;
  transcriptText: string;
  response: NexusResponse;
  speech?: SpeechResponse;
}
