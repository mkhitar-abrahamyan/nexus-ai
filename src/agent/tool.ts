import type { ToolDefinition } from '../types/messages.js';
import type { ToolExecutionResult } from '../types/agent.js';

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

export class ToolExecutor {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = []) {
    for (const toolDefinition of tools) {
      this.register(toolDefinition);
    }
  }

  register(toolDefinition: ToolDefinition): this {
    this.tools.set(toolDefinition.name, toolDefinition);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

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
