# Agent protocols

<!-- covers: ./protocols/ag-ui ./protocols/a2a ./protocols/acp -->

Three open protocols put an agent where other software already expects one:
- **AG-UI** connects an agent to a user interface. Any AG-UI frontend renders the run as it happens:
  text as it streams, each step, each tool call with its result, and questions for the person.
- **A2A**, the Agent2Agent protocol, connects agents to each other. Other agents discover yours from
  its card and send it tasks. Yours calls theirs as a tool.
- **ACP**, the Agent Client Protocol, puts an agent inside a code editor. The editor starts it as a
  subprocess and shows its edits, its plan, and its requests for approval.

Each protocol has its own entry point, and none needs a dependency. An entry point never imports
the graph runtime: it drives a `ProtocolGraph`, the part of a compiled graph a protocol needs.
- `invoke()` starts a run.
- `resumeInterruptsWith()` answers a paused run's questions by id.

An agent from `createAgent()` or `createDeepAgent()` already satisfies it, and so does any compiled
graph. The protocol passes `ProtocolRunOptions`:
- the thread;
- a signal that cancels the run;
- an `onEvent` callback for the run's fine-grained events, which the protocol translates as they
  arrive;
- the `principal`, when the transport authenticated the caller.

A run ends with a `ProtocolResult`: its status, its state, and any `ProtocolInterrupt` it is
waiting on. Each interrupt carries an id, the question, and a payload. An agent's tool approval
carries the call as its payload, and every protocol below shows that call as an approval rather than
as a general question.

## AG-UI: an agent in a user interface

`agUiHandler()` serves a graph to AG-UI frontends. It takes a `Request` and returns a `Response`,
so it mounts in any framework that uses them:

```ts
import { createAgent } from 'nexus-ai-pro/agent';
import { agUiHandler } from 'nexus-ai-pro/protocols/ag-ui';

const agent = createAgent({ client: ai, tools, streamTokens: true, interruptOn: { send_email: true } });

// A Next.js route handler: app/api/agent/route.ts
export const POST = agUiHandler(agent);
```

The frontend POSTs an `AgUiRunInput`, AG-UI's `RunAgentInput`, with:
- the thread and run ids;
- the whole conversation as `AgUiMessage` values;
- any tools and context the frontend offers;
- its shared state;
- whatever it forwards.

`agUiMessages()` converts the conversation into the messages an agent takes. A developer message
becomes a system message, and an assistant's tool calls and the tool results that answer them are
kept. The default graph input is `{ messages }`. `AgUiOptions.input` builds another input from the
run and the converted messages, for a graph with other state or an application that uses the
frontend's tools.

The response is a stream of Server-Sent Events, each an `AgUiEvent` that `encodeAgUiEvent()`
writes as one `data:` frame:
- `RUN_STARTED` first;
- `STEP_STARTED` and `STEP_FINISHED` around each node the graph runs;
- `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` with each streamed piece, and `TEXT_MESSAGE_END`;
- `TOOL_CALL_START`, `TOOL_CALL_ARGS`, and `TOOL_CALL_END` for each call, then `TOOL_CALL_RESULT`;
- `STATE_SNAPSHOT` with the final state, unless `stateSnapshot` is false;
- last, `RUN_FINISHED` with the answer as its `result`, or `RUN_ERROR` with the failure's message
  and code.

A subgraph's events belong to the parent's step, so only the graph's own nodes are reported as
steps. Reasoning is not sent as message text.

### Questions and approvals

A run that pauses ends with `RUN_FINISHED` and an interrupt outcome. Each question is an
`AgUiInterrupt`:
- its id;
- a reason: `tool_call` for an approval, or `input_required` for anything else;
- the question as `message`;
- for an approval, the `toolCallId`;
- the whole payload in its `metadata`.

The frontend answers with a new run on the same thread. It carries one `AgUiResumeEntry` per
question:
- `resolved`, with a payload;
- or `cancelled`.

By default:
- a resolved entry with a payload answers with that payload;
- a resolved entry without one answers `true`, which approves a call;
- a cancelled entry answers `false`, which refuses it.

`AgUiOptions.answer` maps entries another way. Pass `{ approved: true, args }` as the payload to
approve with corrected arguments.

### Callers and other transports

`AgUiOptions.principal` resolves the caller from each request, such as from a session cookie or a
bearer token. The run then carries that `principal`, so tools act for that user and a permission
policy decides by their roles. The request's signal cancels the run when the frontend disconnects.

`agUiEvents()` is the same translation without HTTP: an async generator of events for a WebSocket,
a queue, or a test. It takes `AgUiEventsOptions`, which is `AgUiOptions` with the caller already
known and a signal.

## A2A: agents calling agents

`a2aHandler()` serves a graph as an A2A agent, speaking version `A2A_PROTOCOL_VERSION` (1.0) over
JSON-RPC:

```ts
import { a2aHandler } from 'nexus-ai-pro/protocols/a2a';

const handler = a2aHandler(researcher, {
  card: {
    name: 'Researcher',
    description: 'Answers research questions with sources',
    version: '1.0.0',
    url: 'https://agents.example.com/a2a',
    skills: [{ id: 'research', name: 'Research', description: 'Finds and cites sources', tags: ['research'] }],
  },
  principal: (request) => verifyAgentToken(request.headers.get('authorization')),
});
```

A `GET` returns the `A2aAgentCard` at `/.well-known/agent-card.json`. `A2aServerOptions.card` gives
the name, description, version, provider, and each `A2aSkill`. The handler fills in the rest:
- the JSON-RPC interface at the card's `url`;
- the capabilities: streaming, and no push notifications;
- the input and output media types, unless given.

A `POST` is a JSON-RPC call:
- `SendMessage` starts a task from an `A2aMessage` and returns the `A2aTask` when it is done.
  With `returnImmediately`, it returns the task while it runs.
- `SendStreamingMessage` streams `A2aStreamEvent` values: the task, then the answer as artifact
  updates while it streams, then the final status.
- `GetTask` reads a task, with as much of its history as `historyLength` asks for.
- `CancelTask` stops a task that is still running.

A message is made of `A2aPart` values: text, data, or a file by URL or bytes. Who sent it is an
`A2aRole`. A task moves through the `A2aTaskState` values. A finished task carries its answer as an
`A2aArtifact` and as the status message.

### Conversations and questions

A message's `contextId` is the conversation. Each task in a context sees the context so far: the
agent's transcript, tool calls included. `A2aServerOptions.input` builds another graph input from
the message and that history.

A task that pauses is `TASK_STATE_INPUT_REQUIRED`. Its status message asks the question in text and
lists the interrupts as data. The calling agent answers with a message that names the task's
`taskId`, and the task continues. By default:
- the message's first data part is the answer, such as `{ approved: true }` for a tool approval;
- otherwise, its text is the answer;
- text that answers an approval is read as words: yes, ok, allow, approve, or confirm allows, and
  anything else refuses, so "no" never reads as consent.

`A2aServerOptions.answer` maps messages another way.

Errors use A2A's codes, listed in `A2A_ERRORS`, beside JSON-RPC's own:
- a task that does not exist;
- a task that cannot be cancelled because it finished;
- a message to a task that is not waiting for input;
- an `A2A-Version` header this agent does not speak.

`A2aServerOptions.principal` authenticates the calling agent, and its tasks run as that principal.
`maxTasks` bounds the tasks and contexts kept in memory.

### Calling other agents

`a2aClient()` talks to any A2A agent. `A2aClientOptions` takes the agent's card URL, or its
endpoint, whose origin serves the card. Pass `fetch` and `headers` for authentication or a proxy.
An `A2aClient` can:
- read the `card()`;
- `send()` a message and wait for its task;
- `stream()` a task's events;
- read a task with `getTask()`;
- `cancel()` one.

`A2aSendOptions` continues a conversation by `contextId`, answers a task by `taskId`, sends data
beside the text, or cancels by signal. A JSON-RPC error raises an `A2aError` with its code.

`a2aTool()` makes a remote agent one more tool. `A2aToolOptions` gives the tool's name and a
description written for the model. Each call is a task, and the result reports:
- its state;
- its task and context ids;
- the remote agent's answer, or its question.

The model can answer a question by calling again with the `taskId`, and continue a conversation by
`contextId`. The tool declares the host it reaches as `network:<host>`. A permission policy grants
or denies it like any other network access.

```ts
import { a2aTool } from 'nexus-ai-pro/protocols/a2a';

const research = a2aTool({
  name: 'ask_researcher',
  description: 'Asks the research agent a question; it answers with sources.',
  url: 'https://agents.example.com/.well-known/agent-card.json',
  headers: { authorization: `Bearer ${process.env.RESEARCH_TOKEN}` },
});
const agent = createAgent({ client: ai, tools: [research] });
```

## ACP: an agent in an editor

`serveAcp()` serves a graph to an editor that speaks the Agent Client Protocol, version
`ACP_PROTOCOL_VERSION` (1). The editor starts the agent as a subprocess and writes JSON-RPC to its
standard input, one message per line. `AcpStreams` names the two ends: `process.stdin` and
`process.stdout`, or any pair like them.

```js
#!/usr/bin/env node
// reviewer.mjs: started by the editor
import { createDeepAgent } from 'nexus-ai-pro/deep-agent';
import { serveAcp } from 'nexus-ai-pro/protocols/acp';

const agent = createDeepAgent({ client: ai, interruptOn: { edit_file: true, write_file: true } });
serveAcp(agent, { input: process.stdin, output: process.stdout }, { agentInfo: { name: 'reviewer', version: '1.0.0' } });
```

Nothing else may write to standard output. Logs go to standard error.

Each editor session is a conversation on its own thread, and `AcpSessionInfo` describes it:
- its id;
- the directory it was opened in;
- the MCP servers the editor offered.

A prompt is a list of `AcpContentBlock` values. Text is read as written, an embedded file is
fenced under its URI, and a link is named. The default graph input is `{ messages }`: the session's
conversation and the prompt. `AcpOptions.input` builds another from the prompt text, the session,
and the history.

While the prompt runs, the editor receives each `AcpSessionUpdate`:
- the agent's text as it streams, and its reasoning as thought;
- each tool call, then its result:
  - the call has a title and an `AcpToolKind`, and the file it touches when it has a `path`
    argument;
  - the result is text, and an edit's result is also a diff;
- the plan, whenever `write_todos` records one.

`AcpOptions.kind` decides a tool's kind. By default, the kind is guessed from the name:
`read_file` reads, `edit_file` edits, and `execute` runs a command.

The prompt answers with an `AcpStopReason`:
- `end_turn` when the agent answered;
- `max_turn_requests` when it ran out of iterations;
- `cancelled` when the editor cancelled the session.

### Approvals

A tool call that needs approval asks the editor, which shows the person four choices: allow once,
always allow, reject once, and always reject. An always choice holds for that tool for the rest of
the session. A rejected call runs nothing, and the agent is told it was refused. Cancelling the
session while the editor asks ends the turn as cancelled.

ACP asks only for permissions, so the agent asks any other question in its message, and the turn
ends there. The next prompt is the answer. `AcpOptions.answer` maps it, and defaults to the
prompt's text.

`AcpOptions.principal` is who the agent acts for: the person at the editor. The returned
`AcpServer` resolves `closed` when the editor closes its end. `close()` stops every prompt still
running.

## Proof

Each protocol is tested from the other side of the wire, with no Nexus client code on that side:
- **AG-UI.** A plain `fetch` and Server-Sent Events parser renders a streaming agent's run. The
  render includes the transcript, the tool call with its arguments and result, and the final answer.
  Every event carries the fields the specification requires. A run that needs approval finishes
  with an interrupt, and a resume entry on the same thread continues it.
- **A2A, served.** A client that writes raw JSON-RPC reads the card, sends messages, and continues
  a conversation by context. It answers an approval, streams a task, and cancels one. It also gets
  each of the specification's error codes.
- **A2A, calling.** The client and tool are tested against a stub agent written from the
  specification alone. The stub answers with a task, with a bare message, and with a stream split
  mid-frame. Then one Nexus agent calls another through the tool.
- **ACP.** An editor's end of the connection, written line by line, does the following:
  - it initializes;
  - it opens a session;
  - it sends a prompt with an embedded file;
  - it approves an edit with "always allow";
  - it sees the plan, the diff, and the answer.

  A second prompt in the session asks nothing and carries the transcript over. Rejecting runs
  nothing, cancelling ends the turn as cancelled, and a question is asked in words.

## Limitations

- **AG-UI.** The adapter reports state once, as a snapshot when the run ends: no `STATE_DELTA` or
  `MESSAGES_SNAPSHOT`. Tools the frontend offers reach `input`, but the adapter does not run them.
- **A2A tasks live in memory.** A restart forgets them, so serve one process per agent or put a
  sticky route in front. The agent's own checkpoints are as durable as its checkpointer.
- **A2A coverage.** Only the JSON-RPC binding is served, without `ListTasks`, `SubscribeToTask`,
  push notifications, or an extended card.
- **ACP sessions live in memory too.** The agent does not offer `session/load`, and it reads text
  prompts only, not images or audio. It does not use the editor's file system or terminal, or
  connect the MCP servers the editor offers. Those reach `input` through the session, for a graph
  that uses them.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/protocols/a2a`

| Export | Kind | Summary |
| --- | --- | --- |
| `A2A_ERRORS` | constant | A2A's error codes, beside JSON-RPC's own. |
| `A2A_PROTOCOL_VERSION` | constant | The protocol version this module speaks. |
| `A2aAgentCard` | interface | What an agent publishes about itself at `/.well-known/agent-card.json`. |
| `A2aArtifact` | interface | What a task produced. |
| `a2aClient` | function | A client for an A2A agent, by its card or endpoint URL. |
| `A2aClient` | interface | A client for one A2A agent. |
| `A2aClientOptions` | interface | Options for `a2aClient()`. |
| `A2aError` | class | Raised by the client when an agent answers with a JSON-RPC error. |
| `a2aHandler` | function | An HTTP handler that serves a graph as an A2A agent: `GET` the card, `POST` JSON-RPC. |
| `A2aMessage` | interface | A message between agents. |
| `A2aPart` | interface | One part of a message or an artifact: text, structured data, or a file by URL or bytes. |
| `A2aRole` | type | Who a message is from. |
| `A2aSendOptions` | interface | What to send: text, and optionally data, a conversation, or the paused task it answers. |
| `A2aServerOptions` | interface | Options for `a2aHandler()`. |
| `A2aSkill` | interface | A skill an agent card advertises. |
| `A2aStreamEvent` | type | A streamed event: a task, a status change, or a piece of an artifact. |
| `A2aTask` | interface | A unit of work an agent was asked to do. |
| `A2aTaskState` | type | Where a task stands. |
| `a2aTool` | function | A remote A2A agent as a tool another agent can call. |
| `A2aToolOptions` | interface | Options for `a2aTool()`. |

### `nexus-ai-pro/protocols/acp`

| Export | Kind | Summary |
| --- | --- | --- |
| `ACP_PROTOCOL_VERSION` | constant | The protocol version this module speaks. |
| `AcpContentBlock` | interface | One block of a prompt: text, a file the editor embedded, or a link to one. |
| `AcpOptions` | interface | Options for `serveAcp()`. |
| `AcpServer` | interface | A running ACP connection. |
| `AcpSessionInfo` | interface | An editor session, as `input` sees it. |
| `AcpSessionUpdate` | type | What the agent tells the editor during a turn: ACP's `session/update`. |
| `AcpStopReason` | type | Why a prompt's turn ended. |
| `AcpStreams` | interface | Where the agent reads and writes: `process.stdin` and `process.stdout`, or any pair like them. |
| `AcpToolKind` | type | What a tool call does, so the editor can show it: ACP's tool kinds. |
| `serveAcp` | function | Serves a graph to an editor over ACP. |

### `nexus-ai-pro/protocols/ag-ui`

| Export | Kind | Summary |
| --- | --- | --- |
| `AgUiEvent` | type | An AG-UI event, as the stream carries it. |
| `agUiEvents` | function | A run as AG-UI events, for any transport: Server-Sent Events, a WebSocket, a test. |
| `AgUiEventsOptions` | interface | Options for `agUiEvents()`: everything `agUiHandler()` takes, with the caller already known. |
| `agUiHandler` | function | An HTTP handler that serves a graph to AG-UI frontends: POST a `RunAgentInput`, read the run as Server-Sent Events. |
| `AgUiInterrupt` | interface | A question a paused run asks, in AG-UI's shape. |
| `AgUiMessage` | interface | A message in AG-UI's shape. |
| `agUiMessages` | function | The conversation from a `RunAgentInput`, as Nexus messages. |
| `AgUiOptions` | interface | Options for `agUiEvents()` and `agUiHandler()`. |
| `AgUiResumeEntry` | interface | One answer to an interrupt, in a resumed run. |
| `AgUiRunInput` | interface | What a frontend sends to start or resume a run: AG-UI's `RunAgentInput`. |
| `encodeAgUiEvent` | function | One event as a Server-Sent Event: `data: <json>` and a blank line. |
| `ProtocolGraph` | interface | The part of a compiled graph the protocols drive. |
| `ProtocolInterrupt` | interface | A question a paused run is waiting on. |
| `ProtocolResult` | interface | What a run ended with. |
| `ProtocolRunOptions` | interface | Run options a protocol passes to a graph. |
<!-- reference:end -->
