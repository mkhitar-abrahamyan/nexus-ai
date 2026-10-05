import type { ContentPart, Message, ToolDefinition, ToolOutput } from '../types/messages.js';
import type { ToolExecutionResult } from '../types/agent.js';

/** Defines a tool the model can call, typing its arguments. */
export function tool<TArgs extends Record<string, unknown> = Record<string, unknown>>(definition: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: TArgs) => Promise<unknown> | unknown;
  /** What the tool does to the world, for a permission policy; see `ToolDefinition.capabilities`. */
  capabilities?: readonly string[] | ((args: TArgs) => readonly string[]);
}): ToolDefinition {
  const capabilities = definition.capabilities;
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: async (args) => definition.execute(args as TArgs),
    ...(capabilities === undefined
      ? {}
      : {
          capabilities:
            typeof capabilities === 'function'
              ? (args: Record<string, unknown>) => capabilities(args as TArgs)
              : capabilities,
        }),
  };
}

/**
 * Builds a tool's result as content: text, images, and asset references, in order. A string becomes
 * a text part. Returned from `execute`, it is sent as the tool message itself, so an image a tool
 * produced reaches the model as an image or as a reference rather than as base64 JSON.
 */
export function toolOutput(...content: Array<ContentPart | string>): ToolOutput {
  return {
    type: 'tool_output',
    content: content.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part)),
  };
}

/** True for a result built with `toolOutput()`. */
export function isToolOutput(value: unknown): value is ToolOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'tool_output' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * What the model reads for a tool's result: the parts of a `toolOutput()`, or anything else as JSON.
 * An error is always JSON, as `{ error }`.
 */
export function toolMessageContent(result: ToolExecutionResult): Message['content'] {
  if (result.ok && isToolOutput(result.result)) return result.result.content;
  return JSON.stringify(result.ok ? (result.result ?? null) : { error: result.error });
}

/** Runs tool calls by name, reporting failures as results rather than throwing. */
export class ToolExecutor {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = []) {
    for (const toolDefinition of tools) {
      this.register(toolDefinition);
    }
  }

  /** Adds a tool, replacing one with the same name. Returns the executor, for chaining. */
  register(toolDefinition: ToolDefinition): this {
    this.tools.set(toolDefinition.name, toolDefinition);
    return this;
  }

  /** Whether a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** A registered tool, or `undefined`. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Every registered tool. */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Runs a tool. An unknown name or a thrown error comes back as a failed result. */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const toolDefinition = this.tools.get(name);

    if (!toolDefinition) {
      return { ok: false, error: `Tool "${name}" is not registered` };
    }

    if (!toolDefinition.execute) {
      return { ok: false, error: `Tool "${name}" does not have an execute function` };
    }

    try {
      const result = await toolDefinition.execute(args);
      return { ok: true, result };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
