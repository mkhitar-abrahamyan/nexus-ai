import type {
  CreateCallRequest,
  CreateCallResponse,
  EndCallRequest,
  GetCallRequest,
  ListPhoneNumbersRequest,
  TelephonyCallDetails,
  TelephonyConfig,
  TelephonyMediaStreamEvent,
  TelephonyOutboundAudioMessage,
  TelephonyPhoneNumber,
  TelephonyProvider,
  TelephonyResponseRequest,
  TelephonyStatusCallback,
  TelephonyWebhookResponse,
  TelephonyWebhookValidationRequest,
  UpdatePhoneNumberRequest,
} from '../types/telephony.js';
import { TelephonyCapabilityError, TelephonyProviderError } from './errors.js';

type TelephonyCapability =
  | 'createCall'
  | 'createWebhookResponse'
  | 'validateWebhook'
  | 'parseMediaStreamEvent'
  | 'formatAudioMessage'
  | 'getCall'
  | 'endCall'
  | 'parseStatusCallback'
  | 'listPhoneNumbers'
  | 'updatePhoneNumber';

export class TelephonyManager {
  private providers = new Map<string, TelephonyProvider>();

  constructor(private config: TelephonyConfig = {}) {
    for (const [name, provider] of Object.entries(config.providers || {})) {
      this.registerProvider(name, provider);
    }
  }

  registerProvider(name: string, provider: TelephonyProvider): this {
    this.providers.set(name, provider);
    return this;
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  async createCall(request: CreateCallRequest): Promise<CreateCallResponse> {
    const provider = this.resolveProvider('createCall', request.provider || this.config.defaultProvider);
    if (!provider.createCall) throw new TelephonyCapabilityError(provider.info.name, 'outbound calls');

    try {
      return await provider.createCall(request);
    } catch (error) {
      if (error instanceof TelephonyProviderError) throw error;
      throw new TelephonyProviderError(
        `Telephony call creation failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  async createWebhookResponse(request: TelephonyResponseRequest): Promise<TelephonyWebhookResponse> {
    const provider = this.resolveProvider('createWebhookResponse', request.provider || this.config.defaultProvider);
    if (!provider.createWebhookResponse) throw new TelephonyCapabilityError(provider.info.name, 'webhook responses');

    try {
      return await provider.createWebhookResponse(request);
    } catch (error) {
      if (error instanceof TelephonyProviderError) throw error;
      throw new TelephonyProviderError(
        `Telephony webhook response failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  async validateWebhook(request: TelephonyWebhookValidationRequest): Promise<boolean> {
    const provider = this.resolveProvider('validateWebhook', request.provider || this.config.defaultProvider);
    if (!provider.validateWebhook) throw new TelephonyCapabilityError(provider.info.name, 'webhook validation');
    return provider.validateWebhook(request);
  }

  async getCall(request: GetCallRequest): Promise<TelephonyCallDetails> {
    const provider = this.resolveProvider('getCall', request.provider || this.config.defaultProvider);
    if (!provider.getCall) throw new TelephonyCapabilityError(provider.info.name, 'call lookup');

    try {
      return await provider.getCall(request);
    } catch (error) {
      if (error instanceof TelephonyProviderError) throw error;
      throw new TelephonyProviderError(
        `Telephony call lookup failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  async endCall(request: EndCallRequest): Promise<TelephonyCallDetails> {
    const provider = this.resolveProvider('endCall', request.provider || this.config.defaultProvider);
    if (!provider.endCall) throw new TelephonyCapabilityError(provider.info.name, 'call control');

    try {
      return await provider.endCall(request);
    } catch (error) {
      if (error instanceof TelephonyProviderError) throw error;
      throw new TelephonyProviderError(
        `Telephony call hangup failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  parseStatusCallback(
    providerName: string,
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined {
    const provider = this.resolveProvider('parseStatusCallback', providerName);
    if (!provider.parseStatusCallback) {
      throw new TelephonyCapabilityError(provider.info.name, 'status callback parsing');
    }
    return provider.parseStatusCallback(body);
  }

  async listPhoneNumbers(request: ListPhoneNumbersRequest = {}): Promise<TelephonyPhoneNumber[]> {
    const provider = this.resolveProvider('listPhoneNumbers', request.provider || this.config.defaultProvider);
    if (!provider.listPhoneNumbers) throw new TelephonyCapabilityError(provider.info.name, 'phone number listing');

    try {
      return await provider.listPhoneNumbers(request);
    } catch (error) {
      if (error instanceof TelephonyProviderError) throw error;
      throw new TelephonyProviderError(
        `Telephony phone number listing failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  async updatePhoneNumber(request: UpdatePhoneNumberRequest): Promise<TelephonyPhoneNumber> {
    const provider = this.resolveProvider('updatePhoneNumber', request.provider || this.config.defaultProvider);
    if (!provider.updatePhoneNumber) throw new TelephonyCapabilityError(provider.info.name, 'phone number updates');

    try {
      return await provider.updatePhoneNumber(request);
    } catch (error) {
      if (error instanceof TelephonyProviderError) throw error;
      throw new TelephonyProviderError(
        `Telephony phone number update failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  parseMediaStreamEvent(
    providerName: string,
    message: string | Record<string, unknown>,
  ): TelephonyMediaStreamEvent | undefined {
    const provider = this.resolveProvider('parseMediaStreamEvent', providerName);
    if (!provider.parseMediaStreamEvent) throw new TelephonyCapabilityError(provider.info.name, 'media stream parsing');
    return provider.parseMediaStreamEvent(message);
  }

  formatAudioMessage(
    providerName: string,
    streamId: string,
    payload: string,
    options?: { event?: 'media' | 'mark' | 'clear'; markName?: string },
  ): TelephonyOutboundAudioMessage {
    const provider = this.resolveProvider('formatAudioMessage', providerName);
    if (!provider.formatAudioMessage) throw new TelephonyCapabilityError(provider.info.name, 'outbound media messages');
    return provider.formatAudioMessage(streamId, payload, options);
  }

  private resolveProvider(capability: TelephonyCapability, preferred?: string): TelephonyProvider {
    if (preferred) {
      const provider = this.providers.get(preferred);
      if (!provider) throw new TelephonyProviderError(`Telephony provider "${preferred}" is not registered`, preferred);
      return provider;
    }

    for (const provider of this.providers.values()) {
      if (provider[capability]) return provider;
    }

    throw new TelephonyProviderError(`No telephony provider registered for ${capability}`);
  }
}
