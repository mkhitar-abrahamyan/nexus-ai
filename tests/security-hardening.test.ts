import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { BaseProvider } from '../src/providers/base.js';
import { protectStreamOutput } from '../src/core/secure-stream.js';
import { AuditLogger } from '../src/ops/audit-logger.js';
import { SecurityPipeline, NexusSecurityError } from '../src/security/index.js';
import { createFetchUrlTool } from '../src/connectors/web.js';
import type { CompletionRequest, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../src/types/response.js';

function executeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  if (!tool.execute) {
    return Promise.reject(new Error(`Tool ${tool.name} is not executable.`));
  }
  return Promise.resolve(tool.execute(args));
}

function response(content: string): NexusResponse {
  return {
    content,
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'security-regression',
      providerUsed: 'mock',
      modelUsed: 'mock/model',
      latencyMs: 1,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      estimatedCost: '$0.00',
      cacheHit: false,
      guardrailsApplied: [],
    },
  };
}

function streamOf(chunks: StreamChunk[], onChunk?: () => void): NexusStream {
  let aborted = false;
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (aborted) return;
        onChunk?.();
        yield chunk;
      }
    },
    abort() {
      aborted = true;
    },
  };
}

class ForbiddenOutputProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };

  async complete(_request: CompletionRequest): Promise<NexusResponse> {
    return response('A configured forbidden phrase escaped the provider.');
  }

  stream(_request: CompletionRequest): NexusStream {
    return streamOf([{ type: 'done' }]);
  }
}

class SafeOutputProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };

  async complete(_request: CompletionRequest): Promise<NexusResponse> {
    return response('Safe provider output.');
  }

  stream(_request: CompletionRequest): NexusStream {
    return streamOf([{ type: 'done' }]);
  }
}

test('output moderation preserves flag/redact semantics and makes block non-observable', () => {
  const protect = (onViolation: 'flag' | 'redact' | 'block') =>
    new SecurityPipeline({
      level: 'standard',
      output: {
        piiRedaction: false,
        moderation: { enabled: true, forbiddenTerms: ['internal launch'], onViolation },
      },
    }).protectOutput(response('Discuss the internal launch tomorrow.'));

  const flagged = protect('flag');
  assert.equal(flagged.ok, true);
  assert.equal(flagged.value.content, 'Discuss the internal launch tomorrow.');

  const redacted = protect('redact');
  assert.equal(redacted.ok, true);
  assert.equal(redacted.value.content, 'Discuss the [REDACTED] tomorrow.');

  const blocked = protect('block');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.value.content, '[BLOCKED_BY_OUTPUT_GUARD]');
  assert.doesNotMatch(JSON.stringify(blocked), /internal launch/i);
  const security = new SecurityPipeline({ level: 'standard' });
  assert.throws(
    () => security.assertOutputSafe(blocked),
    (error: unknown) => {
      assert.ok(error instanceof NexusSecurityError);
      assert.doesNotMatch(error.message, /internal launch/i);
      return true;
    },
  );

  const diagnostic = new NexusSecurityError([
    {
      type: 'dlp',
      severity: 'critical',
      message: 'Blocked diagnostic',
      metadata: { sessionToken: 'opaque-session-token', tokensInput: 17 },
    },
  ]);
  assert.equal(diagnostic.findings[0]?.metadata?.sessionToken, '[REDACTED]');
  assert.equal(diagnostic.findings[0]?.metadata?.tokensInput, 17);
});

test('NexusAI blocks configured output and sanitizes the thrown findings', async () => {
  const { NexusAI } = await import('../src/core/nexus.js');
  const ai = new NexusAI({
    providers: {},
    security: {
      level: 'standard',
      input: {
        injectionDetection: { enabled: false },
        pii: { enabled: false },
        secrets: { enabled: false },
        urls: { enabled: false },
      },
      output: {
        moderation: {
          enabled: true,
          forbiddenTerms: ['forbidden phrase'],
          onViolation: 'block',
        },
      },
    },
  });
  ai.registerProvider('mock', new ForbiddenOutputProvider());

  await assert.rejects(
    ai.complete({ model: 'mock/model', messages: [{ role: 'user', content: 'hello' }] }),
    (error: unknown) => {
      assert.ok(error instanceof NexusSecurityError);
      assert.doesNotMatch(error.message, /forbidden phrase/i);
      assert.equal(error.findings[0]?.value, '[REDACTED]');
      return true;
    },
  );
});

test('NexusAI rechecks output after beforeReturn hooks', async () => {
  const { NexusAI } = await import('../src/core/nexus.js');
  const ai = new NexusAI({
    providers: {},
    pipeline: {
      hooks: {
        beforeReturn: (context) => {
          if (!context.response) return context;
          return { ...context.response, content: 'A hook inserted a forbidden phrase.' };
        },
      },
    },
    security: {
      level: 'standard',
      input: {
        injectionDetection: { enabled: false },
        pii: { enabled: false },
        secrets: { enabled: false },
        urls: { enabled: false },
      },
      output: {
        moderation: {
          enabled: true,
          forbiddenTerms: ['forbidden phrase'],
          onViolation: 'block',
        },
      },
    },
  });
  ai.registerProvider('mock', new SafeOutputProvider());

  await assert.rejects(
    ai.complete({ model: 'mock/model', messages: [{ role: 'user', content: 'hello' }] }),
    NexusSecurityError,
  );
});

test('stream protection never emits PII split across provider chunks', async () => {
  const security = new SecurityPipeline({ level: 'standard', output: { piiRedaction: true } });
  let consumed = 0;
  const source = streamOf(
    [
      { type: 'text', content: 'Contact ali' },
      { type: 'text', content: 'ce@example' },
      { type: 'text', content: '.com for help.' },
      { type: 'done', meta: { requestId: 'stream-regression' } },
    ],
    () => {
      consumed += 1;
    },
  );

  const protectedStream = protectStreamOutput(source, security);
  const iterator = protectedStream[Symbol.asyncIterator]();
  const first = await iterator.next();

  assert.equal(consumed, 4, 'the full provider output must be guarded before the first downstream yield');
  const chunks: StreamChunk[] = first.done ? [] : [first.value];
  for (;;) {
    const item = await iterator.next();
    if (item.done) break;
    chunks.push(item.value);
  }

  const text = chunks
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => chunk.content || '')
    .join('');
  assert.equal(text, 'Contact [REDACTED] for help.');
  assert.doesNotMatch(text, /alice|example\.com/i);
});

test('stream protection blocks a moderation match split across chunks', async () => {
  const security = new SecurityPipeline({
    level: 'standard',
    output: {
      moderation: { enabled: true, forbiddenTerms: ['do not emit'], onViolation: 'block' },
    },
  });
  const source = streamOf([{ type: 'text', content: 'do not ' }, { type: 'text', content: 'emit' }, { type: 'done' }]);

  await assert.rejects(async () => {
    for await (const _chunk of protectStreamOutput(source, security)) {
      assert.fail('blocked output must not yield a chunk');
    }
  }, NexusSecurityError);
});

test('stream protection does not release buffered output after the request signal aborts', async () => {
  const security = new SecurityPipeline({ level: 'standard' });
  const controller = new AbortController();
  let consumed = 0;
  const source = streamOf([{ type: 'text', content: 'partial output' }, { type: 'done' }], () => {
    consumed += 1;
    if (consumed === 1) controller.abort();
  });

  const chunks: StreamChunk[] = [];
  for await (const chunk of protectStreamOutput(source, security, controller.signal)) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, []);
});

test('aborting a protected stream stops replaying already validated chunks', async () => {
  const security = new SecurityPipeline({ level: 'standard' });
  const protectedStream = protectStreamOutput(
    streamOf([{ type: 'text', content: 'first' }, { type: 'text', content: 'second' }, { type: 'done' }]),
    security,
  );
  const iterator = protectedStream[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.content, 'first');
  protectedStream.abort();
  assert.equal((await iterator.next()).done, true);
});

test('audit logging removes finding values and secrets unless explicitly opted in', async () => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const events: unknown[] = [];
  const event = {
    type: 'blocked' as const,
    timestamp: new Date(0).toISOString(),
    metadata: {
      findings: [{ type: 'secret', value: secret }],
      email: 'alice@example.com',
      authorization: `Bearer ${secret}`,
      token: 'opaque-token-value-12345',
      sessionToken: 'opaque-session-value-67890',
      tokensInput: 17,
    },
  };

  await new AuditLogger({
    enabled: true,
    sink: (value) => {
      events.push(value);
    },
  }).log(event);
  const safeJson = JSON.stringify(events[0]);
  assert.doesNotMatch(safeJson, new RegExp(secret));
  assert.doesNotMatch(safeJson, /alice@example\.com/);
  assert.doesNotMatch(safeJson, /opaque-token-value-12345|opaque-session-value-67890/);
  assert.match(safeJson, /\[REDACTED\]/);
  assert.match(safeJson, /"tokensInput":17/);

  const rawEvents: unknown[] = [];
  await new AuditLogger({
    enabled: true,
    includeSensitiveData: true,
    sink: (value) => {
      rawEvents.push(value);
    },
  }).log(event);
  assert.match(JSON.stringify(rawEvents[0]), new RegExp(secret));
});

test('fetch_url rejects private, metadata, and private DNS answers by default', async () => {
  const privateTool = createFetchUrlTool();
  await assert.rejects(executeTool(privateTool, { url: 'http://127.0.0.1/admin' }), /non-public|private|loopback/i);

  const metadataTool = createFetchUrlTool({ allowPrivateNetworks: true });
  await assert.rejects(executeTool(metadataTool, { url: 'http://169.254.169.254/latest/meta-data' }), /metadata/i);

  for (const address of ['169.254.170.23', 'fd00:ec2::23', 'fd20:ce::254']) {
    const credentialEndpointTool = createFetchUrlTool({
      allowPrivateNetworks: true,
      resolveHostname: async () => [address],
    });
    await assert.rejects(
      executeTool(credentialEndpointTool, { url: 'https://public.example/credentials' }),
      /metadata/i,
    );
  }

  const rebindingTool = createFetchUrlTool({
    resolveHostname: async () => ['10.0.0.8'],
  });
  await assert.rejects(executeTool(rebindingTool, { url: 'https://public.example/resource' }), /non-public|private/i);
});

test('fetch_url validates redirects and enforces a response byte cap', async (context) => {
  const server = createServer((request, response_) => {
    if (request.url === '/redirect') {
      response_.writeHead(302, { location: '/large' });
      response_.end();
      return;
    }
    if (request.url === '/bad-redirect') {
      response_.writeHead(302, { location: 'http://localhost/private' });
      response_.end();
      return;
    }
    response_.writeHead(200, { 'content-type': 'text/plain' });
    response_.end('x'.repeat(2_000));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const fetchTool = createFetchUrlTool({
    allowedDomains: ['127.0.0.1'],
    allowPrivateNetworks: true,
    maxResponseBytes: 32,
  });

  const result = (await executeTool(fetchTool, { url: `${baseUrl}/redirect` })) as {
    url: string;
    status: number;
    text: string;
    truncated: boolean;
  };
  assert.equal(result.status, 200);
  assert.equal(result.text, 'x'.repeat(32));
  assert.equal(Buffer.byteLength(result.text), 32);
  assert.equal(result.truncated, true);
  assert.match(result.url, /\/large$/);

  await assert.rejects(executeTool(fetchTool, { url: `${baseUrl}/bad-redirect` }), /not allowed/i);
});

test('scan JSON redacts raw secret and PII finding values', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-security-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sensitive.txt');
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  await writeFile(file, `${secret}\nalice@example.com\n`, 'utf8');

  const cli = spawnSync(process.execPath, ['dist/cli.js', 'scan', file, '--json', '--no-fail'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.doesNotMatch(cli.stdout, new RegExp(secret));
  assert.doesNotMatch(cli.stdout, /alice@example\.com/);
  assert.match(cli.stdout, /\[REDACTED\]/);
});
