# Agents and tools

<!-- covers: ./agent -->

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
<!-- reference:end -->
