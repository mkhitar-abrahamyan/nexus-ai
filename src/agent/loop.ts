import type { AgentConfig, AgentResult, AgentStep, ToolExecutionResult } from '../types/agent.js';
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
          stopReason: 'completed',
          response,
          messages,
        };
      }

      for (const toolCall of response.toolCalls) {
        const parsed = parseToolArgs(toolCall.function.arguments);
        // Malformed arguments are reported back to the model rather than guessed at: running a tool
        // with empty arguments could perform an action the model never asked for.
        const result: ToolExecutionResult = parsed.ok
          ? await executor.execute(toolCall.function.name, parsed.args)
          : { ok: false, error: parsed.error };
        const args = parsed.ok ? parsed.args : {};

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
      stopReason: 'max_iterations',
      response: lastResponse,
      messages,
    };
  }
}

type ParsedToolArgs = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function parseToolArgs(raw: string): ParsedToolArgs {
  // An absent argument string is a call with no arguments, which is legitimate.
  if (!raw?.trim()) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { ok: true, args: parsed };
    return { ok: false, error: 'Tool arguments must be a JSON object; the tool was not run' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Tool arguments are not valid JSON (${reason}); the tool was not run` };
  }
}
