# The deep-agent preset

<!-- covers: ./deep-agent -->

Agents for long, multi-step work. A deep agent has:
- a plan it keeps current;
- a workspace it reads, writes, and runs commands in;
- helpers it hands self-contained work to;
- skills it loads only when a task needs them;
- a context that stays small however long the work runs.

`createDeepAgent()` is a preset, not a third engine. It composes `createAgent()` with tools and
middleware from the agent kit, and returns the same compiled graph. Checkpoints, approvals, events,
the server, and the linter all work as they do for any agent.

```ts
import { agentInput } from 'nexus-ai-pro/agent';
import { processSandbox } from 'nexus-ai-pro/agent/sandbox';
import { createDeepAgent } from 'nexus-ai-pro/deep-agent';

const agent = createDeepAgent({
  client: ai,
  model: 'claude-sonnet-5-5',
  instructions: 'You maintain this repository.',
  sandbox: processSandbox({ root: './checkout' }),   // development only; a container in production
  commands: ['node', 'npm test', 'git diff'],
  subagents: [
    { name: 'reviewer', description: 'Reviews a change for bugs', instructions: 'You review changes for bugs.', tools: ['read_file'] },
  ],
  skills: [{ name: 'changelog', description: 'How to record a change', file: 'skills/changelog.md' }],
  checkpointer,
});

const run = await agent.invoke(agentInput('The test fails. Fix it.'), { threadId });
```

## What it is made of

| Part | What the agent gets | Built from |
| --- | --- | --- |
| Planning | `write_todos`: the plan, sent whole each time, each step `pending`, `in_progress`, or `completed`. It lives in the transcript, so it is checkpointed with the run and never cleared by context editing. | A tool |
| A workspace | `read_file`, `write_file`, `list_files`, and `edit_file` in the sandbox, mounted at `/workspace`, and `run_command` when `commands` names any. | `sandboxTools()` |
| Helpers | `delegate`: hands a task to a `DeepSubagent`, which runs to an answer in a fresh context, with the tools it was given, for the same principal. | `createAgent()` per helper |
| Skills | `load_skill`: only each `DeepSkill`'s name and description sit in the prompt until the agent loads one, from its `instructions` or a `file` in the sandbox. | A tool |
| Instruction files | `AGENTS.md`, or the files `include` names, on every call, after the system prompt. | `filesystemContext()` |
| Offloading | A tool result over 20,000 characters is written to `.context/` and left as a preview and a path. | `filesystemContext()` |
| Context editing | Old tool results are cleared from what the model is sent past 60,000 estimated tokens. | `contextEditor()` |
| Tool selection | With `toolSelection`, only the relevant tools are sent; the deep agent's own are always kept. | `toolSelector()` |
| Permissions | A policy that grants the workspace, the `commands`, and the agent's own tools, and denies everything else. | `permissionPolicy()` |

`DeepAgentOptions` takes everything `createAgent()` takes, except the system prompt, which the
preset composes from `instructions`, plus the parts above. Each part can be turned off or replaced:
- `planning: false`;
- `offload: false`;
- `contextEditing: false`;
- `permissions: false`, or a policy of your own;
- more `middleware`, which runs after the preset's own.

A tool of your own in `tools` needs a grant in your policy, because the default policy denies what
it does not know.

## Helpers and skills

A helper is for work that would otherwise fill the main context: reviewing a change, researching a
question, summarizing a long file. It sees only the task it is given, works with the tools named in
its `tools` (all of the agent's but `delegate`, by default), and returns its answer as the tool
result. It cannot delegate in turn, and it keeps no checkpoints between delegations. Because it
cannot pause, it never gets a tool named in `interruptOn`: work that needs a person's approval stays
with the main agent, which can pause.

A skill is for instructions that are long and rarely needed, such as a release procedure or a house
style. The model sees one line per skill until it calls `load_skill`, so ten skills cost ten lines of
context, not ten documents.

## Proof

In the test suite, a deep agent works on a fixture repository inside the reference sandbox. In
order, it:
1. plans;
2. runs the failing test;
3. reads the code and edits the bug;
4. runs the test again;
5. delegates a review to a helper;
6. loads a skill;
7. records the change.

Afterwards the test passes when run outside the agent. Along the way:
- the 30,000-character test log is offloaded to a file;
- the plan finishes at 5/5;
- the default policy refuses an unlisted command, a chained command, a write outside the workspace,
  and an ungranted tool of the application's own.

## Limitations

- The reference sandbox, `processSandbox()`, is for development. It is never a security boundary.
  Use a container or a VM behind the `Sandbox` interface in production.
- Helpers are fixed when the agent is built, and run in process, one delegation at a time per call.
  A helper that should run elsewhere is an agent on another server, called through
  `createRemoteGraph()`.
- The workspace tools read, write, edit, and list files, and run commands. There is no glob or grep
  tool, so a search is a command the sandbox runs.
