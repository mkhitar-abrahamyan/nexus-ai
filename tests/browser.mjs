#!/usr/bin/env node
/**
 * The portable kernel in a real browser: headless Chromium imports every kernel entry point from the
 * built package, then runs a graph, an agent against a mock model, and the AG-UI adapter, inside the
 * page. Nothing is installed for it; it uses the Chromium-family browser the machine has, or
 * `CHROME_BIN`.
 *
 *   node tests/browser.mjs     # needs `npm run build`
 *
 * Without a browser it says so and passes, except under CI, where a missing browser fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
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
  const types = [];
  calls = 0;
  for await (const event of agUiEvents(agent, { threadId: 't', runId: 'r', messages: [{ id: 'm', role: 'user', content: 'Time?' }] }, { stateDeltas: true })) {
    types.push(event.type);
  }
  report({ ok: true, loaded, count: counted.state.count, answer: answered.state.answer, types,
    userAgent: navigator.userAgent, node: typeof process !== 'undefined' });
} catch (error) {
  report({ ok: false, error: String(error && error.stack || error) });
}
</script>`;

const types = {
  '.js': 'text/javascript; charset=utf-8',
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
  if (!file.startsWith(path.join(root, 'dist')) || !existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});

const executable = browser();
if (!executable) {
  const message = 'No Chromium-family browser found; set CHROME_BIN to run the browser check.';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipped.`);
  process.exit(0);
}
if (!existsSync(path.join(root, 'dist', 'index.js'))) throw new Error('Build first: npm run build');

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
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
    `http://127.0.0.1:${port}/`,
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
server.close();

const match = /RESULT (\{[\s\S]*?\})<\/pre>/.exec(dom.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
if (!match) {
  console.error(`The browser (exit ${code}) did not report a result:\n${dom.slice(0, 2_000)}`);
  process.exit(1);
}
const result = JSON.parse(match[1]);
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
if (failures.length) {
  console.error(`The browser check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `In ${result.userAgent.match(/(HeadlessChrome|Chrome|Edg)\/[\d.]+/)?.[0] ?? 'the browser'}: ${kernel.length} kernel entry points imported; a graph, an agent with a streaming tool, and AG-UI ran.`,
);
