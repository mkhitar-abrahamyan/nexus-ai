import type { ToolDefinition } from '../types/messages.js';
import type { ToolExecutionResult } from '../types/agent.js';

/** Defines a tool the model can call, typing its arguments. */
export function tool<TArgs extends Record<string, unknown> = Record<string, unknown>>(definition: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: TArgs) => Promise<unknown> | unknown;
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: async (args) => definition.execute(args as TArgs),
  };
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
