import type { CompletionRequest, Message, ToolDefinition } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type {
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  VoicePromptText,
  VoiceSessionConfig,
  VoiceSessionToolStep,
  VoiceSessionTurnInput,
  VoiceSessionTurnResponse,
  VoiceTaskPrompt,
  VoiceTaskPromptMatcher,
} from '../types/voice.js';
import { ToolExecutor } from '../agent/tool.js';
import { generateRequestId } from '../utils/ids.js';
import { VoiceProviderError } from './errors.js';

export interface VoiceSessionCompletionClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export interface VoiceSessionRuntime {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse>;
  speak(request: SpeechRequest): Promise<SpeechResponse>;
}

export class VoiceSession {
  readonly id: string;
  private history: Message[];

  constructor(
    private config: VoiceSessionConfig,
    private voice: VoiceSessionRuntime,
    private client: VoiceSessionCompletionClient,
  ) {
    this.id = config.id || generateRequestId();
    this.history = [...(config.messages || [])];
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  reset(messages: Message[] = this.config.messages || []): this {
    this.history = [...messages];
    return this;
  }

  async handleTurn(input: VoiceSessionTurnInput = {}): Promise<VoiceSessionTurnResponse> {
    const transcript = input.transcript === undefined ? await this.transcribeInput(input) : undefined;
    const transcriptText = input.transcript ?? transcript?.text ?? '';
    const selectedTasks = await this.selectTaskPrompts(transcriptText, input);
    const tools = this.selectTools(selectedTasks, input.tools);
    const systemMessage = this.createSystemMessage(selectedTasks, input);
    const userMessage = this.createTranscriptMessage(transcriptText, input);
    const workingMessages = [
      ...(systemMessage ? [systemMessage] : []),
      ...this.history,
      ...(input.completion?.messages || []),
      userMessage,
    ];
    const newMessages: Message[] = [userMessage];
    const toolSteps: VoiceSessionToolStep[] = [];
    const response = await this.completeWithTools(workingMessages, newMessages, tools, toolSteps, input, selectedTasks);
    const speech = await this.speakResponse(response.content, input);

    if (this.config.maintainHistory !== false) {
      this.history.push(...newMessages);
    }

    return {
      sessionId: this.id,
      transcript,
      transcriptText,
      response,
      speech,
      toolSteps,
      selectedTaskPrompts: selectedTasks.map((task) => task.name),
      messages: workingMessages,
    };
  }

  private async transcribeInput(input: VoiceSessionTurnInput): Promise<TranscriptionResponse> {
    if (!input.audio) {
      throw new VoiceProviderError('VoiceSession turn requires either "transcript" or "audio"');
    }

    return this.voice.transcribe({
      ...this.config.transcription,
      ...input.transcription,
      audio: input.audio,
    });
  }

  private async completeWithTools(
    workingMessages: Message[],
    newMessages: Message[],
    tools: ToolDefinition[],
    toolSteps: VoiceSessionToolStep[],
    input: VoiceSessionTurnInput,
    selectedTasks: VoiceTaskPrompt[],
  ): Promise<NexusResponse> {
    const executor = new ToolExecutor(tools);
    const maxIterations = Math.max(
      1,
      (input.completion?.metadata?.voiceMaxToolIterations as number) || this.config.maxToolIterations || 4,
    );
    let response: NexusResponse | undefined;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      response = await this.client.complete(this.createCompletionRequest(workingMessages, tools, input, selectedTasks));
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      };
      workingMessages.push(assistantMessage);
      newMessages.push(assistantMessage);

      if (!response.toolCalls?.length) return response;

      for (const toolCall of response.toolCalls) {
        const args = this.parseToolArgs(toolCall.function.arguments);
        const result = await executor.execute(toolCall.function.name, args);
        const step: VoiceSessionToolStep = {
          iteration,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          toolArgs: args,
          ok: result.ok,
          result: result.result,
          error: result.error,
        };
        toolSteps.push(step);
        await this.config.onToolCall?.(step);

        const toolMessage: Message = {
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify(result.ok ? result.result : { error: result.error }),
        };
        workingMessages.push(toolMessage);
        newMessages.push(toolMessage);
      }
    }

    if (!response) throw new Error('VoiceSession failed before receiving a model response');
    return response;
  }

  private createCompletionRequest(
    messages: Message[],
    tools: ToolDefinition[],
    input: VoiceSessionTurnInput,
    selectedTasks: VoiceTaskPrompt[],
  ): CompletionRequest {
    const completion = input.completion || {};
    return {
      model: completion.model || this.config.model,
      messages,
      tools: tools.length ? tools : undefined,
      temperature: completion.temperature ?? this.config.temperature,
      maxTokens: completion.maxTokens ?? this.config.maxTokens,
      topP: completion.topP ?? this.config.topP,
      responseFormat: completion.responseFormat ?? this.config.responseFormat,
      stop: completion.stop ?? this.config.stop,
      signal: completion.signal,
      userId: completion.userId ?? this.config.userId,
      metadata: {
        ...this.config.metadata,
        ...input.metadata,
        ...completion.metadata,
        voiceSession: {
          id: this.id,
          selectedTaskPrompts: selectedTasks.map((task) => task.name),
        },
      },
    };
  }

  private async speakResponse(text: string, input: VoiceSessionTurnInput): Promise<SpeechResponse | undefined> {
    const speech = input.speech ?? this.config.speech;
    if (!speech) return undefined;

    return this.voice.speak({
      ...speech,
      text,
    });
  }

  private async selectTaskPrompts(transcriptText: string, input: VoiceSessionTurnInput): Promise<VoiceTaskPrompt[]> {
    const tasks = [...(this.config.taskPrompts || []), ...(input.taskPrompts || [])];
    const selected: VoiceTaskPrompt[] = [];

    for (const task of tasks) {
      if (await this.matchesTask(task.when, transcriptText, input)) {
        selected.push(task);
      }
    }

    return selected;
  }

  private async matchesTask(
    matcher: VoiceTaskPromptMatcher | undefined,
    transcriptText: string,
    input: VoiceSessionTurnInput,
  ): Promise<boolean> {
    if (!matcher) return true;
    if (typeof matcher === 'string') return transcriptText.toLowerCase().includes(matcher.toLowerCase());
    if (matcher instanceof RegExp) return matcher.test(transcriptText);
    if (Array.isArray(matcher)) {
      return matcher.some((item) => {
        if (typeof item === 'string') return transcriptText.toLowerCase().includes(item.toLowerCase());
        return item.test(transcriptText);
      });
    }

    return matcher({
      transcriptText,
      messages: this.history,
      metadata: input.metadata,
    });
  }

  private selectTools(selectedTasks: VoiceTaskPrompt[], turnTools: ToolDefinition[] | undefined): ToolDefinition[] {
    const tools = [...(this.config.tools || []), ...(turnTools || [])];
    if (this.config.toolSelection !== 'task') return tools;

    const selectedNames = new Set(selectedTasks.flatMap((task) => task.tools || []));
    if (selectedNames.size === 0) return tools;
    return tools.filter((tool) => selectedNames.has(tool.name));
  }

  private createSystemMessage(selectedTasks: VoiceTaskPrompt[], input: VoiceSessionTurnInput): Message | undefined {
    const parts = [
      ...this.texts(this.config.systemPrompt),
      ...this.texts(this.config.prompt),
      ...this.texts(this.config.instructions),
      ...this.texts(input.prompt),
      ...this.texts(input.instructions),
      ...selectedTasks.flatMap((task) => this.taskTexts(task)),
    ];

    if (!parts.length) return undefined;
    return {
      role: 'system',
      content: parts.join('\n\n'),
    };
  }

  private taskTexts(task: VoiceTaskPrompt): string[] {
    const parts = [...this.texts(task.prompt), ...this.texts(task.instructions)];
    if (!parts.length) return [];
    return [`Task "${task.name}":\n${parts.join('\n\n')}`];
  }

  private createTranscriptMessage(transcript: string, input: VoiceSessionTurnInput): Message {
    const config = this.config.transcriptMessage;
    const completionConfig = input.completion?.metadata
      ?.voiceTranscriptMessage as VoiceSessionConfig['transcriptMessage'];
    const merged = completionConfig || config;
    const template = merged?.template || '{{transcript}}';

    return {
      role: merged?.role || 'user',
      content: template.replace('{{transcript}}', transcript),
    };
  }

  private texts(value?: VoicePromptText): string[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  private parseToolArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
