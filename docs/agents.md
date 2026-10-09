# Agents and tools

<!-- covers: ./agent ./agent/middleware ./agent/permissions ./agent/sandbox ./connectors -->
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
run.state.stopReason;  // 'completed' | 'max_iterations' | 'stopped'
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

## Who a tool acts for

An agent passes every tool a `ToolContext` as the second argument of `execute`, with these fields:
- `toolCallId`, the call's id;
- `threadId` and `tenantId`;
- `signal`, the run's signal;
- `store`, which in a tenant's run is the tenant's view of it;
- `principal`, who the run is for: the caller the server authenticated, with their roles and
  scopes.

A tool can therefore act as that user and no one else, stop when the run is cancelled, and remember
things per tenant. Middleware reads the principal as `context.principal`, and a permission policy
as `request.principal`. A tool run outside an agent receives an empty context.

```ts
const myTickets = tool({
  name: 'my_tickets',
  description: "Lists the caller's open tickets",
  parameters: { type: 'object' },
  capabilities: ['network:helpdesk.internal'],
  execute: async (_args, { principal, signal }) =>
    helpdesk.tickets({ assignee: principal?.userId, tenant: principal?.tenantId, signal }),
});
```

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

`AgentMiddleware` wraps the parts of a run worth controlling. It has four hooks, each optional,
applied in order:

| Hook | What it can do |
| --- | --- |
| `beforeModel` | Adjust the request: trim history, add context, change the model or the tools. |
| `wrapModelCall` | Surround the model call itself: retry it, fall back to another model, or end the run without it. |
| `afterModel` | Inspect or replace the response. |
| `wrapToolCall` | Surround each tool call: log, time, retry, refuse, or change its arguments. |

Every hook receives an `AgentMiddlewareContext`: the state at that step, the store, the thread
and tenant, the run's signal, and `interrupt()`, which suspends the run for a person exactly as
`interruptOn` does. `wrapModelCall` receives an `AgentModelCallContext`, which adds `stop()`: it
ends the run with an answer and `stopReason: 'stopped'`, with no model call. `next()` may be called
more than once in either wrapper. When a `wrapToolCall` passes `next()` a call with changed
arguments, the permission policy decides them again before the tool runs. A middleware can
therefore never reach what the policy denies.

```ts
const timing: AgentMiddleware = {
  name: 'timing',
  async wrapModelCall(request, next) {
    const started = performance.now();
    try {
      return await next(request);
    } finally {
      metrics.observe('model_ms', performance.now() - started);
    }
  },
};
```

Three small middleware come with `nexus-ai-pro/agent`:

| Middleware | What it does |
| --- | --- |
| `limitToolCalls()` | Caps how often a tool may be called in one run, so a loop cannot bill forever. Calls are counted from the transcript, so the count survives a restart and two threads never share one. |
| `redactMessages()` | Removes matching text before it reaches a provider or a log. `RedactOptions` sets the patterns, the replacement, and whether responses are redacted too. |
| `summarizeHistory()` | Replaces the older half of a long transcript with a summary, so a long thread fits the context window. `SummarizeOptions` sets how many messages stay verbatim, when summarizing starts, and the `summarize` function. |

`nexus-ai-pro/agent/middleware` has those three and ten more. Each is a separate import, and a
bundler keeps only the ones you use:

| Middleware | What it does |
| --- | --- |
| `modelRetry()` | Tries a failed model call again, with backoff. |
| `modelFallback()` | Tries other models, or other clients, when the model call fails. |
| `dynamicModel()` | Chooses the model for each call from the run so far. |
| `toolRetry()` | Runs a failed tool call again, only when repeating it is safe. |
| `toolSelector()` | Sends the model only the tools relevant to the turn. |
| `contextEditor()` | Clears old tool results from what the model is sent. |
| `piiMiddleware()` | Redacts, masks, hashes, or blocks personal data and secrets. |
| `humanApproval()` | Asks a person before a call that a rule picks. |
| `modelCallLimit()` | Caps the model calls of a run, of a thread, or both. |
| `filesystemContext()` | Puts instruction files in context, and moves large results out of it. |

```ts
import { createAgent } from 'nexus-ai-pro/agent';
import { contextEditor, humanApproval, modelRetry, toolRetry, toolSelector } from 'nexus-ai-pro/agent/middleware';

const agent = createAgent({
  client: ai,
  tools: mcpTools,                       // 150 of them
  checkpointer,
  middleware: [
    modelRetry(),
    toolSelector({ embed, maxTools: 12, always: ['search_docs'] }),
    contextEditor({ triggerTokens: 40_000 }),
    humanApproval({ when: (call) => call.name === 'refund' && Number(call.args.amount) > 100 }),
    toolRetry(),
  ],
});
```

**Retries.** `modelRetry()` retries the agent's step after the client's own retries gave up.
`ModelRetryOptions` sets the attempts, the `RetryBackoff` (an initial wait, a maximum, a factor,
and jitter), `retryOn` for which errors to retry, and `retryResponse` for retrying a response that
arrived but is unusable, such as an empty one. An error marked `retryable: false`, such as a
provider's authentication error, is never retried, and neither is a cancellation. Waits stop when
the run is cancelled. `onRetry` receives a `RetryEvent` before each new attempt.

`toolRetry()` repeats a failed tool call. By default it repeats only a call whose tool declares
capabilities and nothing beyond reading, because retrying a payment or a write that timed out
after it landed would do it twice. `ToolRetryOptions.tools` names the tools that are idempotent, or
says `'all'`, or takes a function of the call. Put `humanApproval()` before `toolRetry()`, so a
retried call is not asked about twice.

**Models.** `modelFallback()` tries each `ModelFallbackTarget` in order when the call fails: a
model name for the agent's own client, or `{ client, model }` for another one. That covers what the
router cannot: a client of a different kind, or a fallback after the client's own routes are used
up. `ModelFallbackOptions` sets which errors fall back, and `onFallback` receives a
`ModelFallbackEvent`. `dynamicModel()` takes a function of a `DynamicModelContext`, the step's
context plus the request about to go out, and returns the model to use. For example, a cheap model
for the first steps and a stronger one once the task proves hard:

```ts
dynamicModel(({ state }) => (state.iterations >= 4 ? 'gpt-5' : 'gpt-5-mini'))
```

**Tool selection.** An agent with 150 tools otherwise sends 150 schemas on every call. Those tokens
are paid every time, the call is slower, and a model choosing among that many picks worse.
`toolSelector()` chooses a dozen, by a rule, by embedding similarity, or by both
(`ToolSelectorOptions`):

- A rule, `select`, receives a `ToolSelectionContext`: the step's context, the request, the
  tools offered, and the query.
- `embed` is any embedding function. Each tool is embedded once, from its name and description;
  the query once per turn.

The tools named in `always`, a tool that `toolChoice` forces, and the tools the model already
called this turn are always kept. The agent can still run every tool; only what the model is
offered changes. `onSelect` receives a `ToolSelection`: the query, the tools sent, how many were
offered, and each tool's similarity score.

In the benchmark in the test suite, `toolSelector()` sends 12 tools instead of 150 over 40 tasks:
- every task still succeeds;
- input tokens per task fall from about 64,000 to about 5,200;
- latency per task falls by about 70%. Latency there is the model's time, computed from
  each request's size as a provider's time to first token grows with it, plus the agent's own time,
  measured, with the selector's work included.

`compareExperiments()` reports the comparison.

**Context.** `contextEditor()` replaces old tool results with a short placeholder once the request
passes `triggerTokens`, keeping the most recent few whole. Results are cleared in batches, so the
edited prefix stays the same between edits and a provider's prompt cache keeps working. Only the
request changes: the transcript in state keeps every result. `ContextEditorOptions` also sets the
batch, the tools never cleared, whether arguments are cleared too, and the placeholder, which a
function can build from a `ClearedToolResult`. `onEdit` receives a `ContextEdit` with the tokens
before and after. `estimateRequestTokens()` is the default estimate, about four characters a
token over messages, tool calls, and tool schemas.

`filesystemContext()` treats the filesystem as context, from a `FilesystemContextSource`: a
`Sandbox`, or anything with its file methods. Through `FilesystemContextOptions`, it does two
things:

- Instruction files such as `AGENTS.md` reach the model on every call, right after the system
  prompt, with an optional listing of a directory. They are read once per run.
- With `offload` (`ContextOffloadOptions`), a tool result larger than the limit is written to a file
  instead. The model reads a preview and a path it can open with `read_file`.

The transcript stays small however much a tool returns, and nothing is lost.

```ts
filesystemContext({ source: sandbox, include: ['AGENTS.md'], listing: {}, offload: { overChars: 20_000 } })
```

**Personal data.** `piiMiddleware()` finds each `PiiKind`:
- emails and phone numbers;
- card numbers, checked with Luhn;
- US social security numbers;
- IBANs, checked with their checksum;
- IP addresses;
- common API keys and private keys;
- any patterns of your own.

The checksums keep false positives low: an order number is not taken for a card. Each match gets a
`PiiStrategy`, for every kind or per kind:
- `redact` replaces it with its kind;
- `mask` keeps its last four characters;
- `hash` gives a stable token, so the model can still tell two values apart;
- `block` refuses the message with a `PiiBlockedError`.

`PiiMiddlewareOptions.apply` chooses where it looks:
- the model's input, which is everything but the system prompt;
- its output;
- tool results, which are cleaned before they enter the transcript, so they are never checkpointed.

`onDetect` receives a `PiiFinding`, which gives the kind and its `PiiWhere` but never the value.

```ts
piiMiddleware({ strategy: { email: 'hash', 'credit-card': 'block' }, apply: { input: true, toolResults: true } })
```

**Approvals and limits.** `humanApproval()` asks before the calls a rule picks: a refund over a
limit, or a write outside a draft folder. `interruptOn` instead asks before every call to a named
tool. By default it asks about every call that declares nothing, or declares more than reading.
`HumanApprovalOptions.approve` asks out of band, by posting to a chat and waiting for the answer,
instead of suspending the run. An approver who corrects the arguments has them decided again by the
permission policy.

`modelCallLimit()` caps model calls per run, per thread across runs, or both
(`ModelCallLimitOptions`):
- The run count is read from the transcript.
- The thread count is kept in the agent's store when it has one, so every process shares it.

At a limit, the run ends with an answer and `stopReason: 'stopped'`. With `onLimit: 'error'`, it
fails with a `ModelCallLimitError` instead. `maxIterations` still stops a single run that keeps
calling tools.

## The deep-agent preset

For long, multi-step work, `createDeepAgent()` on `nexus-ai-pro/deep-agent` is `createAgent()`
with a kit already assembled:
- a plan it keeps current;
- a sandboxed workspace;
- helpers to delegate to;
- skills loaded on demand;
- context offloading and editing;
- a permission policy.

The [deep-agent preset guide](./deep-agents.md) covers it.

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
| `AgentState` | The graph's state: the transcript, the iterations used, the final answer, and an `AgentStopReason`: `completed`, `max_iterations`, or `stopped` when a middleware ended the run. |
| `agentInput()` | Wraps a question into that state. |
| `AgentApprovalPolicy` | Decides which tools pause for a person. |
| `AgentApproval` | A person's answer: allow, refuse with a reason the model sees, or allow with corrected arguments. |
| `AgentToolCall`, `AgentToolResult` | What the model asked for, and what came back. |
| `AgentModelClient` | The one-method client contract the agent needs. |

The simpler loop is `AgentLoop`. It is configured with `AgentConfig` and driven by an
`AgentLoopModelClient`. It returns an `AgentResult`: the answer, the model calls made, and every
`AgentStep` along the way. It has no checkpoints and no approvals, which is the point of it.

## Limitations

- A tool reports nothing while it runs: its result arrives when it returns. A graph node can report
  progress with `context.tool()`, but a `ToolDefinition` cannot.
- Tool selection runs on the application's side. `toolSelector()` narrows the tools before each
  model call, and a provider's own tool search is not used.

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
| `AgentModelClient` | interface | The model call an agent makes. |
| `AgentResult` | interface | The outcome of an `AgentLoop` run. |
| `AgentState` | type | The agent's state. |
| `AgentStep` | interface | One step of an `AgentLoop` run. |
| `AgentStopReason` | type | `completed` when the model answered, `max_iterations` when it ran out of model calls, `stopped` when a middleware ended the run through `context.stop()`. |
| `createAgent` | function | Builds an agent and returns it as a compiled graph. |
| `CreateAgentOptions` | interface | Options for `createAgent()`. |
| `ToolExecutionResult` | interface | What running one tool produced. |

### `nexus-ai-pro/agent/middleware`

| Export | Kind | Summary |
| --- | --- | --- |
| `AgentMiddleware` | interface | Hooks around the agent's model calls and tool calls. |
| `AgentMiddlewareContext` | interface | What every middleware hook can read about the step it runs in. |
| `AgentModelCallContext` | interface | What `wrapModelCall` can read, and how it ends the run without calling the model. |
| `AgentToolCall` | interface | A tool call the agent is about to make. |
| `AgentToolResult` | interface | What a tool call produced. |
| `ClearedToolResult` | interface | One cleared result, for a custom placeholder. |
| `ContextEdit` | interface | What one edit did, for logs and for measuring what it saves. |
| `contextEditor` | function | Clears old tool results from what the model is sent, once the request grows past a threshold. |
| `ContextEditorOptions` | interface | Options for `contextEditor()`. |
| `ContextOffloadOptions` | interface | Where large tool results go instead of the transcript. |
| `dynamicModel` | function | Chooses the model for each call from the run so far. |
| `DynamicModelContext` | type | What `dynamicModel()` decides from: the step's context and the request about to be sent. |
| `estimateRequestTokens` | function | About four characters a token, over the messages, the tool calls, and the tool schemas. |
| `filesystemContext` | function | The filesystem as the agent's context: files in, large results out. |
| `FilesystemContextOptions` | interface | Options for `filesystemContext()`. |
| `FilesystemContextSource` | type | Where `filesystemContext()` reads and writes: a `Sandbox`, or anything with the same file methods. |
| `humanApproval` | function | Asks a person before a tool call runs, decided per call rather than per tool name. |
| `HumanApprovalOptions` | interface | Options for `humanApproval()`. |
| `limitToolCalls` | function | Caps how often a tool may be called in one run: one turn, from a user message to the answer. |
| `modelCallLimit` | function | Caps the model calls of a run, of a thread, or both. |
| `ModelCallLimitError` | class | Thrown by `modelCallLimit()` under `onLimit: 'error'`. |
| `ModelCallLimitOptions` | interface | Options for `modelCallLimit()`. |
| `modelFallback` | function | Tries other models, in order, when the model call fails. |
| `ModelFallbackEvent` | interface | One fallback about to happen. |
| `ModelFallbackOptions` | interface | Options for `modelFallback()`. |
| `ModelFallbackTarget` | type | A model to fall back to: a model name for the agent's own client, or another client. |
| `modelRetry` | function | Tries a failed model call again, with exponential backoff. |
| `ModelRetryOptions` | interface | Options for `modelRetry()`. |
| `PiiBlockedError` | class | Thrown when a match under the `block` strategy is found in the model's input or output. |
| `PiiFinding` | interface | One match, as `onDetect` sees it: never the value itself. |
| `PiiKind` | type | The personal data and secrets `piiMiddleware()` finds on its own. |
| `piiMiddleware` | function | Keeps personal data and secrets away from the model, the transcript, or both. |
| `PiiMiddlewareOptions` | interface | Options for `piiMiddleware()`. |
| `PiiStrategy` | type | What happens to a match: `redact` replaces it with its kind, `mask` keeps its last four characters, `hash` replaces it with a stable token so two values stay distinguishable, and `block` refuses the whole message. |
| `PiiWhere` | type | Where a match was found. |
| `redactMessages` | function | Redacts matching text from requests, and optionally from responses. |
| `RedactOptions` | interface | Options for `redactMiddleware()`. |
| `RetryBackoff` | interface | How long to wait between attempts. |
| `RetryEvent` | interface | One retry about to happen. |
| `summarizeHistory` | function | Replaces the older half of a long transcript with a summary. |
| `SummarizeOptions` | interface | Middleware that ships with the agent. |
| `toolRetry` | function | Runs a failed tool call again, with exponential backoff. |
| `ToolRetryOptions` | interface | Options for `toolRetry()`. |
| `ToolSelection` | interface | What `toolSelector()` sent for one call. |
| `ToolSelectionContext` | interface | What a rule chooses tools from. |
| `toolSelector` | function | Sends a model only the tools relevant to the turn. |
| `ToolSelectorOptions` | interface | Options for `toolSelector()`. |

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
