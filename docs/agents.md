# Agents and tools

<!-- covers: ./agent -->
<!-- sources: src/agent src/connectors -->

Tool-calling agents from `nexus-ai-pro/agent`. `createAgent()` builds an agent on the graph runtime, with checkpoints, approvals for sensitive tools, and middleware around model and tool calls; `AgentLoop` is the minimal loop for when none of that is needed.

## Tools and Agents

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

## Agents

An agent is a graph, so everything above applies to it: checkpoints, human approval, parallel work,
forks, events, and a diagram.

```ts
import { createAgent, agentInput, tool } from 'nexus-ai-pro/agent';

const agent = createAgent({
  client: ai,                      // anything with complete(); NexusAI qualifies
  systemPrompt: 'You are a support engineer.',
  tools: [refundTool, emailTool],
  interruptOn: { send_email: true }, // this one waits for a human
  store,                             // long-term memory, below
  checkpointer,                      // survives a restart
});

const run = await agent.invoke(agentInput('Refund order 1182 and tell the customer'), { threadId });
run.state.answer;      // the final text
run.state.stopReason;  // 'completed' | 'max_iterations'
```

**Tool calls run in parallel.** Each call the model requests becomes its own task, bounded by
`toolConcurrency`, so three lookups take as long as the slowest one.

**Approval is an interrupt, not a callback.** A tool listed in `interruptOn` pauses the run and
checkpoints it. The answer can approve, refuse with a reason the model sees, or approve with
corrected arguments:

```ts
if (run.status === 'awaiting_input') {
  await agent.resumeWith(threadId, { approved: true, args: { to: 'billing@example.com' } });
}
```

Because it is a checkpoint, the approval can arrive days later, from another process.

**Middleware** wraps the parts worth controlling: `beforeModel` adjusts the request, `afterModel`
inspects or replaces the response, and `wrapToolCall` surrounds each tool call for logging, timing,
or policy. `AgentLoop` remains for the simple case that needs none of this.

## Middleware that ships

`AgentMiddleware` is the hook contract — `beforeModel`, `afterModel`, and `wrapToolCall`, each
optional, applied in order. Three implementations ship, and each is an ordinary middleware you can
read and copy:

| Middleware | What it does |
| --- | --- |
| `limitToolCalls()` | Caps how often a tool may be called in one run, so a loop cannot bill forever |
| `redactMessages()` | Removes matching text from requests, and optionally from responses, before it reaches a provider or a log. `RedactOptions` sets the patterns, the replacement, and whether output is redacted too |
| `summarizeHistory()` | Replaces the older half of a long transcript with a summary, so a long thread stays inside the context window. `SummarizeOptions` sets how many messages are kept verbatim, when summarizing starts, and the `summarize` function that writes it |

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

`agentAsTool()` turns an agent into a `ToolDefinition`, so one agent can call another: a supervisor
hands a question to a specialist and gets its answer back as a tool result, without either knowing
about the other's tools or state.

```ts
const researcher = createAgent({ client: ai, tools: [searchTool], name: 'researcher' });
const supervisor = createAgent({
  client: ai,
  tools: [agentAsTool({ agent: researcher, name: 'research', description: 'Researches a question' })],
});
```

## Running tools yourself

`ToolExecutor` runs tool calls by name outside an agent — in a custom loop, or in a server route that
executes what a model asked for. It reports a failure as a `ToolExecutionResult` with `ok: false`
rather than throwing, so one bad call does not end a run, and an unknown tool name is reported the
same way.

## Tools that reach the web

`nexus-ai-pro/connectors` ships two tools built on `tool()`:

- `createFetchUrlTool()` reads text from a URL, refusing private and link-local addresses, following
  a bounded number of redirects, truncating a long response, and timing out. `WebConnectorOptions`
  carries those limits along with the SSRF policy.
- `createSearchTool()` wraps a search function you supply, so the search provider stays yours.

## The pieces, by name

`createAgent()` takes `CreateAgentOptions` and returns an `AgentGraph`: a compiled graph over
`AgentChannels`, whose state is `AgentState` — the transcript, the iterations used, the final
answer, and an `AgentStopReason`. `agentInput()` wraps a question into that state.
`AgentApprovalPolicy` decides which tools pause, and the answer a human gives is an
`AgentApproval`: allow, refuse with a reason the model sees, or allow with corrected arguments.
Around each call, `AgentToolCall` is what the model asked for and `AgentToolResult` what came back,
while `AgentModelClient` is the one-method client contract the agent needs.

The simpler loop is `AgentLoop`, configured with `AgentConfig` and driven by an
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
| `limitToolCalls` | function | Caps how often a tool may be called in one run. |
| `redactMessages` | function | Redacts matching text from requests, and optionally from responses. |
| `RedactOptions` | interface | Options for `redactMiddleware()`. |
| `summarizeHistory` | function | Replaces the older half of a long transcript with a summary. |
| `SummarizeOptions` | interface | Middleware that ships with the agent. |
| `tool` | function | Defines a tool the model can call, typing its arguments. |
| `ToolExecutionResult` | interface | What running one tool produced. |
| `ToolExecutor` | class | Runs tool calls by name, reporting failures as results rather than throwing. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `AgentModelClient` | interface | The part of a client the agent loop needs. |
| `createFetchUrlTool` | function | A `fetch_url` tool that reads text from public URLs allowed by the policy, refusing private addresses. |
| `createSearchTool` | function | A search tool around your own search function. |
| `WebConnectorOptions` | interface | Options for the fetch-URL tool, including its SSRF policy. |
<!-- reference:end -->
