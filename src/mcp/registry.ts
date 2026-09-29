import type { ToolDefinition } from '../types/messages.js';
import { createHttpTransport, createStdioTransport, McpClient, type McpClientOptions } from './client.js';
import type { McpTransport } from './protocol.js';

/**
 * One MCP server in a registry: a `command` to run over stdio, or a `url` to reach over HTTP. Any
 * string may hold `${NAME}` placeholders, filled from the environment when the server connects, so a
 * configuration file names credentials without containing them.
 */
export interface McpServerConfig {
  /** The executable of a local server, run over stdio. */
  command?: string;
  /** Its arguments. */
  args?: string[];
  /** Environment variables for the process, such as an API token. */
  env?: Record<string, string>;
  /** Working directory for the process. */
  cwd?: string;
  /** The endpoint of a remote server, reached over HTTP. */
  url?: string;
  /** Headers sent to a remote server, such as authorization. */
  headers?: Record<string, string>;
  /**
   * Tools offered to agents, by name; `*` matches any run of characters, so `list_*` allows every
   * listing tool. Defaults to every tool the server has.
   */
  allowTools?: string[];
  /** Tools never offered, in the same pattern syntax. A denied tool stays denied even when allowed. */
  denyTools?: string[];
  /** Prefix of the tool names agents see, so two servers' `search` stay apart. Defaults to the server's name; `false` keeps names as they are. */
  prefix?: string | false;
  /** How long a request to this server waits. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** `false` keeps the server in the file but out of the registry. */
  enabled?: boolean;
}

/**
 * A registry's configuration: the servers by name, and named bundles of their tools. `mcpServers` is
 * accepted in place of `servers`, so the configuration file desktop MCP clients use works as it is.
 */
export interface McpRegistryConfig {
  /** The servers, by name. */
  servers?: Record<string, McpServerConfig>;
  /** The same, under the name desktop MCP clients use. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Tool bundles an agent receives by name. Each entry is a server's name, for all its allowed tools,
   * or `server/tool`, where the tool may be a pattern such as `github/list_*`.
   */
  bundles?: Record<string, string[]>;
}

/** Options for an `McpRegistry`. */
export interface McpRegistryOptions {
  /** Where `${NAME}` placeholders are read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Name and version the clients report in the handshake. */
  clientInfo?: McpClientOptions['clientInfo'];
  /** Replaces the global `fetch` for HTTP servers. */
  fetch?: typeof globalThis.fetch;
  /** Builds a server's transport, for a custom transport or tests. Defaults to stdio or HTTP by the configuration. */
  transport?: (name: string, config: McpServerConfig) => McpTransport;
}

/** One server's health, from `McpRegistry.health()`. */
export interface McpServerHealth {
  /** The server's name. */
  name: string;
  /** Whether it connected and listed its tools. */
  ok: boolean;
  /** How long connecting and listing took, in milliseconds. */
  latencyMs: number;
  /** Tools it offers after the allow and deny lists. */
  tools?: number;
  /** What went wrong, when it is not healthy. */
  error?: string;
}

/** Raised for a configuration the registry cannot use, or a server or bundle it does not know. */
export class McpRegistryError extends Error {
  constructor(
    message: string,
    /** The server concerned, when there is one. */
    readonly server?: string,
  ) {
    super(message);
    this.name = 'McpRegistryError';
  }
}

/**
 * Many MCP servers behind one configuration. Servers connect on first use and stay connected; each
 * one's allow and deny lists decide which tools agents see; and `tools()` hands an agent a bundle,
 * a server, or everything, by name.
 *
 * This is the integration catalogue: rather than shipping adapters for every SaaS product, the
 * package reaches whatever an MCP server exposes, under your policy.
 */
export class McpRegistry {
  private readonly servers: Map<string, McpServerConfig>;
  private readonly bundles: Record<string, string[]>;
  private readonly clients = new Map<string, McpClient>();
  private readonly toolCache = new Map<string, Promise<Array<{ original: string; tool: ToolDefinition }>>>();

  constructor(
    config: McpRegistryConfig,
    private readonly options: McpRegistryOptions = {},
  ) {
    const validated = validateMcpConfig(config);
    this.servers = new Map(
      Object.entries(validated.servers ?? validated.mcpServers ?? {}).filter(([, server]) => server.enabled !== false),
    );
    this.bundles = validated.bundles ?? {};
    for (const [bundle, entries] of Object.entries(this.bundles)) {
      for (const entry of entries) {
        const server = entry.split('/')[0];
        if (!this.servers.has(server)) {
          throw new McpRegistryError(`Bundle "${bundle}" names "${server}", which is not an enabled server`, server);
        }
      }
    }
  }

  /** A registry from a JSON configuration file. */
  static async fromFile(path: string, options: McpRegistryOptions = {}): Promise<McpRegistry> {
    const { readFile } = await import('node:fs/promises');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new McpRegistryError(`${path} is not valid JSON: ${(error as Error).message}`);
    }
    return new McpRegistry(parsed as McpRegistryConfig, options);
  }

  /** The enabled servers' names. */
  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  /** The bundles' names. */
  bundleNames(): string[] {
    return Object.keys(this.bundles);
  }

  /** A server's client, created on first use. It connects on its first request. */
  client(name: string): McpClient {
    const config = this.servers.get(name);
    if (!config) throw new McpRegistryError(`"${name}" is not an enabled server`, name);
    let client = this.clients.get(name);
    if (!client) {
      const resolved = resolvePlaceholders(name, config, this.options.env ?? process.env);
      const transport = this.options.transport
        ? this.options.transport(name, resolved)
        : resolved.command
          ? createStdioTransport({
              command: resolved.command,
              ...(resolved.args ? { args: resolved.args } : {}),
              ...(resolved.env ? { env: resolved.env } : {}),
              ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
            })
          : createHttpTransport({
              url: resolved.url as string,
              ...(resolved.headers ? { headers: resolved.headers } : {}),
              ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
            });
      client = new McpClient(transport, {
        ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      });
      this.clients.set(name, client);
    }
    return client;
  }

  /**
   * Tools for an agent. Each name is a bundle or a server; with none, every enabled server's allowed
   * tools. A tool named by two entries appears once. Each server's tool list is read once and kept;
   * `refresh()` reads it again.
   */
  async tools(names?: string | readonly string[]): Promise<ToolDefinition[]> {
    const requested = names === undefined ? this.serverNames() : typeof names === 'string' ? [names] : [...names];
    const entries = requested.flatMap((name) => {
      if (this.bundles[name]) return this.bundles[name];
      if (this.servers.has(name)) return [name];
      throw new McpRegistryError(`"${name}" is neither a bundle nor an enabled server`);
    });
    const picked = new Map<string, ToolDefinition>();
    for (const entry of entries) {
      const [server, pattern] = splitEntry(entry);
      for (const { original, tool } of await this.serverTools(server)) {
        if (!pattern || matches(pattern, original)) picked.set(tool.name, tool);
      }
    }
    return [...picked.values()];
  }

  /** Forgets the tool lists read so far, for servers whose tools change. */
  refresh(): void {
    this.toolCache.clear();
  }

  /**
   * Connects to every server and lists its tools, in parallel, reporting each one's health. A server
   * that fails does not fail the check; it is reported unhealthy with the reason.
   */
  async health(): Promise<McpServerHealth[]> {
    return Promise.all(
      this.serverNames().map(async (name) => {
        const started = Date.now();
        try {
          this.toolCache.delete(name);
          const tools = await this.serverTools(name);
          return { name, ok: true, latencyMs: Date.now() - started, tools: tools.length };
        } catch (error) {
          return {
            name,
            ok: false,
            latencyMs: Date.now() - started,
            error: (error as Error)?.message ?? String(error),
          };
        }
      }),
    );
  }

  /** Closes every connection. */
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.toolCache.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  private serverTools(name: string): Promise<Array<{ original: string; tool: ToolDefinition }>> {
    let cached = this.toolCache.get(name);
    if (!cached) {
      const config = this.servers.get(name) as McpServerConfig;
      const prefix = config.prefix === false ? '' : sanitize(config.prefix ?? name);
      cached = this.client(name)
        .toNexusTools()
        .then((tools) =>
          tools
            .filter(
              (tool) =>
                (!config.allowTools || config.allowTools.some((pattern) => matches(pattern, tool.name))) &&
                !config.denyTools?.some((pattern) => matches(pattern, tool.name)),
            )
            .map((tool) => ({
              original: tool.name,
              tool: { ...tool, name: prefix ? `${prefix}_${tool.name}` : tool.name },
            })),
        );
      cached.catch(() => this.toolCache.delete(name));
      this.toolCache.set(name, cached);
    }
    return cached;
  }
}

/**
 * Checks a registry configuration and returns it, or throws an `McpRegistryError` that names the
 * server and the field at fault.
 */
export function validateMcpConfig(value: unknown): McpRegistryConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpRegistryError('An MCP registry configuration is an object');
  }
  const config = value as McpRegistryConfig;
  if (config.servers && config.mcpServers) throw new McpRegistryError('Give "servers" or "mcpServers", not both');
  const servers = config.servers ?? config.mcpServers;
  if (!servers || typeof servers !== 'object') throw new McpRegistryError('The configuration has no "servers"');
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new McpRegistryError(`"${name}" is not a valid server name`, name);
    if (!server || typeof server !== 'object') throw new McpRegistryError(`Server "${name}" is not an object`, name);
    if (Boolean(server.command) === Boolean(server.url)) {
      throw new McpRegistryError(`Server "${name}" needs exactly one of "command" and "url"`, name);
    }
    for (const field of ['args', 'allowTools', 'denyTools'] as const) {
      const list = server[field];
      if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === 'string'))) {
        throw new McpRegistryError(`Server "${name}": "${field}" is a list of strings`, name);
      }
    }
    for (const field of ['env', 'headers'] as const) {
      const map = server[field];
      if (
        map !== undefined &&
        !(typeof map === 'object' && Object.values(map).every((item) => typeof item === 'string'))
      ) {
        throw new McpRegistryError(`Server "${name}": "${field}" maps names to strings`, name);
      }
    }
  }
  for (const [bundle, entries] of Object.entries(config.bundles ?? {})) {
    if (!(Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'))) {
      throw new McpRegistryError(`Bundle "${bundle}" is a list of server or server/tool names`);
    }
  }
  return config;
}

/** Fills `${NAME}` placeholders from the environment. A missing variable is named, never its value. */
function resolvePlaceholders(
  name: string,
  config: McpServerConfig,
  env: Record<string, string | undefined>,
): McpServerConfig {
  const fill = (text: string) =>
    text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      const value = env[variable];
      if (value === undefined) {
        throw new McpRegistryError(
          `Server "${name}" needs the environment variable ${variable}, which is not set`,
          name,
        );
      }
      return value;
    });
  const fillMap = (map?: Record<string, string>) =>
    map && Object.fromEntries(Object.entries(map).map(([key, item]) => [key, fill(item)]));
  return {
    ...config,
    ...(config.command ? { command: fill(config.command) } : {}),
    ...(config.args ? { args: config.args.map(fill) } : {}),
    ...(config.env ? { env: fillMap(config.env) } : {}),
    ...(config.cwd ? { cwd: fill(config.cwd) } : {}),
    ...(config.url ? { url: fill(config.url) } : {}),
    ...(config.headers ? { headers: fillMap(config.headers) } : {}),
  };
}

function splitEntry(entry: string): [string, string | undefined] {
  const slash = entry.indexOf('/');
  return slash < 0 ? [entry, undefined] : [entry.slice(0, slash), entry.slice(slash + 1)];
}

function matches(pattern: string, name: string): boolean {
  const expression = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${expression.join('.*')}$`).test(name);
}

/** A prefix a model accepts in a tool name: letters, digits, `_`, and `-`. */
function sanitize(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9_-]/g, '_');
}
