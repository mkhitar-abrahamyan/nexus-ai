// The studio as a user gets it: pack nexus-ai-pro and nexus-ai-pro-studio, install both into an
// empty project, start `nexus-studio` on a config file, and check it shows a traced agent run, an
// approval waiting in the inbox, and an experiment comparison.
//
// Requires the core package to be built (`npm run build`); builds the studio itself.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmNeedsShell = !npmCli && process.platform === 'win32';
const studioDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = path.resolve(studioDir, '..');
const npmCache = path.join(repoRoot, '.tmp-nexus-ai-tests', 'npm-cache');
const tempParent = path.resolve(repoRoot, '..', '.tmp-nexus-ai-tests');
mkdirSync(npmCache, { recursive: true });
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(path.join(tempParent, 'studio-install-'));
const packDir = path.join(tempRoot, 'pack');
const consumerDir = path.join(tempRoot, 'consumer');

const env = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_cache: npmCache,
  npm_config_fund: 'false',
  npm_config_prefer_offline: 'true',
  npm_config_dry_run: 'false',
};

function npm(args, cwd) {
  return execFileSync(npmCommand, npmCli ? [npmCli, ...args] : args, {
    cwd,
    env,
    shell: npmNeedsShell,
    encoding: 'utf8',
  });
}

function pack(cwd) {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDir], cwd));
  return path.join(packDir, packed.filename);
}

const CONFIG = `
import { createDataset, evaluate, exactMatch, MemoryExperimentStore } from 'nexus-ai-pro/evaluate';
import { createGraph, END, lastValue, MemoryGraphCheckpointer } from 'nexus-ai-pro/graph';
import { MemoryTraceStore, Tracer } from 'nexus-ai-pro/tracing';

export default async function sources() {
  const traces = new MemoryTraceStore();
  const tracer = new Tracer({ store: traces });
  const root = tracer.startRun({ name: 'support-agent', kind: 'agent', inputs: { question: 'refund?' } });
  const call = root.child({ name: 'model', kind: 'model', model: 'gpt-5.4-mini' });
  await call.finish({ outputs: { content: 'A refund is due.' }, cost: 0.0004 });
  await root.finish({ outputs: { answer: 'A refund is due.' } });

  const checkpointer = new MemoryGraphCheckpointer();
  const support = createGraph({ channels: { approved: lastValue() } })
    .addNode('approve', async (context) => ({ approved: (await context.interrupt({ reason: 'Approve the refund?' })) === true }))
    .setEntry('approve')
    .addEdge('approve', END)
    .compile({ checkpointer });
  await support.invoke({}, { threadId: 'refund-1' });

  const experiments = new MemoryExperimentStore();
  const dataset = createDataset({ name: 'answers', examples: [{ id: 'a', inputs: 1, expected: 'yes' }, { id: 'b', inputs: 2, expected: 'yes' }] });
  await evaluate(() => 'yes', dataset, [exactMatch()], { name: 'baseline', store: experiments });
  await evaluate(() => 'no', dataset, [exactMatch()], { name: 'candidate', store: experiments });

  return { traces, graphs: { support: { graph: support, checkpointer } }, experiments };
}
`;

let child;
try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  execFileSync(process.execPath, [path.join(studioDir, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  const core = pack(repoRoot);
  const studio = pack(studioDir);

  writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'studio-consumer', private: true, type: 'module' }, null, 2),
  );
  npm(['install', ...peerFlags(), core, studio], consumerDir);
  const bin = path.join(
    consumerDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'nexus-studio.cmd' : 'nexus-studio',
  );
  assert.ok(existsSync(bin), 'installing the studio links the nexus-studio command');
  writeFileSync(path.join(consumerDir, 'studio.config.mjs'), CONFIG);

  // The command is run through node directly: the same file the bin link points to, on every platform.
  const cli = path.join(consumerDir, 'node_modules', 'nexus-ai-pro-studio', 'dist', 'cli.js');
  child = spawn(process.execPath, [cli, '--config', 'studio.config.mjs', '--port', '0', '--token', 'smoke-token'], {
    cwd: consumerDir,
    env,
  });
  let output = '';
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The studio did not start:\n${output}`)), 60_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('exit', (code) => reject(new Error(`The studio exited with ${code}:\n${output}`)));
  });
  const origin = new URL(url).origin;
  const api = async (route) => {
    const response = await fetch(`${origin}${route}`, { headers: { 'x-studio-token': 'smoke-token' } });
    assert.equal(response.status, 200, `${route} answered ${response.status}`);
    return response.json();
  };

  const entry = await fetch(url, { redirect: 'manual' });
  assert.equal(entry.status, 303, 'the page exchanges the token for a cookie');
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0];
  for (const asset of ['/', '/app.js', '/style.css']) {
    const response = await fetch(`${origin}${asset}`, { headers: { cookie } });
    assert.equal(response.status, 200, `${asset} is served from the installed package`);
  }

  const { runs } = await api('/api/traces');
  assert.ok(
    runs.some((run) => run.name === 'support-agent' && run.kind === 'agent'),
    'a traced agent run is shown',
  );
  const { interrupts } = await api('/api/inbox');
  assert.equal(interrupts[0]?.threadId, 'refund-1', 'an approval waits in the inbox');
  const { experiments } = await api('/api/experiments');
  const byName = Object.fromEntries(experiments.map((experiment) => [experiment.name, experiment.id]));
  const { comparison } = await api(
    `/api/compare/experiments?baseline=${byName.baseline}&candidate=${byName.candidate}`,
  );
  assert.equal(comparison.regressed, true, 'the experiment comparison gives a verdict');

  console.log('Studio install smoke test passed: nexus-studio ran from the packed packages.');
  // The studio runs from the consumer directory, which Windows will not delete while it does.
  await stop(child);
  rmSync(tempRoot, { recursive: true, force: true });
} catch (error) {
  await stop(child);
  console.error(`Studio install fixture kept at ${tempRoot}`);
  throw error;
}

// Between releases the working tree is the next release, but its version field still names the last
// one, so a studio whose peer floor is the next version cannot install against it. That one case — the
// floor is exactly the next patch, minor, or major — installs without the peer check; any other
// mismatch fails. Once the release bumps the version, the check is strict again.
function peerFlags() {
  const read = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const version = read(repoRoot).version.split('.').map(Number);
  const floor = /^>=(\d+)\.(\d+)\.(\d+)/.exec(read(studioDir).peerDependencies['nexus-ai-pro'] ?? '');
  assert.ok(floor, 'the studio names a nexus-ai-pro floor');
  const [major, minor, patch] = floor.slice(1).map(Number);
  const below = major - version[0] || minor - version[1] || patch - version[2];
  if (below <= 0) return [];
  const [M, m, p] = version;
  const next = [`${M}.${m}.${p + 1}`, `${M}.${m + 1}.0`, `${M + 1}.0.0`];
  assert.ok(
    next.includes(`${major}.${minor}.${patch}`),
    `the studio needs nexus-ai-pro ${major}.${minor}.${patch}, which is not the next release after ${version.join('.')}`,
  );
  console.log(
    `Unreleased: the studio needs nexus-ai-pro ${major}.${minor}.${patch}; installing without the peer check.`,
  );
  return ['--legacy-peer-deps'];
}

function stop(process) {
  if (!process || process.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    process.once('exit', resolve);
    process.kill();
  });
}
