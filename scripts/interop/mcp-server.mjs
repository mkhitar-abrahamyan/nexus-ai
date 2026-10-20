#!/usr/bin/env node
/**
 * An MCP server built with the reference SDK, `@modelcontextprotocol/sdk`, for the interoperability
 * run: one tool that reads and one that destroys, each annotated as the specification has it. Served
 * over stdio when started as a process, the way an editor offers a local server; the run serves the
 * same tools over HTTP and SSE itself, with `mcpTools()`.
 *
 *   node scripts/interop/mcp-server.mjs <clients directory> <server name> <file the calls are logged to>
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Registers the two tools on a reference `McpServer`, logging each call. */
export function mcpTools(server, name, called) {
  server.registerTool(
    'lookup',
    { description: 'Looks a record up', annotations: { readOnlyHint: true, openWorldHint: false } },
    async () => {
      called('lookup');
      return { content: [{ type: 'text', text: `${name} found it` }] };
    },
  );
  server.registerTool(
    'wipe',
    { description: 'Deletes every record', annotations: { destructiveHint: true, openWorldHint: false } },
    async () => {
      called('wipe');
      return { content: [{ type: 'text', text: `${name} wiped everything` }] };
    },
  );
  return server;
}

/** The reference SDK's modules, from the clients' own directory. */
export async function mcpSdk(directory) {
  const resolve = createRequire(path.join(directory, 'package.json')).resolve;
  const load = async (specifier) => import(pathToFileURL(resolve(specifier)).href);
  return {
    ...(await load('@modelcontextprotocol/sdk/server/mcp.js')),
    ...(await load('@modelcontextprotocol/sdk/server/stdio.js')),
    ...(await load('@modelcontextprotocol/sdk/server/sse.js')),
    ...(await load('@modelcontextprotocol/sdk/server/streamableHttp.js')),
  };
}

const [directory, name, log] = process.argv.slice(2);
if (directory && name && log) {
  const sdk = await mcpSdk(directory);
  const server = mcpTools(new sdk.McpServer({ name, version: '1.0.0' }), name, (tool) =>
    appendFileSync(log, `${tool}\n`),
  );
  await server.connect(new sdk.StdioServerTransport());
}
