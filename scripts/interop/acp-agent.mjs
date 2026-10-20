#!/usr/bin/env node
/**
 * An ACP agent for the interoperability run, started by the reference client as an editor starts
 * one: it reads a file through the editor, asks before writing it, and answers with what it did.
 * With `--mcp`, it instead calls every tool of the MCP servers the editor offered, under a policy that
 * lets MCP tools read and nothing else. Built from this package's `dist/`.
 */
import { createAgent } from '../../dist/agent/index.js';
import { permissionPolicy } from '../../dist/agent/permissions.js';
import { serveAcp } from '../../dist/protocols/acp.js';
import { acpEditor } from '../../dist/protocols/acp-editor.js';

const withMcp = process.argv.includes('--mcp');
const steps = [
  { name: 'editor_read_file', args: { path: 'notes.md' } },
  { name: 'editor_write_file', args: { path: 'notes.md', content: 'reviewed' } },
];
let calls = 0;
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const client = {
  async complete(request) {
    const results = request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
    if (withMcp) {
      // Every MCP tool at once, then what each answered.
      if (results.length)
        return { content: `Done: ${results.join(' / ')}`, role: 'assistant', finishReason: 'stop', meta: {} };
      const tools = (request.tools ?? []).map((tool) => tool.name).filter((name) => !name.startsWith('editor_'));
      return {
        content: '',
        role: 'assistant',
        finishReason: 'tool_calls',
        meta: {},
        toolCalls: tools.map((name, index) => call(`mcp-${index}`, name)),
      };
    }
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
        toolCalls: [call(`call-${calls}`, step.name, step.args)],
      };
    }
    return { content: `Done: ${results.join(' / ')}`, role: 'assistant', finishReason: 'stop', meta: {} };
  },
};

const editor = acpEditor({ mcp: withMcp });
const agent = createAgent({
  client,
  model: 'mock',
  toolSource: editor.toolSource,
  ...(withMcp
    ? { permissions: permissionPolicy({ custom: { 'mcp.read': 'allow' } }) }
    : { interruptOn: { editor_write_file: true } }),
});
serveAcp(
  agent,
  { input: process.stdin, output: process.stdout },
  { editor, agentInfo: { name: 'nexus-interop', version: '1.0.0' } },
);
