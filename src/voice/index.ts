export { VoiceManager, type VoiceCompletionClient } from './manager.js';
export { VoiceSession, type VoiceSessionCompletionClient, type VoiceSessionRuntime } from './session.js';
export { VoiceProviderError, VoiceCapabilityError } from './errors.js';
export type {
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  TranscriptionSegment,
  TranscriptionWord,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceAudioOutput,
  VoiceConfig,
  VoicePromptText,
  VoiceProvider,
  VoiceProviderInfo,
  VoiceSessionConfig,
  VoiceSessionToolStep,
  VoiceSessionTurnInput,
  VoiceSessionTurnResponse,
  VoiceTaskPrompt,
  VoiceTaskPromptMatcher,
  VoiceTaskPromptMatcherInput,
  VoiceTranscriptMessageConfig,
  VoiceTurnRequest,
  VoiceTurnResponse,
} from '../types/voice.js';
