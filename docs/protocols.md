# Agent protocols

<!-- covers: ./protocols/ag-ui ./protocols/a2a ./protocols/acp ./protocols/acp/editor -->

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
- `TOOL_CALL_START`, `TOOL_CALL_ARGS`, and `TOOL_CALL_END` for each call, then `TOOL_CALL_RESULT`.
  While the tool runs, each report of its progress is a `CUSTOM` event named `tool_progress`, whose
  value has the call's id and name and the progress;
- `STATE_SNAPSHOT` with the final state, unless `stateSnapshot` is false;
- last, `RUN_FINISHED` with the answer as its `result`, or `RUN_ERROR` with the failure's message
  and code.

A subgraph's events belong to the parent's step, so only the graph's own nodes are reported as
steps. Reasoning is not sent as message text.

### State, transcripts, and the frontend's tools

Three options turn on the rest of the protocol. Each is off by default, so a frontend sees the
events above and nothing more until it asks:

| Option | What the frontend gets |
| --- | --- |
| `stateDeltas` | The state as it changes: a `STATE_SNAPSHOT` after the first step, then a `STATE_DELTA` after every step that changed it. A delta is an RFC 6902 JSON Patch, a list of `AgUiPatchOperation` values. A message added to the transcript is one `add` at `/messages/-`, so a long conversation costs only what is new. |
| `messagesSnapshot` | A `MESSAGES_SNAPSHOT` with the whole transcript before the run finishes. The frontend's messages keep their ids, a tool's result has the id of its `TOOL_CALL_RESULT`, and the rest are named after the run. |
| `frontendTools` | The tools the frontend sends, offered to the model. |

A tool the frontend offers runs in the frontend. When the model calls one, the frontend sees
`TOOL_CALL_START`, `TOOL_CALL_ARGS`, and `TOOL_CALL_END` for it and no result, and the run finishes
once the agent's own calls of that step are done. The frontend runs the tool and sends the
conversation back with a `tool` message carrying the result, and the turn carries on from there.
The agent's state says why it stopped: `stopReason: 'client_tools'`. A frontend tool named like one
of the agent's own is ignored, so a page can never replace a tool that runs on the server.

```ts
export const POST = agUiHandler(agent, { stateDeltas: true, messagesSnapshot: true, frontendTools: true });
```

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
- the capabilities: streaming, and push notifications and an extended card when they are set up;
- the input and output media types, unless given.

A `POST` is a JSON-RPC call:
- `SendMessage` starts a task from an `A2aMessage` and returns the `A2aTask` when it is done.
  With `returnImmediately`, it returns the task while it runs.
- `SendStreamingMessage` streams `A2aStreamEvent` values: the task, then the answer as artifact
  updates while it streams, then the final status. A tool's progress is a `TASK_STATE_WORKING`
  status update while it runs, whose message says what is happening in text and carries the
  progress as data.
- `GetTask` reads a task, with as much of its history as `historyLength` asks for.
- `ListTasks` lists tasks, most recent first, by `contextId` and by `status`, a page at a time:
  `pageSize` (50, at most 100) and the `nextPageToken` of the page before. A page is an
  `A2aTaskPage`, with `totalSize` when the store counts.
- `SubscribeToTask` follows a task still running, from now until it finishes or waits: the task,
  then its events. It works on any replica. Where the task runs, the events come as they happen;
  elsewhere, the replica reads the task every `pollMs` (1 second) and reports each change.
- `CancelTask` stops a task that is still running. On another replica, it stands too: the replica
  running the task finishes its work but does not record it over the cancel.
- `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`,
  `ListTaskPushNotificationConfig`, and `DeleteTaskPushNotificationConfig` manage a task's
  webhooks, when the agent pushes. `SendMessage` takes one too, in its configuration.
- `GetExtendedAgentCard` returns the card for an authenticated caller, when the agent has one.

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

### Tasks that outlive the process

Tasks and conversations live in an `A2aTaskStore`. Each task is an `A2aTaskRecord`: the task, its
messages, the questions it waits on, and its webhooks. `A2aTaskQuery` is what a listing asks for.
- `MemoryA2aTaskStore` is the default, for one replica. `maxTasks` bounds the tasks and contexts
  it keeps, 10,000 each.
- `storeA2aTasks()` keeps them in any long-term `Store`: the memory, Redis, Postgres, or SQLite
  store, so every replica shares them. Listing filters in the store and does not count.

A task paused for an answer then survives a restart: another replica reads it, and the message
that answers it resumes the run there. The graph resumes from its own checkpoints, so give it a
shared checkpointer too.

```ts
import { a2aHandler, storeA2aTasks } from 'nexus-ai-pro/protocols/a2a';

const agent = createAgent({ client: ai, tools, interruptOn: { send_email: true }, checkpointer: postgresCheckpointer });
export const handler = a2aHandler(agent, {
  card,
  store: storeA2aTasks(postgresStore),
  recoverEveryMs: 15_000, // take over what a stopped replica was working on
});
```

A task that is working survives its replica too. `a2aHandler()` returns an `A2aHandler`: the
request handler, plus `recover()` and `close()`. While a replica runs a task, the record holds its
`A2aTaskLease`: the replica's `owner` name and when the lease lapses. The replica renews it every
third of `lease.ms` (30 seconds). The record also holds the `A2aTaskRun`: whether a message started
the run or answers resumed it, that message, the answers, and the principal. A new task is written
with its run from its first write, so a task submitted to a replica that stops before starting it is
started by another, for the same principal.

`recover()` reads the working tasks whose lease has lapsed, and the submitted tasks no replica
started, and takes each over, up to `limit` (10).
It claims the lease, then carries the run on: from the graph's last checkpoint through the graph's
`continueWith()`, by answering the questions again when a resume never reached the graph, or from
the start when the run left no checkpoint. It resolves to an `A2aRecoveryReport` once the tasks are
claimed. `recoverEveryMs` runs it on a timer, which `close()` stops.

`A2aTaskStore.claim()` takes a lease in one step, so of two replicas recovering at once, one takes
the task. `MemoryA2aTaskStore` has it, and `storeA2aTasks()` builds it on the store's
`putIfVersion()`, bumping the record's `version`. A replica that finds another holding its task's
lease stops the run, and never records its result over the other's. A graph of your own without
`continueWith()` cannot carry a run on: its task fails with that reason rather than staying working.

In the test suite, a task whose replica dies halfway through a tool is taken over on every store.
The model call the dead replica finished is not made again, the email it never sent is sent once,
and two replicas recovering at the same moment take the task over once. A crash-injection suite then
kills the replica at every write a task makes, and another replica takes it over each time and ends
it as a task never interrupted ends. A replica that dies before the task's first write has told its
caller so. A store that cannot record a task's failure leaves the task working, with its lease, for
the replica that takes it over.

### Push notifications and the extended card

With `pushNotifications`, a caller can give a task a webhook, an `A2aPushNotificationConfig` with a
URL and a token. Each change of the task's state is then POSTed to it as a status update, in order:
- with the caller's token as `X-A2A-Notification-Token`;
- signed with `A2aPushOptions.secret` as the server's operation webhooks are, in
  `x-nexus-signature`, so the receiver checks it with `verifyOperationWebhook()`;
- within `timeoutMs` (5 seconds), without following a redirect. A failed delivery goes to `onError`
  and never fails the task.

A webhook is a URL a caller chose, which the agent then fetches. So it must be `https`, and not a
loopback, private, or link-local address or name such as `localhost` or `metadata.internal`.
`allowPrivateNetworks` turns that off, for tests or trusted callers. A name is checked as written,
not as it resolves; to close a name that resolves to a private address, pass a `fetch` that checks
the address it connects to, or send deliveries through an egress proxy.

`extendedCard` gives an authenticated caller more of the card, such as skills only partners see. It
is called with the caller's principal, and `GetExtendedAgentCard` refuses a caller without one.

### Calling other agents

`a2aClient()` talks to any A2A agent. `A2aClientOptions` takes the agent's card URL, or its
endpoint, whose origin serves the card. Pass `fetch` and `headers` for authentication or a proxy.
An `A2aClient` can:
- read the `card()`, and the `extendedCard()`;
- `send()` a message and wait for its task;
- `stream()` a task's events;
- read a task with `getTask()`, list them with `listTasks()`, and follow one with `subscribe()`;
- `cancel()` one;
- manage a task's webhooks with `setPushNotification()`, `listPushNotifications()`, and
  `deletePushNotification()`.

`A2aSendOptions` continues a conversation by `contextId`, answers a task by `taskId`, sends data
beside the text, gives a webhook as `push`, returns at once with `returnImmediately`, or cancels by
signal. `A2aListTasksOptions` filters and pages a listing. A JSON-RPC error raises an `A2aError` with its code.

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
fenced under its URI, and a link is named. An image or audio block reaches the model as an image or
audio part beside the text: the agent tells the editor in `initialize` that it reads both. The
default graph input is `{ messages }`: the session's conversation and the prompt. `AcpOptions.input`
builds another from the prompt text, the session, the history, and the blocks.

While the prompt runs, the editor receives each `AcpSessionUpdate`:
- the agent's text as it streams, and its reasoning as thought;
- each tool call, then its result:
  - the call has a title and an `AcpToolKind`, and the file it touches when it has a `path`
    argument;
  - while it runs, each report of its progress updates the call, still `in_progress`;
  - the result is text, and an edit's result is also a diff;
- the plan, whenever `write_todos` records one.

`AcpOptions.kind` decides a tool's kind. By default, the kind is guessed from the name:
`read_file` reads, `edit_file` edits, and `execute` runs a command.

### Sessions an editor reopens

Sessions live in an `AcpSessionStore`, each as an `AcpSessionRecord`: the session, its
conversation, the question it waits on, and the person's standing choices to always allow or
reject a tool.
- `MemoryAcpSessionStore` is the default.
- `storeAcpSessions()` keeps them in any long-term `Store`: the memory, Redis, Postgres, or SQLite
  store.

The agent offers `session/load`. After the agent restarts, the editor reopens a session by its id.
The agent then replays the conversation as updates (the person's messages, its own, and each tool
call with its result) and asks again any question it was waiting on, so the next prompt answers it.
A store outside the process makes a session survive a restart; give the graph a durable
checkpointer too, so the paused run resumes. Audio is kept in a session as a note that it was
heard, not as its bytes.

A turn the agent was in the middle of survives too. While a prompt runs, its record holds an
`AcpTurnRecord`: whether the prompt started a run or answered the last turn's questions, the prompt,
and the answers. When `session/load` finds one, the agent carries the turn on once the load has
answered, streaming its updates as a prompt would:
- from the graph's last checkpoint, so steps that finished are not run again;
- by answering again a resume that never reached the graph;
- or from the start, when the run left no checkpoint.

A turn stopped while the editor was deciding an approval asks for it again. A prompt sent meanwhile
waits for the carried-on turn. A graph without `continueWith()` cannot carry a turn on, so the agent
says so in the session, and the turn ends. In the test suite, an agent that stops halfway through a
tool is started again and its session reopened: the model call it finished is not made again, the
email it never sent is sent once, and the answer reaches the editor.

### The editor's files, terminal, and MCP servers

`acpEditor()`, on `nexus-ai-pro/protocols/acp/editor`, gives an agent what the editor offers, as an
`AcpEditor`. Pass it to `serveAcp()` as `editor`, an `AcpEditorBridge`, and its `toolSource` to the
agent:

```ts
import { createAgent } from 'nexus-ai-pro/agent';
import { serveAcp } from 'nexus-ai-pro/protocols/acp';
import { acpEditor } from 'nexus-ai-pro/protocols/acp/editor';

const editor = acpEditor();
const agent = createAgent({
  client: ai,
  toolSource: editor.toolSource,
  interruptOn: { editor_write_file: true, editor_run_command: true },
});
serveAcp(agent, { input: process.stdin, output: process.stdout }, { editor });
```

Each session gets the tools the editor said it can serve, in `initialize`, as `AcpClientCapabilities`:
- `editor_read_file` reads through the editor, including changes the person has not saved;
- `editor_write_file` writes through the editor, which shows the change;
- `editor_run_command` runs a command in the editor's terminal, which the person sees, and returns
  its output and exit code. A cancelled run kills the command, and the terminal is always released;
- the tools of each MCP server the editor offered for the session, prefixed by the server's name.
  Servers started over stdio run in the session's directory, and HTTP servers are reached as given.

A relative path is taken from the session's directory. Each tool declares what it touches, as
`filesystem:read:<path>`, `filesystem:write:<path>`, or `shell:<command>`, so a permission policy
decides it, and an approval asks the person in the editor. The bridge asks the editor through an
`AcpConnection`, which `serveAcp()` attaches. When the editor closes its end, the bridge closes the
MCP servers it started.

`AcpEditorOptions` turns off `files`, `terminal`, or `mcp`, and sets `mcpTimeoutMs` (30 seconds),
`mcpFetch`, `maxOutputBytes` (64 KB), and `onError` for a server that fails to start.

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

Each protocol is also tested across releases and against the reference client of its own project:
- **The previous minor.** A 2.5 client drives this release's server, and this release's client a
  2.5 server, on the server's HTTP API and on A2A. One harness written against AG-UI and ACP drives
  both releases' servers. A 2.6 client asking a 2.5 agent for something 2.6 added gets a protocol
  error, never a broken answer.
- **Reference clients, nightly.** `scripts/interop/run.mjs` installs the latest `@ag-ui/client`,
  `@a2a-js/sdk`, and `@agentclientprotocol/sdk` in a directory of their own, without their
  scripts. Each drives its protocol:
  - the AG-UI client pauses a run, resumes it, and rebuilds the state from its deltas;
  - the A2A client sends, approves, reads, lists, and streams tasks;
  - the ACP client starts an agent as an editor would. The agent reads a file through it, writes
    once the client allows it, and has its session reloaded.

  The `Interoperability` workflow runs it every night.

## Limitations

- **AG-UI.** A state delta compares JSON: a value JSON cannot carry, such as a `Date` or a `Map`,
  reaches the frontend as JSON makes it. A change inside an array other than appending replaces the
  whole array.
- **A2A tasks running when their process stops.** A step that was halfway through when the
  process stopped runs again on the replica that takes it over, as a graph's steps do after any
  crash, so a tool with side effects needs an idempotency key. A slow replica that loses its lease
  stops its run, but a tool already running finishes.
- **A2A coverage.** Only the JSON-RPC binding is served. A webhook receives state changes, not each
  piece of streamed text.
- **ACP turns.** A turn goes on when the editor reopens its session, not before; one the agent stops
  in again while carrying it on goes on at the next reopening. A step that was halfway through when
  the agent stopped runs again, so a tool with side effects needs an idempotency key.
- **The editor's MCP servers.** Servers over stdio and HTTP are connected; an SSE server is not. A
  server's tools declare no capabilities, so a permission policy needs a rule for them by name.

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
| `A2aHandler` | interface | An A2A agent's HTTP handler, with what keeps its tasks alive across replicas: `recover()` takes over the working tasks whose replica stopped renewing their lease, and `close()` stops the recovery timer. |
| `A2aListTasksOptions` | interface | Which tasks `A2aClient.listTasks()` asks for. |
| `A2aMessage` | interface | A message between agents. |
| `A2aPart` | interface | One part of a message or an artifact: text, structured data, or a file by URL or bytes. |
| `A2aPushNotificationConfig` | interface | Where a task's updates are pushed: a webhook the calling agent gave. |
| `A2aPushOptions` | interface | Options for pushing task updates to the webhooks callers give. |
| `A2aRecoveryReport` | interface | What one `recover()` did. |
| `A2aRole` | type | Who a message is from. |
| `A2aSendOptions` | interface | What to send: text, and optionally data, a conversation, or the paused task it answers. |
| `A2aServerOptions` | interface | Options for `a2aHandler()`. |
| `A2aSkill` | interface | A skill an agent card advertises. |
| `A2aStreamEvent` | type | A streamed event: a task, a status change, or a piece of an artifact. |
| `A2aTask` | interface | A unit of work an agent was asked to do. |
| `A2aTaskLease` | interface | A replica's hold on a working task. |
| `A2aTaskPage` | interface | A page of tasks. |
| `A2aTaskQuery` | interface | Which tasks `A2aTaskStore.list()` returns. |
| `A2aTaskRecord` | interface | A task as a store keeps it: the task, its messages, the questions it waits on, and its webhooks. |
| `A2aTaskRun` | interface | A working run, as kept with its task: started by a message, or answering the task's questions. |
| `A2aTaskState` | type | Where a task stands. |
| `A2aTaskStore` | interface | Where an A2A agent keeps its tasks and conversations. |
| `a2aTool` | function | A remote A2A agent as a tool another agent can call. |
| `A2aToolOptions` | interface | Options for `a2aTool()`. |
| `MemoryA2aTaskStore` | class | Tasks and conversations in this process: the default, for one replica. |
| `storeA2aTasks` | function | Tasks and conversations in any long-term `Store`: the memory, Redis, Postgres, or SQLite store, so every replica sees one set. |

### `nexus-ai-pro/protocols/acp`

| Export | Kind | Summary |
| --- | --- | --- |
| `ACP_PROTOCOL_VERSION` | constant | The protocol version this module speaks. |
| `AcpClientCapabilities` | interface | What the editor said it can do for the agent, in `initialize`. |
| `AcpConnection` | interface | The connection to the editor, as a bridge sees it. |
| `AcpContentBlock` | interface | One block of a prompt: text, an image, audio, a file the editor embedded, or a link to one. |
| `AcpEditorBridge` | interface | Something that uses the editor's connection, such as `acpEditor()`. |
| `AcpOptions` | interface | Options for `serveAcp()`. |
| `AcpServer` | interface | A running ACP connection. |
| `AcpSessionInfo` | interface | An editor session, as `input` sees it. |
| `AcpSessionRecord` | interface | A session as a store keeps it. |
| `AcpSessionStore` | interface | Where an ACP agent keeps its sessions. |
| `AcpSessionUpdate` | type | What the agent tells the editor during a turn: ACP's `session/update`. |
| `AcpStopReason` | type | Why a prompt's turn ended. |
| `AcpStreams` | interface | Where the agent reads and writes: `process.stdin` and `process.stdout`, or any pair like them. |
| `AcpToolKind` | type | What a tool call does, so the editor can show it: ACP's tool kinds. |
| `AcpTurnRecord` | interface | A turn in progress, as a session keeps it. |
| `MemoryAcpSessionStore` | class | Sessions in this process: the default. |
| `serveAcp` | function | Serves a graph to an editor over ACP. |
| `storeAcpSessions` | function | Sessions in any long-term `Store`: the memory, Redis, Postgres, or SQLite store. |

### `nexus-ai-pro/protocols/acp/editor`

| Export | Kind | Summary |
| --- | --- | --- |
| `acpEditor` | function | The editor's files, terminal, and MCP servers, as tools an agent's `toolSource` supplies per session. |
| `AcpEditor` | interface | The editor, as tools for an agent. |
| `AcpEditorOptions` | interface | Options for `acpEditor()`. |

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
| `AgUiPatchOperation` | interface | One operation of an RFC 6902 JSON Patch, as `STATE_DELTA` carries them. |
| `AgUiResumeEntry` | interface | One answer to an interrupt, in a resumed run. |
| `AgUiRunInput` | interface | What a frontend sends to start or resume a run: AG-UI's `RunAgentInput`. |
| `encodeAgUiEvent` | function | One event as a Server-Sent Event: `data: <json>` and a blank line. |
| `ProtocolGraph` | interface | The part of a compiled graph the protocols drive. |
| `ProtocolInterrupt` | interface | A question a paused run is waiting on. |
| `ProtocolResult` | interface | What a run ended with. |
| `ProtocolRunOptions` | interface | Run options a protocol passes to a graph. |
<!-- reference:end -->
