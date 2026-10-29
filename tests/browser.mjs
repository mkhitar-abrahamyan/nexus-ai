#!/usr/bin/env node
/**
 * The portable kernel in a real browser. A page imports every kernel entry point from the built
 * package, runs the kernel's own tests, `tests/portable/kernel.mjs`, as Node.js, Deno, Bun, and an
 * edge runtime run them, then runs a graph, an agent against a mock model, and the AG-UI adapter.
 *
 *   node tests/browser.mjs            # headless Chromium: the machine's own, or `CHROME_BIN`
 *   node tests/browser.mjs firefox    # Firefox, as Playwright builds it
 *   node tests/browser.mjs webkit     # WebKit, Safari's engine, as Playwright builds it
 *
 * Chromium needs nothing installed. Firefox and WebKit come from
 * `npx playwright-core install firefox webkit`. Each needs `npm run build`. Without the browser it
 * says so and passes, except under CI, where a missing browser fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const engine = process.argv[2] ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) {
  console.error(`Unknown browser "${engine}": chromium, firefox, or webkit`);
  process.exit(2);
}
/** The kernel's tests, which the page imports beside the build they import. */
const KERNEL_TESTS = '/tests/portable/kernel.mjs';
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const portability = readFileSync(path.join(root, 'scripts', 'check-portability.mjs'), 'utf8');
const kernel = [...(/const KERNEL = \[([\s\S]*?)\];/.exec(portability)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
  (match) => match[1],
);
if (kernel.length < 10) throw new Error('Could not read the kernel entry points from check-portability.mjs');

/** The built file of each kernel entry point, as a browser imports it. */
const files = Object.fromEntries(
  kernel.map((subpath) => {
    const target = packageJson.exports[subpath]?.import?.default;
    if (!target) throw new Error(`${subpath} has no ESM build`);
    return [subpath, `/${target.replace(/^\.\//, '')}`];
  }),
);

function browser() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>nexus-ai-pro in a browser</title>
<pre id="result">running</pre>
<script type="module">
const files = ${JSON.stringify(files)};
const report = (value) => { document.getElementById('result').textContent = 'RESULT ' + JSON.stringify(value); };
try {
  const loaded = {};
  for (const [subpath, file] of Object.entries(files)) loaded[subpath] = Object.keys(await import(file)).length;
  const { createGraph, lastValue, END } = await import(files['./graph']);
  const graph = createGraph({ channels: { count: lastValue(0) } })
    .addNode('add', (context) => ({ count: (context.state.count ?? 0) + 1 }))
    .setEntry('add').addEdge('add', END).compile();
  const counted = await graph.invoke({ count: 41 });

  const { createAgent, agentInput, tool } = await import(files['./agent']);
  let calls = 0;
  const client = {
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return { content: '', role: 'assistant', finishReason: 'tool_calls', meta: {},
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }] };
      }
      return { content: 'It is ' + request.messages.at(-1).content, role: 'assistant', finishReason: 'stop', meta: {} };
    },
  };
  const now = tool({ name: 'now', description: 'The time', parameters: { type: 'object' },
    async *stream() { yield 'checking'; return 'noon'; } });
  const agent = createAgent({ client, model: 'mock', tools: [now] });
  const answered = await agent.invoke(agentInput('What time is it?'));

  const { agUiEvents } = await import(files['./protocols/ag-ui']);
  const kernelLines = [];
  globalThis.__NEXUS_EXPECTED_RUNTIME__ = 'browser';
  const { run } = await import('${KERNEL_TESTS}');
  const kernelRun = await run((line) => kernelLines.push(line));
  const types = [];
  calls = 0;
  for await (const event of agUiEvents(agent, { threadId: 't', runId: 'r', messages: [{ id: 'm', role: 'user', content: 'Time?' }] }, { stateDeltas: true })) {
    types.push(event.type);
  }
  report({ ok: true, loaded, count: counted.state.count, answer: answered.state.answer, types,
    kernel: { passed: kernelRun.passed, failed: kernelRun.failed, lines: kernelLines },
    userAgent: navigator.userAgent, node: typeof process !== 'undefined' });
} catch (error) {
  report({ ok: false, error: String(error && error.stack || error) });
}
</script>`;

const types = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.map': 'application/json',
};
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': types['.html'] });
    response.end(page);
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  const served = file.startsWith(path.join(root, 'dist')) || file === path.join(root, KERNEL_TESTS);
  if (!served || !existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});

/** Without the browser, the check says so and passes, except under CI. */
function missing(message) {
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipped.`);
  process.exit(0);
}

/** What the page reported, from the machine's Chromium, in the DOM it prints once the page settles. */
async function inChromium(executable, url) {
  const profile = path.join(root, '.tmp-nexus-ai-tests', `browser-${process.pid}`);
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=20000',
      '--dump-dom',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let dom = '';
  child.stdout.on('data', (chunk) => {
    dom += chunk;
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  const text = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
  if (text === undefined) return `exit ${code}: ${dom.slice(0, 2_000)}`;
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** Playwright's own name for the build it ran, since WebKit's user agent names a frozen version. */
let version;

/** What the page reported, from Playwright's build of Firefox or WebKit. */
async function inPlaywright(type, url) {
  const launched = await type.launch();
  version = `${engine === 'webkit' ? 'WebKit' : 'Firefox'} ${launched.version()}`;
  try {
    const page = await launched.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('result')?.textContent?.startsWith('RESULT '), undefined, {
      timeout: 60_000,
    });
    return (await page.textContent('#result')) ?? '';
  } finally {
    await launched.close();
  }
}

let open;
if (engine === 'chromium') {
  const executable = browser();
  if (!executable) missing('No Chromium-family browser found; set CHROME_BIN to run the browser check.');
  open = (url) => inChromium(executable, url);
} else {
  const playwright = await import('playwright-core').catch(() => undefined);
  const type = playwright?.[engine];
  if (!type || !existsSync(type.executablePath())) {
    missing(`${engine} is not installed; npx playwright-core install ${engine} installs it.`);
  }
  open = (url) => inPlaywright(type, url);
}
if (!existsSync(path.join(root, 'dist', 'index.js'))) throw new Error('Build first: npm run build');

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
let reported;
try {
  reported = await open(`http://127.0.0.1:${port}/`);
} finally {
  server.close();
}

if (!reported.startsWith('RESULT ')) {
  console.error(`${engine} did not report a result: ${reported}`);
  process.exit(1);
}
const result = JSON.parse(reported.slice('RESULT '.length));
if (!result.ok) {
  console.error(`In the browser: ${result.error}`);
  process.exit(1);
}
const failures = [];
for (const subpath of kernel) if (!(result.loaded[subpath] > 0)) failures.push(`${subpath} exported nothing`);
if (result.count !== 42) failures.push(`the graph counted ${result.count}`);
// A tool's result reaches the model as JSON.
if (result.answer !== 'It is "noon"') failures.push(`the agent answered ${JSON.stringify(result.answer)}`);
for (const type of ['RUN_STARTED', 'STATE_SNAPSHOT', 'STATE_DELTA', 'TOOL_CALL_START', 'CUSTOM', 'RUN_FINISHED']) {
  if (!result.types.includes(type)) failures.push(`AG-UI sent no ${type}`);
}
if (result.node) failures.push('the page saw a Node.js process global');
for (const name of result.kernel.failed) {
  const line = result.kernel.lines.find((entry) => entry.startsWith(`not ok - ${name}`)) ?? name;
  failures.push(`the kernel's check failed: ${line}`);
}
if (result.kernel.passed === 0) failures.push("none of the kernel's checks ran");
if (failures.length) {
  console.error(`The browser check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
const agent =
  version ??
  /Firefox\/[\d.]+/.exec(result.userAgent)?.[0] ??
  /(HeadlessChrome|Edg|Chrome)\/[\d.]+/.exec(result.userAgent)?.[0] ??
  /AppleWebKit\/[\d.]+/.exec(result.userAgent)?.[0] ??
  engine;
console.log(
  `In ${agent}: ${kernel.length} kernel entry points imported; the kernel's ${result.kernel.passed} checks passed; a graph, an agent with a streaming tool, and AG-UI ran.`,
);
