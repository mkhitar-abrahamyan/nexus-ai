import type { BinaryBuffer, CompletionRequest, Message, ToolDefinition } from './messages.js';
import type { NexusResponse } from './response.js';

/** Audio encodings voice providers accept and produce. */
export type VoiceAudioFormat = 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm' | 'webm' | 'ogg';

/**
 * Audio to transcribe: a file path, a URL, bytes, base64 text, or a readable stream. `filename` and
 * `mimeType` help a provider that infers the format from them.
 */
export type VoiceAudioInput =
  | { path: string; filename?: string; mimeType?: string }
  | { url: string; filename?: string; mimeType?: string }
  | { buffer: BinaryBuffer | Uint8Array | ArrayBuffer; filename?: string; mimeType?: string }
  | { base64: string; filename?: string; mimeType?: string }
  | { stream: NodeJS.ReadableStream; filename?: string; mimeType?: string };

/** Synthesized speech. */
export interface VoiceAudioOutput {
  /** The encoded audio. */
  data: Uint8Array;
  /** Its encoding. */
  format: VoiceAudioFormat;
  /** Its MIME type, such as `audio/mpeg`. */
  mimeType?: string;
}

/** Identifies a voice provider and what it supports. */
export interface VoiceProviderInfo {
  /** The provider's registered name. */
  name: string;
  /** True for a provider that runs locally. */
  isLocal?: boolean;
  /** Which voice features it implements. */
  supports?: {
    transcription?: boolean;
    speech?: boolean;
    realtime?: boolean;
  };
}

/** Turns speech into text. */
export interface TranscriptionRequest {
  /** Provider to use. Defaults to the configured transcription provider. */
  provider?: string;
  /** Transcription model. */
  model?: string;
  /** The audio to transcribe. */
  audio: VoiceAudioInput;
  /** Language spoken, as an ISO-639-1 code. Improves accuracy and latency when known. */
  language?: string;
  /** Text that guides transcription: expected names, spelling, or the previous sentence. */
  prompt?: string;
  /** Sampling temperature, for providers that expose it. */
  temperature?: number;
  /**
   * Shape of the provider's response: plain text, JSON, verbose JSON with timings, or subtitles.
   */
  responseFormat?: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  /** Timestamp detail to include, per word or per segment. */
  timestampGranularities?: Array<'word' | 'segment'>;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Application data carried through to records. */
  metadata?: Record<string, unknown>;
}

/** A stretch of transcribed speech with its timing. */
export interface TranscriptionSegment {
  /** The segment's index. */
  id?: number;
  /** What was said. */
  text: string;
  /** Seconds from the start of the audio. */
  start?: number;
  /** Seconds from the start of the audio. */
  end?: number;
}

/** One transcribed word with its timing. */
export interface TranscriptionWord {
  /** The word. */
  word: string;
  /** Seconds from the start of the audio. */
  start?: number;
  /** Seconds from the start of the audio. */
  end?: number;
}

/** A transcription. */
export interface TranscriptionResponse {
  /** The full text. */
  text: string;
  /** Provider that transcribed it. */
  providerUsed: string;
  /** Model that transcribed it. */
  modelUsed?: string;
  /** Language detected or used. */
  language?: string;
  /** Length of the audio in seconds. */
  durationSeconds?: number;
  /** Timed segments, when requested. */
  segments?: TranscriptionSegment[];
  /** Timed words, when requested. */
  words?: TranscriptionWord[];
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/** Turns text into speech. */
export interface SpeechRequest {
  /** Provider to use. Defaults to the configured speech provider. */
  provider?: string;
  /** Speech model. */
  model?: string;
  /** The text to speak. */
  text: string;
  /** Voice to speak in, by the provider's name for it. */
  voice?: string;
  /** Encoding of the result. */
  format?: VoiceAudioFormat;
  /** Speaking rate, where 1 is normal. */
  speed?: number;
  /** How to speak it — tone, pace, emotion — for models that take direction. */
  instructions?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Application data carried through to records. */
  metadata?: Record<string, unknown>;
}

/** Synthesized speech and what produced it. */
export interface SpeechResponse {
  /** The audio. */
  audio: VoiceAudioOutput;
  /** Provider that synthesized it. */
  providerUsed: string;
  /** Model that synthesized it. */
  modelUsed?: string;
  /** Voice it was spoken in. */
  voice?: string;
  /** Its encoding. */
  format: VoiceAudioFormat;
  /** Its MIME type. */
  mimeType?: string;
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/**
 * A batch voice backend: transcription, speech, or both. Each operation is optional;
 * `info.supports` says which exist.
 */
export interface VoiceProvider {
  /** What the provider is and what it supports. */
  readonly info: VoiceProviderInfo;
  /** Turns speech into text. */
  transcribe?(request: TranscriptionRequest): Promise<TranscriptionResponse>;
  /** Turns text into speech. */
  speak?(request: SpeechRequest): Promise<SpeechResponse>;
}

/** Voice providers available to a client. */
export interface VoiceConfig {
  /** Provider used for transcription when a request names none. */
  defaultTranscriptionProvider?: string;
  /** Provider used for speech when a request names none. */
  defaultSpeechProvider?: string;
  /** Providers by name. */
  providers?: Record<string, VoiceProvider>;
}

/** How a transcript becomes a message in the completion that answers it. */
export interface VoiceTranscriptMessageConfig {
  /** `false` leaves the transcript out of the messages, for a prompt that already includes it. */
  append?: boolean;
  /** Role of the message. Defaults to `user`. */
  role?: 'user' | 'system';
  /**
   * Message text with `{{transcript}}` where the transcript goes. Defaults to the transcript alone.
   */
  template?: string;
}

/** One spoken turn: transcribe the audio, answer it, and speak the answer. */
export interface VoiceTurnRequest {
  /** The user's audio. Omit it when `transcript` is already known. */
  audio?: VoiceAudioInput;
  /** The user's words, when they were transcribed elsewhere. */
  transcript?: string;
  /** Transcription settings for `audio`. */
  transcription?: Omit<TranscriptionRequest, 'audio'>;
  /** The completion that answers the turn. The transcript is appended to its messages. */
  completion: CompletionRequest;
  /** How the transcript is added to the completion. */
  transcriptMessage?: VoiceTranscriptMessageConfig;
  /** Speech settings for the answer, or `false` to return text only. */
  speech?: Omit<SpeechRequest, 'text'> | false;
  /** Application data carried through to records. */
  metadata?: Record<string, unknown>;
}

/** The outcome of a voice turn. */
export interface VoiceTurnResponse {
  /** The transcription, when audio was transcribed. */
  transcript?: TranscriptionResponse;
  /** The text the turn answered, transcribed or given. */
  transcriptText: string;
  /** The completion that answered it. */
  response: NexusResponse;
  /** The spoken answer, unless speech was turned off. */
  speech?: SpeechResponse;
}

/** Prompt text: one string, or several joined with blank lines. */
export type VoicePromptText = string | string[];

/** What a task prompt's matcher sees when deciding whether it applies to a turn. */
export interface VoiceTaskPromptMatcherInput {
  /** What the user said this turn. */
  transcriptText: string;
  /** The conversation so far. */
  messages: Message[];
  /** Application data for the turn. */
  metadata?: Record<string, unknown>;
}

/** Decides whether a task prompt applies: a substring, a pattern, any of several, or a function. */
export type VoiceTaskPromptMatcher =
  | string
  | RegExp
  | Array<string | RegExp>
  | ((input: VoiceTaskPromptMatcherInput) => boolean | Promise<boolean>);

/**
 * Instructions that apply only to turns about one task, so a session prompt stays short and each
 * task still gets its detail.
 */
export interface VoiceTaskPrompt {
  /** Names the task in records and in the system message. */
  name: string;
  /** When the task applies. Without it, the task always applies. */
  when?: VoiceTaskPromptMatcher;
  /** Prompt text added to the system message when the task applies. */
  prompt?: VoicePromptText;
  /** Further instructions added when the task applies. */
  instructions?: VoicePromptText;
  /**
   * Tools this task needs. With `toolSelection: 'task'`, only the tools of matching tasks are
   * offered.
   */
  tools?: string[];
  /** Application data about the task. */
  metadata?: Record<string, unknown>;
}

/** One tool call a voice session made while answering a turn. */
export interface VoiceSessionToolStep {
  /** Which round of tool calls it was in, starting at 1. */
  iteration: number;
  /** The provider's id for the call. */
  toolCallId: string;
  /** The tool's name. */
  toolName: string;
  /** Arguments the model supplied. */
  toolArgs: Record<string, unknown>;
  /** True when the tool returned a value rather than failing. */
  ok: boolean;
  /** The value returned to the model. */
  result?: unknown;
  /** Why the tool failed. */
  error?: string;
}

/**
 * A multi-turn voice conversation: prompts, tools, history, and the transcription and speech
 * settings every turn shares.
 */
export interface VoiceSessionConfig {
  /** Session id. Generated when omitted. */
  id?: string;
  /** The model that answers turns. */
  model: string;
  /** Prompt text for the system message. */
  prompt?: VoicePromptText;
  /** System prompt, placed first in the system message. */
  systemPrompt?: VoicePromptText;
  /** Further instructions added to the system message. */
  instructions?: VoicePromptText;
  /** Instructions that apply only to matching turns. */
  taskPrompts?: VoiceTaskPrompt[];
  /** Conversation to start from. */
  messages?: Message[];
  /** Tools the model may call. */
  tools?: ToolDefinition[];
  /**
   * `all` offers every tool; `task` offers only the tools of the task prompts that matched the
   * turn, and every tool when none did.
   */
  toolSelection?: 'all' | 'task';
  /** Rounds of tool calls allowed per turn before answering. Defaults to 4. */
  maxToolIterations?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Output token limit per answer. */
  maxTokens?: number;
  /** Nucleus sampling cutoff. */
  topP?: number;
  /** Structured output format for answers. */
  responseFormat?: CompletionRequest['responseFormat'];
  /** Stop sequences. */
  stop?: CompletionRequest['stop'];
  /** End user the session serves, for rate limits and audit. */
  userId?: string;
  /** Application data carried through every turn. */
  metadata?: Record<string, unknown>;
  /** Transcription settings for every turn. */
  transcription?: Omit<TranscriptionRequest, 'audio'>;
  /** How transcripts are added to the conversation. */
  transcriptMessage?: VoiceTranscriptMessageConfig;
  /** Speech settings for every answer, or `false` to answer in text. */
  speech?: Omit<SpeechRequest, 'text'> | false;
  /**
   * Keeps the conversation between turns. Defaults to true; `false` answers each turn on its own.
   */
  maintainHistory?: boolean;
  /** Called after each tool call, for logging or a live transcript. */
  onToolCall?: (step: VoiceSessionToolStep) => void | Promise<void>;
}

/** What one turn of a voice session receives. Settings here apply to this turn only. */
export interface VoiceSessionTurnInput {
  /** The user's audio. */
  audio?: VoiceAudioInput;
  /** The user's words, when they were transcribed elsewhere. */
  transcript?: string;
  /** Transcription settings for this turn. */
  transcription?: Omit<TranscriptionRequest, 'audio'>;
  /** Speech settings for this turn's answer, or `false` for text only. */
  speech?: Omit<SpeechRequest, 'text'> | false;
  /** Completion fields for this turn, merged over the session's. */
  completion?: Partial<CompletionRequest>;
  /** Extra prompt text for this turn. */
  prompt?: VoicePromptText;
  /** Extra instructions for this turn. */
  instructions?: VoicePromptText;
  /** Extra task prompts for this turn. */
  taskPrompts?: VoiceTaskPrompt[];
  /** Extra tools for this turn. */
  tools?: ToolDefinition[];
  /** Application data for this turn. */
  metadata?: Record<string, unknown>;
}

/** The outcome of one voice session turn. */
export interface VoiceSessionTurnResponse {
  /** The session's id. */
  sessionId: string;
  /** The transcription, when audio was transcribed. */
  transcript?: TranscriptionResponse;
  /** The text the turn answered. */
  transcriptText: string;
  /** The completion that answered it. */
  response: NexusResponse;
  /** The spoken answer, unless speech was turned off. */
  speech?: SpeechResponse;
  /** Tool calls made while answering, in order. */
  toolSteps: VoiceSessionToolStep[];
  /** Names of the task prompts that matched the turn. */
  selectedTaskPrompts: string[];
  /** The conversation after the turn. */
  messages: Message[];
}
