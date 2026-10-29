import type {
  AnswerCallRequest,
  CreateCallRequest,
  CreateCallResponse,
  DeleteRecordingRequest,
  DownloadRecordingRequest,
  EndCallRequest,
  GetCallRequest,
  JoinConferenceRequest,
  ListPhoneNumbersRequest,
  SendMessageRequest,
  StartRecordingRequest,
  StopRecordingRequest,
  TelephonyCallDetails,
  TelephonyConferenceJoin,
  TelephonyMessage,
  TelephonyRecording,
  TelephonyRecordingAudio,
  TelephonyRecordingStarted,
  TelephonyTransfer,
  TransferCallRequest,
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
  EndGatherRequest,
  TelephonyGatherResult,
} from '../types/telephony.js';
import { TelephonyCapabilityError, TelephonyProviderError } from './errors.js';
import { FamilyTelemetry, type FamilyRuntime } from '../ops/family-telemetry.js';
import type { ProviderCallContext } from '../types/lifecycle.js';

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
  | 'updatePhoneNumber'
  | 'answerCall'
  | 'transferCall'
  | 'joinConference'
  | 'startRecording'
  | 'stopRecording'
  | 'parseRecordingCallback'
  | 'downloadRecording'
  | 'deleteRecording'
  | 'parseGatherResult'
  | 'endGather'
  | 'sendMessage'
  | 'parseMessageWebhook';

/**
 * Routes telephony operations to registered providers: the one a request names, the configured
 * default, or the first that supports the operation.
 */
export class TelephonyManager {
  private providers = new Map<string, TelephonyProvider>();

  private readonly telemetry: FamilyTelemetry;
  /** Text messages are a family of their own, so a budget or a rate limit can hold them apart from calls. */
  private readonly messaging: FamilyTelemetry;

  constructor(
    private config: TelephonyConfig = {},
    runtime: FamilyRuntime = {},
  ) {
    this.telemetry = new FamilyTelemetry('telephony', runtime);
    this.messaging = new FamilyTelemetry('messaging', runtime);
    for (const [name, provider] of Object.entries(config.providers || {})) {
      this.registerProvider(name, provider);
    }
  }

  /** Registers a provider under a name. Returns the manager, for chaining. */
  registerProvider(name: string, provider: TelephonyProvider): this {
    this.providers.set(name, provider);
    return this;
  }

  /** Whether a provider is registered. */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Every registered provider's name. */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Places an outbound call. */
  async createCall(request: CreateCallRequest): Promise<CreateCallResponse> {
    const provider = this.resolveProvider('createCall', request.provider || this.config.defaultProvider);
    const createCall = provider.createCall;
    if (!createCall) throw new TelephonyCapabilityError(provider.info.name, 'outbound calls');
    return this.call('createCall', provider, request, 'Telephony call creation', (context) =>
      createCall.call(provider, request, context),
    );
  }

  /** Builds a webhook response, such as TwiML. */
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

  /** Validates a webhook's signature. */
  async validateWebhook(request: TelephonyWebhookValidationRequest): Promise<boolean> {
    const provider = this.resolveProvider('validateWebhook', request.provider || this.config.defaultProvider);
    if (!provider.validateWebhook) throw new TelephonyCapabilityError(provider.info.name, 'webhook validation');
    return provider.validateWebhook(request);
  }

  /** Reads a call's details. */
  async getCall(request: GetCallRequest): Promise<TelephonyCallDetails> {
    const provider = this.resolveProvider('getCall', request.provider || this.config.defaultProvider);
    const getCall = provider.getCall;
    if (!getCall) throw new TelephonyCapabilityError(provider.info.name, 'call lookup');
    return this.call('getCall', provider, request, 'Telephony call lookup', (context) =>
      getCall.call(provider, request, context),
    );
  }

  /** Ends a call in progress. */
  async endCall(request: EndCallRequest): Promise<TelephonyCallDetails> {
    const provider = this.resolveProvider('endCall', request.provider || this.config.defaultProvider);
    const endCall = provider.endCall;
    if (!endCall) throw new TelephonyCapabilityError(provider.info.name, 'call control');
    return this.call('endCall', provider, request, 'Telephony call hangup', (context) =>
      endCall.call(provider, request, context),
    );
  }

  /** Parses a status callback through the named provider. */
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

  /** Lists phone numbers. */
  async listPhoneNumbers(request: ListPhoneNumbersRequest = {}): Promise<TelephonyPhoneNumber[]> {
    const provider = this.resolveProvider('listPhoneNumbers', request.provider || this.config.defaultProvider);
    const listPhoneNumbers = provider.listPhoneNumbers;
    if (!listPhoneNumbers) throw new TelephonyCapabilityError(provider.info.name, 'phone number listing');
    return this.call('listPhoneNumbers', provider, request, 'Telephony phone number listing', (context) =>
      listPhoneNumbers.call(provider, request, context),
    );
  }

  /** Changes where a phone number sends its calls. */
  async updatePhoneNumber(request: UpdatePhoneNumberRequest): Promise<TelephonyPhoneNumber> {
    const provider = this.resolveProvider('updatePhoneNumber', request.provider || this.config.defaultProvider);
    const updatePhoneNumber = provider.updatePhoneNumber;
    if (!updatePhoneNumber) throw new TelephonyCapabilityError(provider.info.name, 'phone number updates');
    return this.call('updatePhoneNumber', provider, request, 'Telephony phone number update', (context) =>
      updatePhoneNumber.call(provider, request, context),
    );
  }

  /**
   * Answers a call webhook, the same way on every provider: on one answered with markup, such as
   * Twilio, it renders the response the webhook returns; on one controlled by command, such as
   * Telnyx, it runs the response as the call's commands, and the webhook returns an empty body.
   * Either way, return what it resolves to from the webhook.
   */
  async answer(request: AnswerCallRequest): Promise<TelephonyWebhookResponse> {
    const provider = this.resolveProvider('createWebhookResponse', request.provider || this.config.defaultProvider);
    const answerCall = provider.answerCall;
    if (answerCall) {
      return this.call('answerCall', provider, request, 'Telephony call answer', (context) =>
        answerCall.call(provider, request, context),
      );
    }
    return this.createWebhookResponse(request);
  }

  /** Moves a call to another number or SIP address. */
  async transferCall(request: TransferCallRequest): Promise<TelephonyTransfer> {
    const provider = this.resolveProvider('transferCall', request.provider || this.config.defaultProvider);
    const transferCall = provider.transferCall;
    if (!transferCall) throw new TelephonyCapabilityError(provider.info.name, 'call transfer');
    return this.call('transferCall', provider, request, 'Telephony call transfer', (context) =>
      transferCall.call(provider, request, context),
    );
  }

  /** Puts a call into a conference, created by the first call to join it. */
  async joinConference(request: JoinConferenceRequest): Promise<TelephonyConferenceJoin> {
    const provider = this.resolveProvider('joinConference', request.provider || this.config.defaultProvider);
    const joinConference = provider.joinConference;
    if (!joinConference) throw new TelephonyCapabilityError(provider.info.name, 'conferences');
    return this.call('joinConference', provider, request, 'Telephony conference join', (context) =>
      joinConference.call(provider, request, context),
    );
  }

  /** Starts recording a call. The provider reports the recording once it is ready. */
  async startRecording(request: StartRecordingRequest): Promise<TelephonyRecordingStarted> {
    const provider = this.resolveProvider('startRecording', request.provider || this.config.defaultProvider);
    const startRecording = provider.startRecording;
    if (!startRecording) throw new TelephonyCapabilityError(provider.info.name, 'call recording');
    return this.call('startRecording', provider, request, 'Telephony recording start', (context) =>
      startRecording.call(provider, request, context),
    );
  }

  /** Stops recording a call. */
  async stopRecording(request: StopRecordingRequest): Promise<void> {
    const provider = this.resolveProvider('stopRecording', request.provider || this.config.defaultProvider);
    const stopRecording = provider.stopRecording;
    if (!stopRecording) throw new TelephonyCapabilityError(provider.info.name, 'call recording');
    return this.call('stopRecording', provider, request, 'Telephony recording stop', (context) =>
      stopRecording.call(provider, request, context),
    );
  }

  /** Parses what a gather collected, speech or keys, through the named provider. */
  parseGatherResult(
    providerName: string,
    body: string | URLSearchParams | Record<string, unknown>,
  ): TelephonyGatherResult | undefined {
    const provider = this.resolveProvider('parseGatherResult', providerName);
    if (!provider.parseGatherResult) throw new TelephonyCapabilityError(provider.info.name, 'gather results');
    return provider.parseGatherResult(body);
  }

  /**
   * Stops a gather still listening. On a provider whose gather ends by itself, such as Twilio's,
   * there is nothing to stop, and this resolves at once.
   */
  async endGather(request: EndGatherRequest): Promise<void> {
    const provider = this.resolveProvider('endGather', request.provider || this.config.defaultProvider);
    const endGather = provider.endGather;
    if (!endGather) return;
    return this.call('endGather', provider, request, 'Telephony gather end', (context) =>
      endGather.call(provider, request, context),
    );
  }

  /** Parses a finished recording's callback through the named provider. */
  parseRecordingCallback(
    providerName: string,
    body: string | URLSearchParams | Record<string, unknown>,
  ): TelephonyRecording | undefined {
    const provider = this.resolveProvider('parseRecordingCallback', providerName);
    if (!provider.parseRecordingCallback) throw new TelephonyCapabilityError(provider.info.name, 'recording callbacks');
    return provider.parseRecordingCallback(body);
  }

  /** Fetches a recording's audio from the provider that made it. */
  async downloadRecording(request: DownloadRecordingRequest): Promise<TelephonyRecordingAudio> {
    const provider = this.resolveProvider('downloadRecording', request.provider || request.recording.providerUsed);
    const downloadRecording = provider.downloadRecording;
    if (!downloadRecording) throw new TelephonyCapabilityError(provider.info.name, 'recording downloads');
    return this.call('downloadRecording', provider, request, 'Telephony recording download', (context) =>
      downloadRecording.call(provider, request, context),
    );
  }

  /** Deletes a recording at the provider. */
  async deleteRecording(request: DeleteRecordingRequest): Promise<void> {
    const provider = this.resolveProvider('deleteRecording', request.provider || this.config.defaultProvider);
    const deleteRecording = provider.deleteRecording;
    if (!deleteRecording) throw new TelephonyCapabilityError(provider.info.name, 'recording deletion');
    return this.call('deleteRecording', provider, request, 'Telephony recording delete', (context) =>
      deleteRecording.call(provider, request, context),
    );
  }

  /**
   * Sends a text message: an SMS, or an MMS with media. It runs through the client's lifecycle as a
   * `messaging` operation, so it is authorized, rate-limited, and audited apart from calls.
   */
  async sendMessage(request: SendMessageRequest): Promise<TelephonyMessage> {
    const provider = this.resolveProvider('sendMessage', request.provider || this.config.defaultProvider);
    const sendMessage = provider.sendMessage;
    if (!sendMessage) throw new TelephonyCapabilityError(provider.info.name, 'messaging');
    const name = provider.info.name;
    // An empty message is refused before it is an operation: it never counts against a rate or a budget.
    if (!request.body && !request.mediaUrls?.length) {
      throw new TelephonyProviderError('A message needs a body, media, or both', name);
    }
    return this.messaging.run(
      {
        operation: 'sendMessage',
        provider: name,
        tenantId: request.tenantId,
        ...(request.signal ? { signal: request.signal } : {}),
      },
      async (context) => {
        try {
          return await sendMessage.call(provider, request, context);
        } catch (error) {
          if (error instanceof TelephonyProviderError) throw error;
          throw new TelephonyProviderError(`Message send failed for provider "${name}"`, name, error);
        }
      },
    );
  }

  /** Parses a messaging webhook through the named provider: a message received, or a delivery change. */
  parseMessageWebhook(
    providerName: string,
    body: string | URLSearchParams | Record<string, unknown>,
  ): TelephonyMessage | undefined {
    const provider = this.resolveProvider('parseMessageWebhook', providerName);
    if (!provider.parseMessageWebhook) throw new TelephonyCapabilityError(provider.info.name, 'messaging webhooks');
    return provider.parseMessageWebhook(body);
  }

  /** Parses a media-stream message through the named provider. */
  parseMediaStreamEvent(
    providerName: string,
    message: string | Record<string, unknown>,
  ): TelephonyMediaStreamEvent | undefined {
    const provider = this.resolveProvider('parseMediaStreamEvent', providerName);
    if (!provider.parseMediaStreamEvent) throw new TelephonyCapabilityError(provider.info.name, 'media stream parsing');
    return provider.parseMediaStreamEvent(message);
  }

  /** Formats outbound audio, a mark, or a clear as the named provider's media-stream message. */
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

  /**
   * Runs one provider API call through the client's lifecycle, wrapping a provider's own error so the
   * caller always sees a `TelephonyProviderError`.
   */
  private call<T>(
    operation: string,
    provider: TelephonyProvider,
    request: { signal?: AbortSignal; tenantId?: string },
    action: string,
    fn: (context: ProviderCallContext) => Promise<T>,
  ): Promise<T> {
    const name = provider.info.name;
    const { signal, tenantId } = request;
    return this.telemetry.run(
      { operation, provider: name, tenantId, ...(signal ? { signal } : {}) },
      async (context) => {
        try {
          return await fn(context);
        } catch (error) {
          if (error instanceof TelephonyProviderError) throw error;
          throw new TelephonyProviderError(`${action} failed for provider "${name}"`, name, error);
        }
      },
    );
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
