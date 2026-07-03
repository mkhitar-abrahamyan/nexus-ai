import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmNeedsShell = !npmCli && process.platform === 'win32';
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempDir = mkdtempSync(path.join(tmpdir(), 'nexus-ai-clean-install-'));
let keepTempDir = false;

function run(command, args, cwd, options = {}) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
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
  const packOutput = execFileSync(npmCommand, npmCli
    ? [npmCli, 'pack', '--json', '--pack-destination', tempDir]
    : ['pack', '--json', '--pack-destination', tempDir], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: process.env,
    shell: npmNeedsShell,
  });
  const [packed] = JSON.parse(packOutput);
  const tarball = path.join(tempDir, packed.filename);

  runNpm(['init', '-y'], tempDir);
  runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], tempDir);

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
  const smokePath = path.join(tempDir, 'smoke.mjs');
  writeFileSync(smokePath, smokeScript);
  run(process.execPath, [smokePath], tempDir);
  console.log('Clean production install smoke test passed.');
} catch (error) {
  keepTempDir = true;
  console.error(`Clean install fixture kept at ${tempDir}`);
  throw error;
} finally {
  if (!keepTempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
