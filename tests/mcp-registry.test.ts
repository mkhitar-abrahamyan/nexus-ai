import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { tool } from '../src/agent/tool.js';
import { createStdioTransport, serverEnvironment } from '../src/mcp/client.js';
import type { JsonRpcMessage, McpTransport } from '../src/mcp/protocol.js';
import { McpRegistry, McpRegistryError, type McpServerConfig, validateMcpConfig } from '../src/mcp/registry.js';
import { McpServer } from '../src/mcp/server.js';

/** An environment placeholder as a configuration file writes it: `${NAME}`. */
const ref = (name: string) => ['$', '{', name, '}'].join('');
const work = mkdtempSync(path.join(tmpdir(), 'nexus-mcp-registry-'));
after(() => rmSync(work, { recursive: true, force: true }));

function echoTool(name: string) {
  return tool({
    name,
    description: `The ${name} tool`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (args) => `${name}:${String(args.text ?? '')}`,
  });
}

/** In-process servers by name, each reached through a transport pair; records the config each saw. */
function harness(servers: Record<string, string[]>, failing: string[] = []) {
  const seen = new Map<string, McpServerConfig>();
  let closed = 0;
  const transport = (name: string, config: McpServerConfig): McpTransport => {
    seen.set(name, config);
    let toClient: (message: JsonRpcMessage) => void = () => undefined;
    let toServer: (message: JsonRpcMessage) => void = () => undefined;
    const serverSide: McpTransport = {
      send: (message) => toClient(message),
      onMessage: (handler) => {
        toServer = handler;
      },
      close: () => undefined,
    };
    void new McpServer({ name, version: '1.0.0', tools: (servers[name] ?? []).map(echoTool) }).connect(serverSide);
    return {
      start: async () => {
        if (failing.includes(name)) throw new Error(`${name} is down`);
      },
      send: (message) => toServer(message),
      onMessage: (handler) => {
        toClient = handler;
      },
      close: () => {
        closed++;
      },
    };
  };
  return { transport, seen, closed: () => closed };
}

test('a registry applies each server’s allow and deny lists and prefixes tool names', async () => {
  const { transport } = harness({ github: ['list_issues', 'list_repos', 'delete_repo'], docs: ['search'] });
  const registry = new McpRegistry(
    {
      mcpServers: {
        github: { command: 'github-mcp', allowTools: ['list_*', 'delete_repo'], denyTools: ['delete_*'] },
        docs: { url: 'https://docs.test/mcp', prefix: false },
        'old.server': { command: 'old', enabled: false },
      },
    },
    { transport },
  );
  assert.deepEqual(registry.serverNames(), ['github', 'docs'], 'a disabled server is left out');
  const tools = await registry.tools();
  assert.deepEqual(
    tools.map((item) => item.name),
    ['github_list_issues', 'github_list_repos', 'search'],
    'deny wins over allow, and prefix false keeps the name',
  );
  assert.equal(
    await tools[0].execute?.({ text: 'hi' }),
    'list_issues:hi',
    'a tool calls the server tool by its own name',
  );
  await assert.rejects(registry.tools('nothing'), /neither a bundle nor an enabled server/);
  assert.throws(() => registry.client('old.server'), /not an enabled server/);
  await registry.close();
});

test('bundles give an agent tools by name, each once', async () => {
  const { transport } = harness({ crm: ['find_customer', 'update_customer'], docs: ['search', 'fetch'] });
  const registry = new McpRegistry(
    {
      servers: { crm: { command: 'crm' }, docs: { command: 'docs' } },
      bundles: { support: ['crm/find_*', 'docs'], research: ['docs/search', 'docs/search'] },
    },
    { transport },
  );
  assert.deepEqual(registry.bundleNames(), ['support', 'research']);
  assert.deepEqual(
    (await registry.tools('support')).map((item) => item.name),
    ['crm_find_customer', 'docs_search', 'docs_fetch'],
  );
  assert.deepEqual(
    (await registry.tools(['research', 'support'])).map((item) => item.name),
    ['docs_search', 'crm_find_customer', 'docs_fetch'],
  );
  assert.throws(
    () => new McpRegistry({ servers: { crm: { command: 'crm' } }, bundles: { broken: ['billing/charge'] } }),
    /names "billing", which is not an enabled server/,
  );
  await registry.close();
});

test('credentials come from the environment by placeholder, and a missing one is named, not shown', async () => {
  const { transport, seen } = harness({ crm: ['find_customer'], api: ['call'] });
  const registry = new McpRegistry(
    {
      servers: {
        crm: { command: 'crm-mcp', args: ['--region', ref('REGION')], env: { CRM_TOKEN: ref('CRM_TOKEN') } },
        api: { url: `https://${ref('API_HOST')}/mcp`, headers: { authorization: `Bearer ${ref('API_KEY')}` } },
      },
    },
    { transport, env: { REGION: 'eu', CRM_TOKEN: 'secret-token', API_HOST: 'api.test' } },
  );
  await registry.tools('crm');
  assert.deepEqual(seen.get('crm')?.args, ['--region', 'eu']);
  assert.equal(seen.get('crm')?.env?.CRM_TOKEN, 'secret-token');
  const error = await registry.tools('api').catch((caught: unknown) => caught);
  assert.ok(error instanceof McpRegistryError);
  assert.equal(error.server, 'api');
  assert.match(error.message, /API_KEY, which is not set/);
  assert.doesNotMatch(error.message, /secret/);
  await registry.close();
});

test('health reports each server, and a failing one does not fail the check', async () => {
  const { transport, closed } = harness({ good: ['a', 'b'], bad: ['c'] }, ['bad']);
  const registry = new McpRegistry({ servers: { good: { command: 'good' }, bad: { command: 'bad' } } }, { transport });
  const health = await registry.health();
  assert.deepEqual(
    health.map((item) => [item.name, item.ok, item.tools ?? item.error]),
    [
      ['good', true, 2],
      ['bad', false, 'bad is down'],
    ],
  );
  assert.ok(health.every((item) => item.latencyMs >= 0));
  registry.refresh();
  assert.equal((await registry.tools('good')).length, 2);
  await registry.close();
  assert.equal(closed(), 2, 'close closes every client');
});

test('a configuration file loads, and a bad configuration is refused with the field at fault', async () => {
  const file = path.join(work, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { files: { command: 'files-mcp', args: ['/data'] } } }));
  const { transport } = harness({ files: ['read_file'] });
  const registry = await McpRegistry.fromFile(file, { transport });
  assert.deepEqual(
    (await registry.tools()).map((item) => item.name),
    ['files_read_file'],
  );
  await registry.close();

  writeFileSync(file, '{ not json');
  await assert.rejects(McpRegistry.fromFile(file), /not valid JSON/);
  assert.throws(() => validateMcpConfig([]), /is an object/);
  assert.throws(() => validateMcpConfig({}), /no "servers"/);
  assert.throws(() => validateMcpConfig({ servers: {}, mcpServers: {} }), /not both/);
  assert.throws(
    () => validateMcpConfig({ servers: { x: { command: 'a', url: 'b' } } }),
    /exactly one of "command" and "url"/,
  );
  assert.throws(() => validateMcpConfig({ servers: { 'bad name': { command: 'a' } } }), /not a valid server name/);
  assert.throws(
    () => validateMcpConfig({ servers: { x: { command: 'a', args: [1] } } }),
    /"args" is a list of strings/,
  );
  assert.throws(
    () => validateMcpConfig({ servers: { x: { command: 'a', env: { A: 1 } } } }),
    /"env" maps names to strings/,
  );
  assert.throws(() => validateMcpConfig({ servers: { x: { command: 'a' } }, bundles: { b: 'x' } }), /Bundle "b"/);
});

test('a local server inherits only what a process needs to run, never this process’s secrets', async () => {
  const host = {
    PATH: '/usr/bin',
    HOME: '/home/ada',
    LC_ALL: 'C.UTF-8',
    http_proxy: 'http://proxy.internal:3128',
    SystemRoot: 'C:/Windows',
    OPENAI_API_KEY: 'sk-secret',
    DATABASE_URL: 'postgres://user:pass@db/prod',
    GITHUB_TOKEN: 'ghp-secret',
  };
  assert.deepEqual(Object.keys(serverEnvironment(host, { env: { TOKEN: 'given' } })).sort(), [
    'HOME',
    'LC_ALL',
    'PATH',
    'SystemRoot',
    'TOKEN',
    'http_proxy',
  ]);
  assert.equal(
    serverEnvironment(host, { inheritEnv: ['github_token'] }).GITHUB_TOKEN,
    'ghp-secret',
    'names compare without case',
  );
  assert.equal(serverEnvironment(host, { inheritEnv: true }).OPENAI_API_KEY, 'sk-secret');
  assert.deepEqual(serverEnvironment(host, { inheritEnv: false, env: { ONLY: '1' } }), { ONLY: '1' });
  assert.throws(() => validateMcpConfig({ servers: { x: { command: 'x', inheritEnv: 'yes' } } }), /inheritEnv/);

  // A real child process, started by the transport, reports what it sees.
  process.env.NEXUS_TEST_HOST_SECRET = 'must-not-leak';
  try {
    const report = `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'env', params: { secret: process.env.NEXUS_TEST_HOST_SECRET ?? null, given: process.env.GIVEN ?? null, path: Boolean(process.env.PATH || process.env.Path) } }) + '\\n')`;
    const seen = async (options: { inheritEnv?: boolean }) => {
      const transport = createStdioTransport({
        command: process.execPath,
        args: ['-e', report],
        env: { GIVEN: 'yes' },
        ...options,
      });
      const message = new Promise<JsonRpcMessage>((resolve) => transport.onMessage(resolve));
      await transport.start?.();
      const received = (await message) as { params: Record<string, unknown> };
      await transport.close?.();
      return received.params;
    };
    assert.deepEqual(await seen({}), { secret: null, given: 'yes', path: true });
    assert.deepEqual(await seen({ inheritEnv: true }), { secret: 'must-not-leak', given: 'yes', path: true });
  } finally {
    delete process.env.NEXUS_TEST_HOST_SECRET;
  }
});
