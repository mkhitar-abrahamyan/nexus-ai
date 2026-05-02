import type { AgentConfig, AgentResult, AgentStep } from '../types/agent.js';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { ToolExecutor } from './tool.js';

export interface AgentModelClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export class AgentLoop {
  constructor(private client: AgentModelClient) {}

  async run(config: AgentConfig): Promise<AgentResult> {
    const maxIterations = config.maxIterations ?? 8;
    const executor = new ToolExecutor(config.tools || []);
    const steps: AgentStep[] = [];
    const messages: Message[] = [];

    if (config.systemPrompt) {
      messages.push({ role: 'system', content: config.systemPrompt });
    }

    messages.push({ role: 'user', content: config.goal });

    let lastResponse: NexusResponse | null = null;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const response = await this.client.complete({
        model: config.model,
        messages,
        tools: executor.list(),
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        metadata: config.metadata,
      });

      lastResponse = response;

      const modelStep: AgentStep = {
        iteration,
        type: response.toolCalls?.length ? 'model' : 'final',
        message: response.content || (response.toolCalls?.length ? 'Model requested tool calls' : ''),
      };
      steps.push(modelStep);
      await config.onStep?.(modelStep);

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return {
          content: response.content,
          steps,
          iterations: iteration,
          response,
          messages,
        };
      }

      for (const toolCall of response.toolCalls) {
        const args = this.parseToolArgs(toolCall.function.arguments);
        const result = await executor.execute(toolCall.function.name, args);

        const toolStep: AgentStep = {
          iteration,
          type: 'tool',
          message: result.ok ? 'Tool executed successfully' : `Tool failed: ${result.error}`,
          toolName: toolCall.function.name,
          toolArgs: args,
          toolResult: result.ok ? result.result : { error: result.error },
        };

        steps.push(toolStep);
        await config.onToolCall?.(toolStep);
        await config.onStep?.(toolStep);

        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify(result.ok ? result.result : { error: result.error }),
        });
      }
    }

    if (!lastResponse) {
      throw new Error('Agent loop failed before receiving a model response');
    }

    return {
      content: lastResponse.content,
      steps,
      iterations: maxIterations,
      response: lastResponse,
      messages,
    };
  }

  private parseToolArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw || '{}');
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}
