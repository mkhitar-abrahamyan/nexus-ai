/**
 * The container sandbox, proved against a real container runtime: it passes the sandbox conformance
 * suite; a command cannot see the host's files or reach the host's network; memory and time limits
 * hold, and a timeout kills everything a command started; and the workspace tools work through it.
 *
 * It needs `docker` or `podman` with a running daemon. Without one the tests are skipped, unless
 * `NEXUS_REQUIRE_CONTAINER=1`, as CI sets, makes that a failure. `NEXUS_CONTAINER_BINARY` and
 * `NEXUS_CONTAINER_IMAGE` choose the runtime and the image.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runSandboxConformance, SandboxPathError, sandboxTools } from '../src/agent/sandbox.js';
import { type ContainerSandboxOptions, containerSandbox } from '../src/agent/sandbox-container.js';
import type { ToolOutput } from '../src/types/messages.js';

const binary = process.env.NEXUS_CONTAINER_BINARY ?? 'docker';
const image = process.env.NEXUS_CONTAINER_IMAGE ?? 'node:22-alpine';
const required = process.env.NEXUS_REQUIRE_CONTAINER === '1';
const daemon = spawnSync(binary, ['info'], { timeout: 30_000, windowsHide: true, stdio: 'ignore' });
const available = daemon.status === 0;
const skip = available ? false : `no ${binary} daemon is reachable`;
const timeout = 300_000;

test('a container runtime is reachable where one is required', { skip: required ? false : 'not required' }, () => {
  assert.ok(available, `NEXUS_REQUIRE_CONTAINER=1, but \`${binary} info\` failed`);
});

const sandboxes: Array<ReturnType<typeof containerSandbox>> = [];
const open = (options: Partial<ContainerSandboxOptions> = {}) => {
  const sandbox = containerSandbox({ image, binary, ...options });
  sandboxes.push(sandbox);
  return sandbox;
};
after(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.dispose?.()));
});

test('the container sandbox passes the sandbox conformance suite', { skip, timeout }, async () => {
  const report = await runSandboxConformance(() => containerSandbox({ image, binary }));
  assert.equal(
    report.passed,
    true,
    report.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join('\n'),
  );
  assert.equal(report.checks.length, 7);
  assert.deepEqual(open().isolation, { filesystem: true, network: true, processes: true });
  assert.equal(open({ network: true }).isolation.network, false, 'a container with a network does not claim it');
});

test('a command in the container sees none of the host’s files', { skip, timeout }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-container-host-'));
  try {
    const marker = `nexus-host-only-${process.pid}-${Date.now()}`;
    writeFileSync(path.join(scratch, `${marker}.txt`), 'host secret');
    const sandbox = open();
    const search = await sandbox.exec(`find / \\( -path /proc -o -path /sys \\) -prune -o -name '${marker}*' -print`, {
      timeoutMs: 60_000,
    });
    assert.equal(search.stdout.trim(), '', 'the host file is nowhere in the container');
    const mounts = await sandbox.exec('cat /proc/mounts');
    assert.doesNotMatch(mounts.stdout, new RegExp(path.basename(scratch)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a command in the container cannot reach the host’s network, and one with a network can', {
  skip,
  timeout,
}, async () => {
  const server = createServer((_request, response) => response.end('reached'));
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as AddressInfo).port;
  const probe = (url: string) =>
    `node -e "fetch('${url}', { signal: AbortSignal.timeout(5000) }).then(r => r.text()).then(t => process.stdout.write(t), () => process.stdout.write('blocked'))"`;
  try {
    const sealed = open();
    for (const url of [
      `http://host.docker.internal:${port}`,
      `http://172.17.0.1:${port}`,
      'https://registry.npmjs.org',
    ]) {
      const result = await sealed.exec(probe(url), { timeoutMs: 20_000 });
      assert.equal(result.stdout, 'blocked', url);
    }
    // The control: the same probe from a container with a network reaches the host, so the check
    // above would see a leak.
    const connected = open({ network: true, runArgs: ['--add-host', 'host.docker.internal:host-gateway'] });
    const reached = await connected.exec(probe(`http://host.docker.internal:${port}`), { timeoutMs: 20_000 });
    assert.equal(reached.stdout, 'reached');
  } finally {
    server.close();
  }
});

test('the memory limit holds, and a timeout kills everything the command started', { skip, timeout }, async () => {
  const small = open({ memory: '64m' });
  const hog = await small.exec(
    `node -e "const kept = []; for (let i = 0; i < 1024; i++) kept.push(Buffer.alloc(1 << 20, 1)); console.log('survived')"`,
    { timeoutMs: 60_000 },
  );
  assert.notEqual(hog.exitCode, 0, 'a command over the memory limit is stopped');
  assert.doesNotMatch(hog.stdout, /survived/);

  const sandbox = open();
  const slow = await sandbox.exec('sleep 300 & sleep 301; echo finished', { timeoutMs: 1_000 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, null);
  assert.doesNotMatch(slow.stdout, /finished/);
  let left = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    left = (await sandbox.exec('ps -o args')).stdout;
    if (!/sleep 30[01]/.test(left)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.doesNotMatch(left, /sleep 30[01]/, 'the command and what it started in the background are gone');
});

test('the workspace lives in the container: files, search, media, and paths that would leave it', {
  skip,
  timeout,
}, async () => {
  const sandbox = open();
  await sandbox.writeFile('src/a.ts', 'const value = 1;\n// TODO: fix the rounding\n');
  await sandbox.writeFile('notes.md', 'todo: the invoice\n');
  await sandbox.writeFile('node_modules/pkg/index.ts', '// TODO: vendored\n');
  await sandbox.exec(
    `node -e "require('fs').writeFileSync('chart.png', Buffer.from([137,80,78,71,13,10,26,10,0,1])); require('fs').writeFileSync('blob.dat', Buffer.from([84,79,68,79,0]))"`,
  );
  assert.equal(await sandbox.readFile('/workspace/src/a.ts'), 'const value = 1;\n// TODO: fix the rounding\n');
  assert.deepEqual([...((await sandbox.readBytes?.('chart.png')) ?? [])], [137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
  assert.deepEqual(await sandbox.listFiles?.('.'), ['blob.dat', 'chart.png', 'node_modules', 'notes.md', 'src']);
  assert.deepEqual(await sandbox.glob?.('**/*.ts'), ['src/a.ts']);
  assert.deepEqual(await sandbox.glob?.('*', { cwd: 'src' }), ['src/a.ts']);
  assert.deepEqual(await sandbox.grep?.('TODO'), [{ file: 'src/a.ts', line: 2, text: '// TODO: fix the rounding' }]);
  assert.deepEqual(
    (await sandbox.grep?.('todo', { ignoreCase: true }))?.map((match) => match.file),
    ['notes.md', 'src/a.ts'],
  );
  await sandbox.removeFile?.('notes.md');
  assert.deepEqual(await sandbox.glob?.('*.md'), []);

  for (const outside of ['../etc/passwd', '/etc/passwd', 'src/../../etc/passwd']) {
    await assert.rejects(sandbox.readFile(outside), SandboxPathError, outside);
  }
  await assert.rejects(sandbox.removeFile?.('.') as Promise<void>, SandboxPathError);

  const tools = sandboxTools(sandbox);
  const media = tools.find((tool) => tool.name === 'read_media');
  const output = (await media?.execute?.({ path: 'chart.png' })) as ToolOutput;
  assert.deepEqual(output.content[1], {
    type: 'image',
    source: { base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]).toString('base64'), mimeType: 'image/png' },
  });
  const grep = tools.find((tool) => tool.name === 'grep_files');
  assert.equal(await grep?.execute?.({ pattern: 'rounding' }), 'src/a.ts:2: // TODO: fix the rounding');
});

test('dispose removes the container', { skip, timeout }, async () => {
  const sandbox = containerSandbox({ image, binary });
  const id = (await sandbox.exec('hostname')).stdout.trim();
  assert.match(id, /^[0-9a-f]{12}$/);
  await sandbox.dispose?.();
  const listed = spawnSync(binary, ['ps', '--all', '--quiet', '--no-trunc'], { encoding: 'utf8', windowsHide: true });
  assert.ok(!listed.stdout.split('\n').some((line) => line.startsWith(id)), 'the container is gone');
});
