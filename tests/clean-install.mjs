import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const MAX_PACKED_BYTES = 760_000;
const MAX_UNPACKED_BYTES = 4_600_000;
// What a consumer actually installs: this package plus the dependencies it forces on them. Most of
// the difference from the unpacked size above is `zod`, `ajv`, and `@types/node`, which is why the
// README size table reports third-party install cost per entry point.
const MAX_INSTALLED_BYTES = 12_000_000;
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

const optionalPeers = ['openai', '@anthropic-ai/sdk', 'ollama'];
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
  ['nexus-ai-pro', ['NexusAI', 'createNexus', 'createNexusConfig', 'NexusProviderError', 'OpenAIProvider', 'AnthropicProvider', 'OllamaProvider']],
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
`;
  const smokePath = path.join(consumerDir, 'smoke.mjs');
  writeFileSync(smokePath, smokeScript);
  run(process.execPath, [smokePath], consumerDir);

  runNpm(['exec', '--offline', '--', 'nexus', 'help'], consumerDir);
  const installedBytes = directorySize(path.join(consumerDir, 'node_modules'));
  assert.ok(
    installedBytes < MAX_INSTALLED_BYTES,
    `a production install should stay below ${MAX_INSTALLED_BYTES} bytes of node_modules, received ${installedBytes}`,
  );
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
