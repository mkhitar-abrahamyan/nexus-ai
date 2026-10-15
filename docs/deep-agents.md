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
  sandbox: processSandbox({ root: './checkout' }),   // development only; containerSandbox() in production
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
| A workspace | `read_file`, `write_file`, `list_files`, and `edit_file` in the sandbox, mounted at `/workspace`; `glob_files`, `grep_files`, and `read_media` where the sandbox can search and read bytes; and `run_command` when `commands` names any. | `sandboxTools()` |
| Helpers | `delegate`: hands a task to a `DeepSubagent`, which runs to an answer in a fresh context, with the tools it was given, for the same principal. | `createAgent()` per helper |
| Skills | `load_skill`: only each `DeepSkill`'s name and description sit in the prompt until the agent loads one, from its `instructions` or a `file` in the sandbox. | A tool |
| Instruction files | `AGENTS.md`, or the files `include` names, on every call, after the system prompt. | `filesystemContext()` |
| Offloading | A tool result over 20,000 characters is written to `.context/` and left as a preview and a path. | `filesystemContext()` |
| Context editing | Old tool results are cleared from what the model is sent past 60,000 estimated tokens. | `contextEditor()` |
| Tool selection | With `toolSelection`, only the relevant tools are sent; the deep agent's own are always kept. | `toolSelector()` |
| Code | With `interpreter`, `run_code`: the model's code calls the agent's own tools in one step, each call decided by the policy. A tool that needs approval is not callable from code. | `codeTool()` |
| Permissions | A policy that grants the workspace, the `commands`, the agent's own tools, and code when it has an interpreter, and denies everything else. | `permissionPolicy()` |

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
result. It cannot delegate in turn. Because it cannot pause, it never gets a tool named in
`interruptOn`: work that needs a person's approval stays with the main agent, which can pause.

**In the background.** With `background`, `delegate` returns a task id at once and the agent goes
on working; `collect_helper` returns the helper's answer when the agent needs it, waiting up to
`wait_seconds`, and lists the tasks when called without one. At most `maxBackgroundHelpers`, four
by default, work at once in one thread. A helper the agent waits for keeps no checkpoints. One in
the background keeps them in the deep agent's checkpointer, on a thread named after the call that
started it, and `delegate` returns only once its first checkpoint is written. So a crash leaves the
helper's finished steps behind it:
- collecting the task in a new process carries the helper on from its last checkpoint;
- a `delegate` call the agent repeats after the crash finds the same thread, and carries that on
  instead of starting the helper again.

Without a checkpointer, a background helper lives only as long as its process.

**Helpers it creates.** With `createHelpers`, the agent can create a helper for work no declared
helper fits: it gives `delegate` a new name and the helper's instructions. `DeepHelperLimits` bound
what it creates: the tools a created helper may use, its model, its model calls (10 by default), and
how many the agent may create in one thread (5 by default). With a checkpointer, each helper the
agent creates is recorded, with its instructions, on a thread beside the agent's own,
`<thread>/helpers-created`, before the call that created it returns. An agent resumed in another
process counts those helpers against the limit and delegates to them again by name.

**Its events.** Streamed with `subgraphs: true`, a helper's model output, tool calls, and steps reach
the agent's own event stream under the helper's namespace, such as `tools/researcher@call-7`, in the
background as in the foreground. A tool of your own that starts a run of its own can do the same
through `ToolContext.forward`.

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

Helpers have proofs of their own:
- A background researcher answers only after the agent has written a note, and the agent collects
  the answer; the researcher's tool calls reach the agent's stream under its namespace.
- The agent creates a helper on instructions it wrote, which gets only the tools the limits allow; a
  second one past `max` is refused, also after the agent is killed and resumed in another process,
  where it still delegates to the helper it created by name.
- A crash while the agent waits for its helper, and a crash before the agent has saved the call that
  started it, both end with one lookup, one note, and one start of the helper.

## Limitations

- The reference sandbox, `processSandbox()`, is for development. It is never a security boundary.
  Use `containerSandbox()`, from `nexus-ai-pro/agent/sandbox/container`, or a VM of your own behind
  the `Sandbox` interface, in production.
- Helpers run in the agent's process. A helper that should run elsewhere is an agent on another
  server, called through `createRemoteGraph()`.
- Workspace search is bounded: `glob_files` lists at most 500 paths and `grep_files` 200 lines.
  The reference sandbox skips files over 1 MB, binary files, `.git`, and `node_modules`. A wider
  search is a command the sandbox runs.
- `read_media` sends a file of at most 10 MB, as the model's provider accepts it: a PDF reaches
  Anthropic, OpenAI, and Google; audio reaches Google and OpenAI's audio models, and any other model
  is told the audio is there.
