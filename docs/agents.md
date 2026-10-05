# Agents and tools

<!-- covers: ./agent ./agent/permissions ./agent/sandbox ./connectors -->
<!-- sources: src/agent src/connectors -->

Tool-calling agents, from `nexus-ai-pro/agent`. There are two:

- `createAgent()` builds an agent on the graph runtime. It has checkpoints, approvals for sensitive
  tools, and middleware around model and tool calls.
- `AgentLoop` is the minimal loop, for when none of that is needed.

## A first tool

A tool is a name, a description, a JSON Schema for its arguments, and a function:

```ts
import { NexusAI, tool } from 'nexus-ai-pro';

const getCurrentTime = tool({
  name: 'get_current_time',
  description: 'Get the current ISO timestamp.',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ now: new Date().toISOString() }),
});

const result = await ai.agent({
  model: 'auto',
  goal: 'What time is it now?',
  tools: [getCurrentTime],
  maxIterations: 5,
});
```

## Tools that return images and files

A tool's result usually goes back to the model as JSON. A tool that made an image, or found a file,
should not send it that way: base64 text costs tokens and the model cannot see it. Return a
`toolOutput()` instead. Its parts are sent as the tool message itself.

```ts
import { tool, toolOutput } from 'nexus-ai-pro';

const renderChart = tool({
  name: 'render_chart',
  description: 'Renders a sales chart and stores it.',
  parameters: { type: 'object', properties: { year: { type: 'number' } } },
  execute: async ({ year }) => {
    const chart = await render(year);
    const stored = await assets.put(chart.bytes, { mimeType: 'image/png' });
    return toolOutput(
      `Rendered the ${year} chart.`,
      { type: 'asset', asset: stored },                     // named by reference
      { type: 'image', source: { asset: { location: { kind: 'bytes', data: chart.bytes }, mimeType: 'image/png' } } }, // shown
    );
  },
});
```

| Part | What the model receives |
| --- | --- |
| A string, or a text part | The text. |
| `{ type: 'asset', asset }` | One reference line: the asset's id, where it lives, and its type. Never its bytes. |
| `{ type: 'image', source }` | The image itself, for a model that reads images. |

Each adapter sends these the way its API expects. Anthropic and Google take images inside the tool
result. The OpenAI chat API takes only text in a tool message, so the images follow the results in one
user message. `isToolOutput()` tells a `toolOutput()` from any other result, and
`toolMessageContent()` turns a `ToolExecutionResult` into the content the model reads. Both are for a
loop of your own.

## Agents

An agent is a graph. So it gets what a graph has: checkpoints, human approval, parallel work, forks,
events, and a diagram.

```ts
import { createAgent, agentInput, tool } from 'nexus-ai-pro/agent';

const agent = createAgent({
  client: ai,                        // anything with complete(); NexusAI qualifies
  systemPrompt: 'You are a support engineer.',
  tools: [refundTool, emailTool],
  interruptOn: { send_email: true }, // this one waits for a human
  store,                             // long-term memory
  checkpointer,                      // survives a restart
});

const run = await agent.invoke(agentInput('Refund order 1182 and tell the customer'), { threadId });
run.state.answer;      // the final text
run.state.stopReason;  // 'completed' | 'max_iterations'
```

**Tool calls run in parallel.** Each call the model asks for becomes its own task, up to
`toolConcurrency` at once. So three lookups take as long as the slowest one.

**Approval is an interrupt, not a callback.** A tool listed in `interruptOn` pauses the run and saves
a checkpoint. The answer approves, refuses with a reason the model sees, or approves with corrected
arguments:

```ts
if (run.status === 'awaiting_input') {
  await agent.resumeWith(threadId, { approved: true, args: { to: 'billing@example.com' } });
}
```

Because it is a checkpoint, the approval can arrive days later, from another process.

**Its output streams as it is written.** An agent reports what its model says and every tool it
calls on the graph's event stream, with nothing to wire in its nodes. With `streamTokens: true` and a
client that has `stream()`, as `AgentModelClient` allows, the answer arrives token by token; without
it, each answer arrives as one message once the model returns. Middleware sees the assembled response
either way.

```ts
const agent = createAgent({ client: ai, tools, streamTokens: true });
const run = agent.events(agentInput('Refund order 1182'), { threadId });

const tokens = run.messages();
const calls = run.tools();
// Read both; each has its own buffer. See "Streaming events" in the graph guide.
```

**An agent is an operation of its client.** Pass `lifecycle: ai.lifecycle`, and every run is
authorized, counted, and audited as an `agent` operation, alongside the model calls it makes.
`ai.agent()` runs as one already. The [lifecycle guide](./lifecycle.md) explains what that shares.

## What a tool may do

Approval by tool name does not scale: a tool that runs commands is harmless running `git status`
and dangerous running `rm -rf`. So a tool declares what each call does, as capabilities, and a
permission policy decides every call from them, before it runs.

**Capabilities.** `ToolDefinition.capabilities` is a list, or a function of the call's arguments so
the policy sees the path, host, or command the call actually uses:

| Capability | Means |
| --- | --- |
| `filesystem:read`, `filesystem:read:<path>` | Reads files, or one path |
| `filesystem:write`, `filesystem:write:<path>` | Writes, creates, or deletes files |
| `network`, `network:<host or URL>` | Opens a network connection |
| `shell`, `shell:<command line>` | Runs a shell command |
| `code` | Runs code it was given |
| `<name>`, `<name>:<detail>` | An effect of your own, such as `payments:refund` |

`capabilities: []` says a tool changes nothing; a tool with no list is undeclared. From
`nexus-ai-pro/agent/permissions`, `parseCapability()` splits one into a `ParsedCapability` (kind,
access, target), `capabilitiesOf()` resolves a tool's list for one call (`undefined` when
undeclared, or when its function throws), and `isSensitiveCapability()` says whether one does
anything but read.

```ts
const fetchUrl = tool({
  name: 'fetch_url',
  description: 'Fetches a web page',
  parameters: { type: 'object', properties: { url: { type: 'string' } } },
  capabilities: (args) => [`network:${args.url}`],
  execute: ({ url }) => fetch(String(url)).then((response) => response.text()),
});
```

**A permission policy.** `permissionPolicy()` builds a `PermissionPolicy` from `PermissionRules`:

| Rule | Grants |
| --- | --- |
| `filesystem` | `read` and `write` globs: `/workspace/**` is the workspace and everything in it. A write grant also allows reading. |
| `network` | `allow` hosts: `api.github.com`, `*.openai.com` for its subdomains, `*` for any. |
| `shell` | `allow` command prefixes: `git` allows every git command, `npm test` only that. A command line that chains, pipes, redirects, or substitutes is never granted by a prefix. |
| `code` | A decision for running code: `deny` by default. |
| `custom` | Decisions for your own capabilities, by kind or in full: `{ payments: 'ask', 'payments:refund': 'deny' }`. |
| `ask` | Patterns that need approval even when granted: `shell`, `filesystem:write`, `network:*.stripe.com`. |
| `undeclared`, `ungranted` | What happens to a tool with no capabilities, and to a capability no grant covers: `deny` by default. |
| `tools` | A decision per tool name, applied first. |
| `root` | What relative paths resolve against. |

Paths are normalized before any grant sees them — `normalizePath()` resolves `.` and `..` and
backslashes — so `/workspace/output/../../etc/passwd` is judged as `/etc/passwd`.

```ts
import { permissionPolicy } from 'nexus-ai-pro/agent/permissions';

const agent = createAgent({
  client: ai,
  tools,
  checkpointer,
  permissions: permissionPolicy({
    filesystem: { read: ['/workspace/**'], write: ['/workspace/output/**'] },
    network: { allow: ['api.github.com'] },
    shell: { allow: ['git', 'npm test'] },
    ask: ['shell'],
  }),
});
```

`decide()` takes a `PermissionRequest` — the tool, its arguments, its capabilities — and returns a
`PermissionVerdict`: a `PermissionDecision` of `allow`, `ask`, or `deny`, and a reason. A call is
denied when any capability is, asked about when any needs approval, and allowed only when every
one is granted. In `createAgent({ permissions })`, which takes any `PermissionPolicyLike`, a denied
call never runs and the model reads `Permission denied: <reason>`; an `ask` interrupts exactly as
`interruptOn` does, with the call's `capabilities` and the policy's reason on the `AgentToolCall`
it asks about. Arguments an approver corrects are decided again, so an edit cannot reach what the
policy denies.

**A sandbox.** Commands and code belong in a sandbox the application provides — a container, a VM,
a remote interpreter — through the `Sandbox` interface on `nexus-ai-pro/agent/sandbox`: `exec()`
with `SandboxExecOptions` (a working directory, variables, standard input, a timeout, a signal),
returning a `SandboxExecResult`; file reads and writes; and its `SandboxIsolation`, what it claims
to isolate. `sandboxTools()` turns a sandbox into `run_command`, `read_file`, `write_file`, and
`list_files`, each declaring exactly what one call does, with files under the `mount` a policy sees
(`/workspace` by default); `SandboxToolsOptions` chooses them.

`runSandboxConformance()` checks any sandbox against the contract, with no test framework, and
returns a `SandboxConformanceReport` of `SandboxConformanceCheck`s: output, errors, and exit codes;
standard input and variables, with none of the host's; a timeout that stops the command; files that
round-trip where commands run; and paths outside the sandbox refused, as `SandboxPathError`.
`SandboxConformanceOptions` names the JavaScript command and the timeout it tests.

`processSandbox()` is a reference for development: commands run as ordinary processes in a
directory, with only `PATH` and the variables given, and its file methods refuse any path outside
`root` (`ProcessSandboxOptions`). A command it runs can still touch anything you can, and its
`isolation` says so. It is never a security boundary.

```ts
import { processSandbox, runSandboxConformance, sandboxTools } from 'nexus-ai-pro/agent/sandbox';

const sandbox = processSandbox({ root: './.agent-workspace' });   // development only
const report = await runSandboxConformance(() => mySandbox());    // prove your own
const agent = createAgent({ client: ai, tools: sandboxTools(sandbox), permissions, checkpointer });
```

## Middleware

`AgentMiddleware` wraps the parts of a run worth controlling. It has three hooks, each optional,
applied in order:

| Hook | What it can do |
| --- | --- |
| `beforeModel` | Adjust the request. |
| `afterModel` | Inspect or replace the response. |
| `wrapToolCall` | Surround each tool call, for logging, timing, or policy. |

Three middleware ship. Each is ordinary middleware you can read and copy:

| Middleware | What it does |
| --- | --- |
| `limitToolCalls()` | Caps how often a tool may be called in one run, so a loop cannot bill forever. |
| `redactMessages()` | Removes matching text before it reaches a provider or a log. `RedactOptions` sets the patterns, the replacement, and whether responses are redacted too. |
| `summarizeHistory()` | Replaces the older half of a long transcript with a summary, so a long thread fits the context window. `SummarizeOptions` sets how many messages stay verbatim, when summarizing starts, and the `summarize` function. |

```ts
import { createAgent, limitToolCalls, redactMessages, summarizeHistory } from 'nexus-ai-pro/agent';

const agent = createAgent({
  client: ai,
  tools: [refundTool, searchTool],
  middleware: [
    redactMessages({ patterns: [/\bsk-[A-Za-z0-9]{20,}\b/g], redactOutput: true }),
    limitToolCalls({ refund: 1 }),
    summarizeHistory({ keepLast: 10, summarize: async (messages) => (await ai.complete(summaryRequest(messages))).content }),
  ],
});
```

## An agent as a tool

`agentAsTool()` turns an agent into a `ToolDefinition`, so one agent can call another. A supervisor
hands a question to a specialist and gets the answer back as a tool result. Neither knows the other's
tools or state.

```ts
const researcher = createAgent({ client: ai, tools: [searchTool], name: 'researcher' });
const supervisor = createAgent({
  client: ai,
  tools: [agentAsTool({ agent: researcher, name: 'research', description: 'Researches a question' })],
});
```

## Running tools yourself

`ToolExecutor` runs tool calls by name, outside an agent: in a custom loop, or in a server route that
runs what a model asked for. A failure comes back as a `ToolExecutionResult` with `ok: false`, not a
thrown error, so one bad call does not end a run. An unknown tool name is reported the same way.

## Tools that reach the web

`nexus-ai-pro/connectors` ships two tools, built on `tool()`:

- `createFetchUrlTool()` reads text from a URL. It refuses private and link-local addresses, follows
  a bounded number of redirects, truncates a long response, and times out. `WebConnectorOptions` sets
  those limits and the SSRF policy, including a resolver that answers each host name with its
  `WebResolvedAddress` values.
- `createSearchTool()` wraps a search function you supply, so the search provider stays yours.

## The pieces, by name

| Name | What it is |
| --- | --- |
| `CreateAgentOptions` | What `createAgent()` takes. |
| `AgentGraph` | What it returns: a compiled graph over `AgentChannels`. |
| `AgentState` | The graph's state: the transcript, the iterations used, the final answer, and an `AgentStopReason`. |
| `agentInput()` | Wraps a question into that state. |
| `AgentApprovalPolicy` | Decides which tools pause for a person. |
| `AgentApproval` | A person's answer: allow, refuse with a reason the model sees, or allow with corrected arguments. |
| `AgentToolCall`, `AgentToolResult` | What the model asked for, and what came back. |
| `AgentModelClient` | The one-method client contract the agent needs. |

The simpler loop is `AgentLoop`. It is configured with `AgentConfig` and driven by an
`AgentLoopModelClient`. It returns an `AgentResult`: the answer, the model calls made, and every
`AgentStep` along the way. It has no checkpoints and no approvals, which is the point of it.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/agent`

| Export | Kind | Summary |
| --- | --- | --- |
| `AgentApproval` | type | What an approver may answer: allow, refuse with a reason, or allow with corrected arguments. |
| `AgentApprovalPolicy` | interface | How a call to a tool that needs approval is presented to the operator. |
| `agentAsTool` | function | Turns an agent into a tool another agent can call. |
| `AgentChannels` | type | The agent's state channels, as a graph schema. |
| `AgentConfig` | interface | Configuration for `AgentLoop`, the simple tool-calling loop. |
| `AgentGraph` | type | An agent: a compiled graph over the agent's channels. |
| `agentInput` | function | Wraps a question into the state an agent starts from. |
| `AgentLoop` | class | A simple tool-calling loop: calls the model, runs the tools it asks for, and repeats until it answers or runs out of iterations. |
| `AgentLoopModelClient` | interface | The part of a client the agent loop needs. |
| `AgentMiddleware` | interface | Hooks around the agent's model calls and tool calls. |
| `AgentModelClient` | interface | The model call an agent makes. |
| `AgentResult` | interface | The outcome of an `AgentLoop` run. |
| `AgentState` | type | The agent's state. |
| `AgentStep` | interface | One step of an `AgentLoop` run. |
| `AgentStopReason` | type | `completed` when the model answered, `max_iterations` when it ran out of model calls. |
| `AgentToolCall` | interface | A tool call the agent is about to make. |
| `AgentToolResult` | interface | What a tool call produced. |
| `createAgent` | function | Builds an agent and returns it as a compiled graph. |
| `CreateAgentOptions` | interface | Options for `createAgent()`. |
| `isToolOutput` | function | True for a result built with `toolOutput()`. |
| `limitToolCalls` | function | Caps how often a tool may be called in one run. |
| `redactMessages` | function | Redacts matching text from requests, and optionally from responses. |
| `RedactOptions` | interface | Options for `redactMiddleware()`. |
| `summarizeHistory` | function | Replaces the older half of a long transcript with a summary. |
| `SummarizeOptions` | interface | Middleware that ships with the agent. |
| `tool` | function | Defines a tool the model can call, typing its arguments. |
| `ToolExecutionResult` | interface | What running one tool produced. |
| `ToolExecutor` | class | Runs tool calls by name, reporting failures as results rather than throwing. |
| `toolMessageContent` | function | What the model reads for a tool's result: the parts of a `toolOutput()`, or anything else as JSON. |
| `toolOutput` | function | Builds a tool's result as content: text, images, and asset references, in order. |

### `nexus-ai-pro/agent/permissions`

| Export | Kind | Summary |
| --- | --- | --- |
| `capabilitiesOf` | function | The capabilities one call of a tool declares: its static list, or what its function computes from the call's arguments. |
| `isSensitiveCapability` | function | Whether a capability is sensitive: anything but reading files. |
| `normalizePath` | function | A path made absolute and normalized, with `.` and `..` resolved, so `/workspace/../etc` is `/etc` before any grant sees it. |
| `parseCapability` | function | Splits a capability string into its kind, access, and target. |
| `ParsedCapability` | interface | One capability, split into its parts. |
| `PermissionDecision` | type | What a policy decides for one call: run it, refuse it, or interrupt for a person's approval. |
| `permissionPolicy` | function | Builds a policy from what it grants. |
| `PermissionPolicy` | class | A policy built from `PermissionRules`. |
| `PermissionPolicyLike` | interface | Anything that decides tool calls. |
| `PermissionRequest` | interface | One tool call, as a policy sees it. |
| `PermissionRules` | interface | What a policy grants. |
| `PermissionVerdict` | interface | A policy's decision, with the reason a person or a model reads. |

### `nexus-ai-pro/agent/sandbox`

| Export | Kind | Summary |
| --- | --- | --- |
| `processSandbox` | function | A sandbox that runs commands as ordinary processes in a directory, for development and tests only. |
| `ProcessSandboxOptions` | interface | Options for `processSandbox()`. |
| `runSandboxConformance` | function | Checks a sandbox against the contract, without a test framework, so any sandbox — a container runner, a VM, a hosted service — can prove itself the same way: |
| `Sandbox` | interface | Where an agent's commands, code, and files go. |
| `SandboxConformanceCheck` | interface | One conformance check's result. |
| `SandboxConformanceOptions` | interface | Options for `runSandboxConformance()`. |
| `SandboxConformanceReport` | interface | What `runSandboxConformance()` found. |
| `SandboxExecOptions` | interface | Options for one command. |
| `SandboxExecResult` | interface | What a command did. |
| `SandboxIsolation` | interface | What a sandbox claims to isolate. |
| `SandboxPathError` | class | Raised when a path would leave the sandbox. |
| `sandboxTools` | function | Tools that act through a sandbox, each declaring exactly what one call does: `run_command` declares `shell:<the command>`, and the file tools declare `filesystem:read` or `filesystem:write` with the path under `mount`. |
| `SandboxToolsOptions` | interface | Options for `sandboxTools()`. |

### `nexus-ai-pro/connectors`

| Export | Kind | Summary |
| --- | --- | --- |
| `createFetchUrlTool` | function | A `fetch_url` tool that reads text from public URLs allowed by the policy, refusing private addresses. |
| `createSearchTool` | function | A search tool around your own search function. |
| `WebConnectorOptions` | interface | Options for the fetch-URL tool, including its SSRF policy. |
| `WebResolvedAddress` | type | An address a host name resolved to: the address alone, or with its IP family. |
<!-- reference:end -->
