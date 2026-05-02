import type { CompletionRequest } from '../types/messages.js';
import type { NexusAIConfig } from '../types/config.js';
import type { BaseProvider } from '../providers/base.js';
import type { ProviderHealthSnapshot } from '../ops/health.js';

export interface RouteDecision {
  providerName: string;
  model: string;
  reason: string;
  fallbacks: Array<{ providerName: string; model: string }>;
}

export interface RouterContext {
  request: CompletionRequest;
  config: NexusAIConfig;
  providers: Map<string, BaseProvider>;
  health?: ProviderHealthSnapshot[];
}
