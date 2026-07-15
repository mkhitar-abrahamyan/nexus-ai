import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmNeedsShell = !npmCli && process.platform === 'win32';
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempParent = path.resolve(repoRoot, '..', '.tmp-nexus-ai-tests');
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(path.join(tempParent, 'clean-install-'));
const packDir = path.join(tempRoot, 'pack');
const consumerDir = path.join(tempRoot, 'consumer');
mkdirSync(packDir);
mkdirSync(consumerDir);
let keepTempDir = false;

function npmEnv() {
  return {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
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
  const packOutput = execFileSync(npmCommand, npmCli
    ? [npmCli, 'pack', '--json', '--pack-destination', packDir]
    : ['pack', '--json', '--pack-destination', packDir], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: npmEnv(),
    shell: npmNeedsShell,
  });
  const [packed] = JSON.parse(packOutput);
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
