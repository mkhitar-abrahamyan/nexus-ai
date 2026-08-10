import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const MAX_PACKED_BYTES = 320_000;
const MAX_UNPACKED_BYTES = 2_000_000;
mkdirSync(packDir);
mkdirSync(consumerDir);
let keepTempDir = false;

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
    'ROADMAP.md',
    'SECURITY.md',
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
      /^(?:assets|examples|src|tests)\//.test(packedPath),
      false,
      `packed tarball should not include repository-only file ${packedPath}`,
    );
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
  console.log('Clean production install smoke test passed.');
} catch (error) {
  keepTempDir = true;
  console.error(`Clean install fixture kept at ${tempRoot}`);
  throw error;
} finally {
  if (!keepTempDir) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
