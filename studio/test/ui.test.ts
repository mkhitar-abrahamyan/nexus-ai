/**
 * The studio's pages in a real browser: a run's events and links as the trace view shows them, opened
 * on that run by a link to it. Headless Chromium renders the page the studio serves, and the test reads
 * what it rendered. Without a Chromium-family browser it is skipped, except in CI.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryTraceStore } from 'nexus-ai-pro/tracing';
import type { Run } from 'nexus-ai-pro/tracing';
import { personalTokens } from '../src/auth.js';
import { oidcSignIn } from '../src/oidc.js';
import { startStudio } from '../src/server.js';

function chromium(): string | undefined {
  return [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .find((candidate) => existsSync(candidate));
}

/** The DOM a page renders in headless Chromium, once its scripts settle. */
async function rendered(browser: string, url: string): Promise<string> {
  const profile = mkdtempSync(path.join(tmpdir(), 'nexus-studio-ui-'));
  try {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=10000',
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let dom = '';
    child.stdout.on('data', (chunk: Buffer) => {
      dom += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(timer);
    return dom;
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const browser = chromium();

test('a run’s events and links, in the trace view a link to the run opens on', {
  skip: browser || process.env.CI ? false : 'no Chromium-family browser is installed',
  timeout: 120_000,
}, async () => {
  assert.ok(browser, 'a Chromium-family browser, which CI has');
  const traces = new MemoryTraceStore();
  const at = (ms: number) => new Date(Date.parse('2026-10-21T09:00:00.000Z') + ms).toISOString();
  const trace = 'trace-ui';
  const run = (fields: Partial<Run> & Pick<Run, 'id' | 'name'>): Run => ({
    traceId: trace,
    kind: 'node',
    status: 'ok',
    startedAt: at(0),
    endedAt: at(500),
    latencyMs: 500,
    ...fields,
  });
  traces.save(run({ id: 'run-root', name: 'crawl', kind: 'graph' }));
  traces.save(run({ id: 'run-branch', name: 'research', parentId: 'run-root' }));
  traces.save(
    run({
      id: 'run-join',
      name: 'report',
      parentId: 'run-root',
      events: [
        { name: 'retry', time: at(120), attributes: { 'nexus.attempt': 1, 'error.message': 'timed out' } },
        { name: 'guardrail', time: at(300), attributes: { 'nexus.guardrail': 'pii-redaction' } },
      ],
      droppedEvents: 2,
      links: [
        { traceId: trace, runId: 'run-branch', attributes: { 'nexus.link': 'previous_step' } },
        { traceId: 'trace-upstream', runId: 'run-queued' },
      ],
    }),
  );
  const running = await startStudio({ traces }, { port: 0, token: 'ui-token' });
  try {
    const dom = (await rendered(browser as string, `${running.url}#/traces/${trace}/run-join`))
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"');
    assert.match(dom, /<h1[^>]*>Trace trace-ui<\/h1>/, `the trace view rendered:\n${dom.slice(0, 1_500)}`);
    assert.match(dom, /<h2>report /, 'opened on the run the link named, not the root');
    const events = /<h2>Events<\/h2>([\s\S]*?)<h2>Links<\/h2>/.exec(dom)?.[1] ?? '';
    assert.match(events, /09:00:00\.120 <\/span><strong>retry<\/strong> nexus\.attempt=1 error\.message=timed out/);
    assert.match(events, /<strong>guardrail<\/strong> nexus\.guardrail=pii-redaction/);
    assert.match(events, /2 more were not kept/);
    const links = /<h2>Links<\/h2>([\s\S]*?)<h2>Metadata<\/h2>|<h2>Links<\/h2>([\s\S]*?)<h2>Add feedback<\/h2>/.exec(
      dom,
    );
    const listed = links?.[1] ?? links?.[2] ?? '';
    assert.match(
      listed,
      /href="#\/traces\/trace-ui\/run-branch">research \(run-branch\)<\/a> nexus\.link=previous_step/,
    );
    assert.match(listed, /href="#\/traces\/trace-upstream\/run-queued">trace-upstream \/ run-queued<\/a>/);
  } finally {
    await running.close();
  }
});

test('the header says who is signed in, in which tenant, and offers to sign out when the studio signs people in', {
  skip: browser || process.env.CI ? false : 'no Chromium-family browser is installed',
  timeout: 120_000,
}, async () => {
  assert.ok(browser, 'a Chromium-family browser, which CI has');
  const personal = 'ana-token-0123456789abcdef';
  const running = await startStudio(
    {},
    {
      port: 0,
      auth: personalTokens([{ id: 'ana@example.com', name: 'Ana', role: 'admin', tenant: 'acme', token: personal }]),
      // Never reached here: the link signs Ana in first.
      signIn: oidcSignIn({
        issuer: 'https://login.example.com',
        clientId: 'nexus-studio',
        role: () => 'viewer',
        secret: 'the-studio-session-secret-0123456789',
        fetch: async () => new Response('offline', { status: 503 }),
      }),
      tenantSources: () => ({}),
    },
  );
  try {
    const dom = await rendered(browser as string, `${new URL(running.url).origin}/?token=${personal}`);
    assert.match(
      dom,
      /<span id="who" class="who">Ana · acme · admin · <a href="\/auth\/logout">Sign out<\/a><\/span>/,
      `the header rendered:\n${dom.slice(0, 1_500)}`,
    );
  } finally {
    await running.close();
  }
});
