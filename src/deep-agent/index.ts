/**
 * Deep agents: agents for long, multi-step work — a plan, a workspace, helpers to delegate to, skills
 * to load when needed, and a context that stays small however long the work runs.
 *
 * A preset, not an engine: `createDeepAgent()` composes `createAgent()` with its tools and middleware,
 * and returns the same compiled graph, with the same checkpoints, approvals, events, and server
 * support as any agent.
 */
import { type AgentGraph, type AgentMiddleware, createAgent, type CreateAgentOptions } from '../agent/create-agent.js';
import { codeTool, type Interpreter } from '../agent/interpreter.js';
import { contextEditor, type ContextEditorOptions } from '../agent/middleware/context-editor.js';
import { type ContextOffloadOptions, filesystemContext } from '../agent/middleware/filesystem.js';
import { toolSelector, type ToolSelectorOptions } from '../agent/middleware/tool-selector.js';
import { permissionPolicy, type PermissionPolicyLike } from '../agent/permissions.js';
import { type Sandbox, sandboxTools } from '../agent/sandbox.js';
import { tool } from '../agent/tool.js';
import type { ToolDefinition } from '../types/messages.js';
import { type DeepHelperLimits, helperTools } from './helpers.js';

export type { DeepHelperLimits } from './helpers.js';

/** A helper the deep agent can hand a self-contained piece of work to, with a fresh context. */
export interface DeepSubagent {
  /** Its name, as the agent delegates to it. */
  name: string;
  /** What it is for, written for the model that decides when to delegate. */
  description: string;
  /** Its own instructions. */
  instructions: string;
  /**
   * The tools it may use, by name, from the deep agent's own. Defaults to all of them except
   * `delegate`, so a helper cannot delegate in turn. A tool named in `interruptOn` is never a
   * helper's: a helper keeps no checkpoints, so it could not pause for the approval.
   */
  tools?: readonly string[];
  /** Its model. Defaults to the deep agent's. */
  model?: string;
  /** Model calls it may make. Defaults to 20. */
  maxIterations?: number;
}

/** Instructions the agent loads only when a task needs them: a procedure, a checklist, a house style. */
export interface DeepSkill {
  /** Its name, as the agent asks for it. */
  name: string;
  /** When it applies, written for the model. Only this is in the agent's context until it is loaded. */
  description: string;
  /** The instructions themselves. */
  instructions?: string;
  /** A file in the sandbox that holds them, read when the skill is loaded, instead of `instructions`. */
  file?: string;
}

/** Options for `createDeepAgent()`. Everything `createAgent()` takes, and the parts of a deep agent. */
export interface DeepAgentOptions extends Omit<CreateAgentOptions, 'systemPrompt' | 'permissions'> {
  /** What this agent is for. Placed before the deep agent's own working instructions. */
  instructions?: string;
  /**
   * The workspace the agent reads, writes, and runs commands in, through `sandboxTools()`, mounted
   * at `/workspace`. Without one, the agent has no filesystem and no offloading.
   */
  sandbox?: Sandbox;
  /**
   * Commands the agent may run in the sandbox, as prefixes a permission policy grants: `node`,
   * `npm test`, `git status`. Without any, there is no `run_command` tool.
   */
  commands?: readonly string[];
  /** Records a plan with `write_todos` and keeps it current. Defaults to true. */
  planning?: boolean;
  /**
   * Runs the model's code with the agent's own tools callable from it, as `run_code`, so many calls
   * take one step. Every call the code makes is decided by the agent's policy, and a tool that needs
   * approval cannot be called from code. Given one, the default policy grants `code`.
   */
  interpreter?: Interpreter;
  /**
   * Helpers the agent can delegate to through one `delegate` tool. The agent waits for a helper's
   * answer, or sets `background` and collects it later with `collect_helper`.
   */
  subagents?: readonly DeepSubagent[];
  /**
   * Lets the agent create helpers during a run, from instructions it writes, within these limits.
   * Off unless given.
   */
  createHelpers?: DeepHelperLimits;
  /** How many helpers may work in the background in one thread at once. Defaults to 4. */
  maxBackgroundHelpers?: number;
  /** Skills the agent can load through `load_skill`. */
  skills?: readonly DeepSkill[];
  /** Instruction files from the sandbox the model sees on every call. Defaults to `AGENTS.md`. */
  include?: readonly string[];
  /**
   * Writes tool results longer than the limit to `.context/` in the sandbox, leaving a preview and the
   * path. Defaults to results over 20,000 characters; `false` keeps them whole.
   */
  offload?: ContextOffloadOptions | false;
  /**
   * Clears old tool results from what the model is sent once the request grows. Defaults to past
   * 60,000 estimated tokens, never clearing the plan; `false` turns it off.
   */
  contextEditing?: ContextEditorOptions | false;
  /**
   * Sends the model only the tools relevant to the turn, for an agent with many. The deep agent's own
   * tools are always sent. Off unless given.
   */
  toolSelection?: ToolSelectorOptions;
  /**
   * Decides every tool call. Defaults to a policy that grants the workspace, the `commands`, the plan,
   * delegation, and skills, and denies everything else, so a tool of your own needs a grant here or
   * its own policy. `false` runs every call.
   */
  permissions?: PermissionPolicyLike | false;
  /** Middleware run after the deep agent's own. */
  middleware?: AgentMiddleware[];
}

const MOUNT = '/workspace';

/** The deep agent's own tools, always offered to the model. */
const CORE_TOOLS = [
  'write_todos',
  'delegate',
  'collect_helper',
  'load_skill',
  'read_file',
  'write_file',
  'edit_file',
  'list_files',
  'glob_files',
  'grep_files',
  'read_media',
  'run_command',
  'run_code',
  'search_tools',
];

/**
 * Builds a deep agent: `createAgent()` with a plan, a sandboxed workspace, subagents, skills, context
 * offloading, optional tool selection, and a permission policy.
 *
 * ```ts
 * const agent = createDeepAgent({
 *   client: ai,
 *   model: 'claude-sonnet-5-5',
 *   instructions: 'You maintain this repository.',
 *   sandbox,
 *   commands: ['node', 'npm test', 'git diff'],
 *   subagents: [{ name: 'reviewer', description: 'Reviews a change', instructions: 'Review the diff for bugs.' }],
 *   skills: [{ name: 'release-notes', description: 'Writing release notes', file: 'skills/release-notes.md' }],
 *   checkpointer,
 * });
 * const run = await agent.invoke(agentInput('Fix the failing test'), { threadId });
 * ```
 */
export function createDeepAgent(options: DeepAgentOptions): AgentGraph {
  const {
    instructions,
    sandbox,
    commands = [],
    planning = true,
    interpreter,
    subagents = [],
    createHelpers,
    maxBackgroundHelpers = 4,
    skills = [],
    include = ['AGENTS.md'],
    offload,
    contextEditing,
    toolSelection,
    permissions,
    middleware = [],
    tools: extraTools = [],
    ...agentOptions
  } = options;

  const workspace: ToolDefinition[] = sandbox
    ? [...sandboxTools(sandbox, { shell: commands.length > 0, mount: MOUNT }), editFileTool(sandbox)]
    : [];
  // A helper has no checkpoints, and code cannot pause, so a tool that needs approval is called only
  // by the agent itself, directly.
  const approved = new Set(Object.keys(agentOptions.interruptOn ?? {}));
  const policy = permissions === false ? undefined : (permissions ?? defaultPolicy(commands, Boolean(interpreter)));
  const direct: ToolDefinition[] = [
    ...(planning ? [writeTodosTool()] : []),
    ...(skills.length > 0 ? [loadSkillTool(skills, sandbox)] : []),
    ...workspace,
    ...extraTools,
  ];
  const own: ToolDefinition[] = [
    ...direct,
    ...(interpreter
      ? [
          codeTool(interpreter, {
            tools: direct.filter((candidate) => !approved.has(candidate.name)),
            ...(policy ? { permissions: policy } : {}),
          }),
        ]
      : []),
  ];

  const { interruptOn: _approvals, checkpointer, ...helperOptions } = agentOptions;
  const helping =
    subagents.length > 0 || createHelpers
      ? helperTools({
          declared: subagents,
          ...(createHelpers ? { create: createHelpers } : {}),
          tools: own.filter((candidate) => !approved.has(candidate.name)),
          agentOptions: helperOptions,
          ...(policy ? { permissions: policy } : {}),
          ...(checkpointer ? { checkpointer } : {}),
          name: options.name ?? 'deep-agent',
          note: WORKSPACE_NOTE,
          maxBackground: maxBackgroundHelpers,
        })
      : [];
  const tools = [...own, ...helping];

  const kit: AgentMiddleware[] = [
    ...(sandbox && (include.length > 0 || offload !== false)
      ? [
          filesystemContext({
            source: sandbox,
            include,
            ...(offload === false ? {} : { offload: { overChars: 20_000, ...offload } }),
          }),
        ]
      : []),
    ...(contextEditing === false
      ? []
      : [
          contextEditor({
            triggerTokens: 60_000,
            ...contextEditing,
            exclude: ['write_todos', ...(contextEditing?.exclude ?? [])],
          }),
        ]),
    ...(toolSelection
      ? [toolSelector({ ...toolSelection, always: [...CORE_TOOLS, ...(toolSelection.always ?? [])] })]
      : []),
  ];

  return createAgent({
    maxIterations: 40,
    ...agentOptions,
    systemPrompt: systemPrompt(instructions, {
      planning,
      sandbox: Boolean(sandbox),
      search: Boolean(sandbox?.glob && sandbox.grep),
      media: Boolean(sandbox?.readBytes),
      code: interpreter?.language,
      commands,
      subagents,
      create: Boolean(createHelpers),
      skills,
    }),
    tools,
    middleware: [...kit, ...middleware],
    ...(policy ? { permissions: policy } : {}),
  });
}

/**
 * The policy a deep agent gets unless given one: the workspace, the commands, and its own tools, and
 * code when it was given an interpreter.
 */
function defaultPolicy(commands: readonly string[], code: boolean): PermissionPolicyLike {
  return permissionPolicy({
    filesystem: { write: [`${MOUNT}/**`] },
    shell: { allow: commands },
    tools: { write_todos: 'allow', delegate: 'allow', collect_helper: 'allow', load_skill: 'allow' },
    ...(code ? { code: 'allow' as const } : {}),
  });
}

const WORKSPACE_NOTE = `Files live in ${MOUNT}; paths are relative to it.`;

function systemPrompt(
  instructions: string | undefined,
  parts: {
    planning: boolean;
    sandbox: boolean;
    search: boolean;
    media: boolean;
    code: string | undefined;
    commands: readonly string[];
    subagents: readonly DeepSubagent[];
    create: boolean;
    skills: readonly DeepSkill[];
  },
): string {
  const lines: string[] = [];
  if (instructions) lines.push(instructions, '');
  lines.push('Work through the task step by step, checking each step before the next.');
  if (parts.planning) {
    lines.push(
      'For any task of more than two steps, first record a plan with write_todos, then keep it current: mark a step in_progress when you start it and completed when it is done.',
    );
  }
  if (parts.sandbox) {
    lines.push(
      `${WORKSPACE_NOTE} Read before you change a file; prefer edit_file to rewriting a whole file. A large result may be saved to a file and shown as a preview: read the file when you need the rest.`,
    );
    if (parts.search) {
      lines.push('Find files with glob_files and the lines you need with grep_files before reading whole files.');
    }
    if (parts.media) lines.push('Look at images, audio, and PDFs with read_media.');
    if (parts.commands.length > 0) lines.push(`You may run these commands: ${parts.commands.join(', ')}.`);
  }
  if (parts.code) {
    lines.push(
      `When a task takes many tool calls, or a filter on what they return, write ${parts.code} for run_code and call the tools from it in one step.`,
    );
  }
  if (parts.subagents.length > 0 || parts.create) {
    lines.push('', 'Delegate a self-contained piece of work with delegate.');
    if (parts.subagents.length > 0) lines.push('The helpers:');
    for (const helper of parts.subagents) lines.push(`- ${helper.name}: ${helper.description}`);
    if (parts.create)
      lines.push('For work none of them fits, create a helper: give delegate a new name and its instructions.');
    lines.push(
      'Set background to keep working while a helper runs, and collect its answer with collect_helper when you need it.',
    );
  }
  if (parts.skills.length > 0) {
    lines.push('', 'Skills you can load with load_skill when a task calls for one:');
    for (const skill of parts.skills) lines.push(`- ${skill.name}: ${skill.description}`);
  }
  return lines.join('\n');
}

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** The plan, rewritten whole each time. It lives in the transcript, so it is checkpointed with the run. */
function writeTodosTool(): ToolDefinition {
  return tool<{ todos: Todo[] }>({
    name: 'write_todos',
    description:
      'Records the plan for this task as a list of steps, each pending, in_progress, or completed. Send the whole list each time.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    capabilities: [],
    execute: ({ todos }) => {
      const list = Array.isArray(todos) ? todos : [];
      const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
      const done = list.filter((todo) => todo.status === 'completed').length;
      return `Plan (${done}/${list.length} done):\n${list.map((todo) => `${mark[todo.status] ?? '[ ]'} ${todo.content}`).join('\n')}`;
    },
  });
}

/** A precise edit: replaces one exact occurrence of a text, so a change never rewrites a whole file. */
function editFileTool(sandbox: Sandbox): ToolDefinition {
  const local = (file: unknown) =>
    String(file ?? '')
      .replace(/\\/g, '/')
      .replace(new RegExp(`^${MOUNT}/`), '')
      .replace(/^\/+/, '');
  return tool<{ path: string; old_text: string; new_text: string }>({
    name: 'edit_file',
    description: `Replaces one exact occurrence of old_text with new_text in a file. Paths are relative to ${MOUNT}.`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
    capabilities: (args) => [`filesystem:write:${MOUNT}/${local(args.path)}`],
    execute: async ({ path, old_text: oldText, new_text: newText }) => {
      const file = local(path);
      const text = await sandbox.readFile(file);
      const count = text.split(String(oldText)).length - 1;
      if (count === 0) throw new Error(`old_text was not found in ${file}`);
      if (count > 1)
        throw new Error(`old_text appears ${count} times in ${file}; include more context so it appears once`);
      await sandbox.writeFile(
        file,
        text.replace(String(oldText), () => String(newText)),
      );
      return { edited: file };
    },
  });
}

/** Progressive disclosure: only a skill's description is in context until the agent loads it. */
function loadSkillTool(skills: readonly DeepSkill[], sandbox: Sandbox | undefined): ToolDefinition {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return tool<{ name: string }>({
    name: 'load_skill',
    description: 'Loads the instructions of a skill by name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', enum: skills.map((skill) => skill.name) } },
      required: ['name'],
    },
    capabilities: [],
    execute: async ({ name }) => {
      const skill = byName.get(String(name));
      if (!skill) throw new Error(`No skill named "${String(name)}"`);
      if (skill.instructions !== undefined) return skill.instructions;
      if (skill.file && sandbox) return sandbox.readFile(skill.file);
      throw new Error(`Skill "${skill.name}" has no instructions`);
    },
  });
}
