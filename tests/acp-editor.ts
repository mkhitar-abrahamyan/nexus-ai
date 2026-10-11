/**
 * An editor on the other end of an ACP connection, for tests: it sends requests one JSON line at a
 * time, records every `session/update`, and answers the agent's own requests to the editor (a
 * permission, a file, a terminal) through `answer`.
 */
import assert from 'node:assert/strict';
import { type AcpOptions, type AcpSessionUpdate, serveAcp } from '../src/protocols/acp.js';

/** A JSON-RPC message, loosely: tests read whatever fields they expect. */
// biome-ignore lint/suspicious/noExplicitAny: a test reads the fields of messages it chose to send.
export type Wire = Record<string, any>;

/** Starts `serveAcp()` on in-memory streams, with an editor driving it. */
export function acpEditor(
  graph: Parameters<typeof serveAcp>[0],
  answer: (method: string, params: Wire) => unknown = () => ({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  }),
  options: AcpOptions = {},
) {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const encoder = new TextEncoder();
  async function* input(): AsyncIterable<Uint8Array> {
    while (true) {
      if (queue.length) {
        yield queue.shift() as Uint8Array;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const send = (message: unknown) => {
    queue.push(encoder.encode(`${JSON.stringify(message)}\n`));
    wake?.();
  };
  const updates: Array<AcpSessionUpdate & { sessionId?: string }> = [];
  const asked: Array<{ method: string; params: Wire }> = [];
  const replies = new Map<string | number, (message: Wire) => void>();
  let ids = 0;
  const server = serveAcp(
    graph,
    {
      input: input(),
      output: {
        write(chunk: string) {
          assert.ok(chunk.endsWith('\n'), 'one message per line');
          const message = JSON.parse(chunk) as Wire;
          assert.equal(message.jsonrpc, '2.0');
          if (message.method === 'session/update') {
            updates.push({ ...message.params.update, sessionId: message.params.sessionId });
          } else if (message.method !== undefined && message.id !== undefined) {
            asked.push({ method: message.method, params: message.params });
            Promise.resolve(answer(message.method, message.params)).then(
              (result) => send({ jsonrpc: '2.0', id: message.id, result }),
              (error: Error) =>
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }),
            );
          } else if (replies.has(message.id)) {
            replies.get(message.id)?.(message);
            replies.delete(message.id);
          }
        },
      },
    },
    { agentInfo: { name: 'test-agent', version: '1.0.0' }, ...options },
  );
  return {
    server,
    updates,
    asked,
    request: (method: string, params: unknown) =>
      new Promise<Wire>((resolve) => {
        const id = ++ids;
        replies.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      }),
    close() {
      ended = true;
      wake?.();
    },
  };
}
