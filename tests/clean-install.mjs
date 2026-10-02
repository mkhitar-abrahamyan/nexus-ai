import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmNeedsShell = !npmCli && process.platform === 'win32';
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCache = path.join(repoRoot, '.tmp-nexus-ai-tests', 'npm-cache');
const tempParent = path.resolve(repoRoot, '..', '.tmp-nexus-ai-tests');
mkdirSync(npmCache, { recursive: true });
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(path.join(tempParent, 'clean-install-'));
const packDir = path.join(tempRoot, 'pack');
const consumerDir = path.join(tempRoot, 'consumer');
// The package ships parallel ESM and CommonJS builds, so the JS payload is carried twice.
// Raised in 1.4.0 for the capability-negotiation and usage modules, the expanded provider parameter
// mapping, and the added registry capability data. Raised again in 1.5.0 for the embeddings
// operation family: a manager, five adapters, a model registry, a mock, a conformance harness, and
// their declarations, all carried in both builds. The headroom is deliberately small so accidental
// bloat still fails here; raise it only alongside a change that explains the growth. Raised once
// more for the durable operations family: a runner, a state machine, two stores, a dispatcher, and
// webhook helpers, again carried in both builds. Raised again in 1.7.0 for the provider batch
// family, the filesystem and S3 asset stores, and the resilience modules. The generated model
// registry is deliberately NOT shipped: it duplicates KNOWN_MODELS byte for byte, and carrying it
// in both builds plus its JSON source cost ~310KB unpacked for data no consumer reads. Raised in
// 1.10.0 for image portability: the Imagen and ComfyUI adapters, mask transformation with a PNG
// codec, input resolution, visual moderation, and media evals — about 200KB unpacked across both
// builds and their declarations, all opt-in subpaths that the root import never loads.
// Raised again for parallel graphs: concurrent supersteps, Send fan-out, and per-node retry and
// timeout policies — about 65KB unpacked across both builds and their declarations. Raised again
// in 1.12.0 for graph commands, breakpoints, state editing and forks, run events, and the Mermaid
// visualizer, plus the README documentation for them.
// Raised again in 1.14.0 for long-term memory (the store and its Redis adapter), agents on graphs,
// MCP in both directions, and the tracing family, all opt-in subpaths the root import never loads.
// Raised again for the evaluation family: datasets, evaluators, experiment comparison, online
// evaluation, and review queues, on their own subpath.
// Raised again in 1.16.0 for the Postgres adapters, shared circuit state, record and replay, and doc
// comments on every public declaration. The comments are stripped from the emitted JavaScript, so
// runtime code shrank; the growth is in the type declarations, which carry the docs to editors and
// are shipped once for ESM and once for CommonJS.
// Raised again in 1.18.0 for the agent server and its guide. The declarations are still shipped once
// per module format, which is the item the roadmap carries.
// Raised again in 1.21.0 for functional workflows, the SQLite adapters, and the SVG renderer: four new
// subpaths, each dependency-free. The packed size still fits the earlier ceiling.
// Raised again in 1.22.0 for retrieval breadth: nine loader entry points, five vector stores, the
// retrievers, and the MCP registry — sixteen subpaths, each dependency-free and never loaded by the root.
// Raised again in 1.23.0 for the context hub, insights, and evaluation caching: two subpaths and a
// module of the evaluation family, never loaded by the root.
// Raised again in 1.24.0 for deployment at scale: the deployments and tenancy subpaths, the server's
// worker queue, draining, and metrics, and `nexus deploy`. The deploy/ templates are not shipped.
// Raised again in 1.25.0 for the bridge to 2.0: a deprecation note on each of the 499 root exports
// that move, carried in both declaration builds; `nexus migrate` and its map; nine entry points; and
// MIGRATING.md. The notes go when 2.0 drops those exports from the root.
const MAX_PACKED_BYTES = 900_000;
const MAX_UNPACKED_BYTES = 5_650_000;
// What a consumer actually installs: this package plus the dependencies it forces on them. Until 2.0
// that was about 7 MB of `zod`, `ajv`, and `@types/node` on top of the package, for 12.3 MB in all.
// 2.0 made all three optional peers, so a production install is the package alone, and this ceiling
// came down from 13 MB to hold that.
const MAX_INSTALLED_BYTES = 6_000_000;
mkdirSync(packDir);
mkdirSync(consumerDir);
let keepTempDir = false;

function directorySize(directory) {
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directorySize(full);
    else if (entry.isFile()) bytes += statSync(full).size;
  }
  return bytes;
}

function npmEnv() {
  return {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_cache: npmCache,
    npm_config_fetch_retries: '1',
    npm_config_fetch_timeout: '30000',
    npm_config_fund: 'false',
    npm_config_prefer_offline: 'true',
    npm_config_dry_run: 'false',
  };
}

function run(command, args, cwd, options = {}) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: npmEnv(),
    ...options,
  });
}

function runNpm(args, cwd, options = {}) {
  run(npmCommand, npmCli ? [npmCli, ...args] : args, cwd, {
    shell: npmNeedsShell,
    ...options,
  });
}

try {
  const packOutput = execFileSync(
    npmCommand,
    npmCli
      ? [npmCli, 'pack', '--json', '--pack-destination', packDir]
      : ['pack', '--json', '--pack-destination', packDir],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: npmEnv(),
      shell: npmNeedsShell,
    },
  );
  const [packed] = JSON.parse(packOutput);
  const packedPaths = new Set(packed.files.map((file) => file.path));
  assert.ok(
    packed.size < MAX_PACKED_BYTES,
    `packed tarball should stay below ${MAX_PACKED_BYTES} bytes, received ${packed.size}`,
  );
  assert.ok(
    packed.unpackedSize < MAX_UNPACKED_BYTES,
    `unpacked package should stay below ${MAX_UNPACKED_BYTES} bytes, received ${packed.unpackedSize}`,
  );
  for (const requiredPath of [
    'README.md',
    'SECURITY.md',
    'API_STABILITY.md',
    'CHANGELOG.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/images/index.js',
    'dist/images/index.d.ts',
    'dist/images/openai.js',
    'dist/images/openai.d.ts',
    'dist/realtime/index.js',
    'dist/realtime/index.d.ts',
    'dist/telephony/realtime-bridge.js',
    'dist/telephony/realtime-bridge.d.ts',
    'dist-cjs/package.json',
    'dist-cjs/index.js',
    'dist-cjs/realtime/index.js',
    'dist-cjs/telephony/realtime-bridge.js',
  ]) {
    assert.ok(packedPaths.has(requiredPath), `packed tarball should include ${requiredPath}`);
  }
  for (const packedPath of packedPaths) {
    assert.equal(
      /^(?:assets|data|examples|scripts|src|tests)\//.test(packedPath),
      false,
      `packed tarball should not include repository-only file ${packedPath}`,
    );
  }
  // ROADMAP is a design proposal and NEXUS was a duplicate of the README; both are GitHub-only, so
  // an installer does not carry them.
  for (const repositoryOnlyDoc of ['ROADMAP.md', 'NEXUS.md', 'EXPLANATION.md', 'CONTRIBUTING.md', 'RELEASING.md']) {
    assert.equal(packedPaths.has(repositoryOnlyDoc), false, `packed tarball should not include ${repositoryOnlyDoc}`);
  }
  const tarball = path.join(packDir, packed.filename);

  runNpm(['init', '-y'], consumerDir);
  runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumerDir);

  const smokeScript = `
import assert from 'node:assert/strict';

const optionalPeers = ['openai', '@anthropic-ai/sdk', 'ollama', 'zod', 'ajv', 'ajv-formats'];
for (const specifier of optionalPeers) {
  try {
    await import(specifier);
    throw new Error(\`Optional peer dependency "\${specifier}" should not be installed by a production install\`);
  } catch (error) {
    if (error && error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
}

const imports = [
  ['nexus-ai-pro', ['NexusAI', 'createNexus', 'createNexusConfig', 'NexusProviderError', 'OperationLifecycle', 'toolOutput']],
  ['nexus-ai-pro/lifecycle', ['budgetLedger', 'OperationLifecycle']],
  ['nexus-ai-pro/graph', ['createGraph', 'MemoryGraphCheckpointer']],
  ['nexus-ai-pro/core', ['NexusAI']],
  ['nexus-ai-pro/config', ['NexusConfigBuilder', 'createNexusConfig']],
  ['nexus-ai-pro/providers/openai', ['OpenAIProvider']],
  ['nexus-ai-pro/providers/anthropic', ['AnthropicProvider']],
  ['nexus-ai-pro/providers/errors', ['NexusProviderError']],
  ['nexus-ai-pro/providers/ollama', ['OllamaProvider']],
  ['nexus-ai-pro/providers/deepseek', ['DeepSeekProvider']],
  ['nexus-ai-pro/cache/memory-cache', ['MemoryCache']],
  ['nexus-ai-pro/security', ['SecurityPipeline']],
  ['nexus-ai-pro/images', ['ImageManager']],
  ['nexus-ai-pro/images/assets', ['MemoryAssetStore']],
  ['nexus-ai-pro/images/mock', ['MockImageProvider']],
  ['nexus-ai-pro/images/openai', ['OpenAIImageProvider']],
  ['nexus-ai-pro/images/google', ['GoogleImageProvider']],
  ['nexus-ai-pro/images/comfyui', ['ComfyUIImageProvider']],
  ['nexus-ai-pro/images/transform', ['PngMaskTransformer', 'decodePng']],
  ['nexus-ai-pro/images/inputs', ['ImageInputResolver']],
  ['nexus-ai-pro/realtime', ['RealtimeSession', 'createRealtimeAgent', 'MockRealtimeTransport']],
  ['nexus-ai-pro/realtime/openai-webrtc', ['OpenAIWebRTCTransport']],
  ['nexus-ai-pro/realtime/openai-websocket', ['OpenAIWebSocketTransport']],
  ['nexus-ai-pro/jobs/batch', ['runBatch']],
  ['nexus-ai-pro/workflows', ['ragAnswer']],
];

for (const [specifier, exportNames] of imports) {
  const module = await import(specifier);
  for (const exportName of exportNames) {
    assert.ok(exportName in module, \`\${specifier} should export \${exportName}\`);
  }
}

// With nothing installed but this package, a graph runs and the client completes through its own
// lifecycle; a JSON Schema response format, which needs the optional ajv, says how to install it.
const { NexusAI } = await import('nexus-ai-pro');
const { BaseProvider } = await import('nexus-ai-pro/providers');
const { createGraph, lastValue } = await import('nexus-ai-pro/graph');
class Echo extends BaseProvider {
  info = { name: 'echo', isLocal: true };
  async complete(request) {
    const meta = { requestId: 'r', providerUsed: 'echo', modelUsed: request.model, latencyMs: 0, tokensInput: 1, tokensOutput: 1, tokensSaved: 0, cacheHit: false, guardrailsApplied: [] };
    return { content: '{"ok":true}', role: 'assistant', finishReason: 'stop', meta };
  }
  stream() {
    return { async *[Symbol.asyncIterator]() {}, abort() {} };
  }
}
const finished = [];
const ai = new NexusAI({
  providers: {},
  routing: { mode: 'direct' },
  defaultModel: 'echo/model',
  security: 'off',
  lifecycle: { hooks: { onFinish: (operation, outcome) => finished.push(\`\${operation.family}:\${outcome.status}\`) } },
});
ai.registerProvider('echo', new Echo());
const graph = createGraph({ channels: { answer: lastValue('') } })
  .addNode('ask', async () => ({ answer: (await ai.complete({ model: 'echo/model', messages: [{ role: 'user', content: 'hi' }] })).content }))
  .addEdge('__start__', 'ask')
  .addEdge('ask', '__end__')
  .compile({ lifecycle: ai.lifecycle });
const result = await graph.invoke({});
assert.equal(result.state.answer, '{"ok":true}');
assert.deepEqual(finished, ['completion:succeeded', 'graph:succeeded']);
await assert.rejects(
  () =>
    ai.complete({
      model: 'echo/model',
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    }),
  /needs ajv and ajv-formats, which are optional/,
);
`;
  const smokePath = path.join(consumerDir, 'smoke.mjs');
  writeFileSync(smokePath, smokeScript);
  run(process.execPath, [smokePath], consumerDir);

  runNpm(['exec', '--offline', '--', 'nexus', 'help'], consumerDir);
  for (const optional of ['zod', 'ajv', 'ajv-formats', '@types/node']) {
    assert.equal(
      existsSync(path.join(consumerDir, 'node_modules', optional)),
      false,
      `a production install should not bring in the optional peer ${optional}`,
    );
  }
  const installedBytes = directorySize(path.join(consumerDir, 'node_modules'));
  assert.ok(
    installedBytes < MAX_INSTALLED_BYTES,
    `a production install should stay below ${MAX_INSTALLED_BYTES} bytes of node_modules, received ${installedBytes}`,
  );
  await runDeployTemplate(consumerDir);
  console.log(
    `Clean production install smoke test passed. Installed size: ${(installedBytes / 1024 / 1024).toFixed(1)} MB of node_modules, of which ${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MB is this package.`,
  );
} catch (error) {
  keepTempDir = true;
  console.error(`Clean install fixture kept at ${tempRoot}`);
  throw error;
} finally {
  if (!keepTempDir) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Runs deploy/app/server.mjs — the template the Dockerfile, Compose file, and Helm chart all start —
 * against the installed tarball: it must come up, run a job, move traffic to another revision through
 * the deployments API, report metrics, and, where signals exist, drain and exit cleanly on SIGTERM.
 */
async function runDeployTemplate(directory) {
  for (const file of ['server.mjs', 'assistants.mjs']) {
    copyFileSync(path.join(repoRoot, 'deploy', 'app', file), path.join(directory, file));
  }
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: directory,
    env: { ...process.env, PORT: String(port), ROLE: 'all', REDIS_URL: '', DRAIN_TIMEOUT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;
  const send = (method, route, body) =>
    fetch(`${base}${route}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
  const runOnce = async () => {
    const accepted = await (await send('POST', '/runs', { assistant: 'support', input: { question: 'hi' } })).json();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await (await send('GET', `/runs/${accepted.id}`)).json();
      if (run.status === 'succeeded') return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`run ${accepted.id} did not finish`);
  };

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100 && !healthy; attempt += 1) {
      healthy = await send('GET', '/health').then(
        (response) => response.ok,
        () => false,
      );
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(healthy, `the template server should report healthy:\n${output}`);

    const first = await runOnce();
    assert.match(first.output.answer, /^v1:/);
    assert.equal(first.revision.id, '2026-09-01');
    const promoted = await send('POST', '/deployments/support', { action: 'promote', revision: '2026-09-30' });
    assert.equal(promoted.status, 200);
    const second = await runOnce();
    assert.match(second.output.answer, /^v2:/, 'a promotion reaches the next run without a restart');

    const metrics = await (await send('GET', '/metrics')).text();
    assert.match(metrics, /^nexus_server_queue_load /m);
    const scaling = await (await send('GET', '/scaling')).json();
    assert.equal(scaling.replica.capacity, 4);

    if (process.platform !== 'win32') {
      child.kill('SIGTERM');
      assert.equal(await exited, 0, `the template should drain and exit cleanly:\n${output}`);
      assert.match(output, /drained: /);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
