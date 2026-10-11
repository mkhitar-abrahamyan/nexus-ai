#!/usr/bin/env node
/**
 * An ACP agent for the interoperability run, started by the reference client as an editor starts
 * one: it reads a file through the editor, asks before writing it, and answers with what it did.
 * Built from this package's `dist/`.
 */
import { createAgent } from '../../dist/agent/index.js';
import { serveAcp } from '../../dist/protocols/acp.js';
import { acpEditor } from '../../dist/protocols/acp-editor.js';

const steps = [
  { name: 'editor_read_file', args: { path: 'notes.md' } },
  { name: 'editor_write_file', args: { path: 'notes.md', content: 'reviewed' } },
];
let calls = 0;
const client = {
  async complete(request) {
    // Each prompt runs the steps from the start.
    if (request.messages.at(-1)?.role === 'user') calls = 0;
    const step = steps[calls];
    calls += 1;
    if (step) {
      return {
        content: '',
        role: 'assistant',
        finishReason: 'tool_calls',
        meta: {},
        toolCalls: [
          {
            id: `call-${calls}`,
            type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          },
        ],
      };
    }
    const results = request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
    return { content: `Done: ${results.join(' / ')}`, role: 'assistant', finishReason: 'stop', meta: {} };
  },
};

const editor = acpEditor({ mcp: false });
const agent = createAgent({
  client,
  model: 'mock',
  toolSource: editor.toolSource,
  interruptOn: { editor_write_file: true },
});
serveAcp(
  agent,
  { input: process.stdin, output: process.stdout },
  { editor, agentInfo: { name: 'nexus-interop', version: '1.0.0' } },
);
