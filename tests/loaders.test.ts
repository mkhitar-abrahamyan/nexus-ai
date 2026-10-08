import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHashEmbeddings, MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { loadCsv, parseCsv } from '../src/loaders/csv.js';
import { GitLoaderError, loadGitRepository } from '../src/loaders/git.js';
import { htmlToText, loadHtml } from '../src/loaders/html.js';
import { collectDocuments, loadIntoStore } from '../src/loaders/index.js';
import { loadJson } from '../src/loaders/json.js';
import { loadMarkdown, markdownToPlainText, parseMarkdown } from '../src/loaders/markdown.js';
import { loadPdf, PdfLoaderError } from '../src/loaders/pdf.js';
import { loadDirectory, loadText } from '../src/loaders/text.js';
import { loadSitemap, loadWebPages, sitemapUrls, WebLoaderError } from '../src/loaders/web.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-loaders-'));
let server: Server;
let origin = '';

const pages: Record<string, { type: string; body: string | Buffer; status?: number }> = {
  '/guide': {
    type: 'text/html; charset=utf-8',
    body: '<html><head><title>Refund guide</title><meta name="description" content="How refunds work"></head><body><nav>Home</nav><main><h1>Refunds</h1><p>Refunds take 14&nbsp;days.</p><a href="/faq">FAQ</a></main></body></html>',
  },
  '/notes.txt': { type: 'text/plain', body: 'Plain notes' },
  '/missing': { type: 'text/plain', body: 'gone', status: 404 },
  '/logo.png': { type: 'image/png', body: Buffer.from([0x89, 0x50]) },
};

before(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/sitemap.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/pages.xml</loc></sitemap><sitemap><loc>${origin}/more.xml.gz</loc></sitemap></sitemapindex>`,
      );
      return;
    }
    if (url === '/pages.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<urlset><url><loc>${origin}/guide</loc></url><url><loc>${origin}/notes.txt</loc></url></urlset>`);
      return;
    }
    if (url === '/bomb.xml.gz') {
      // 60 MB of nothing, in about 60 KB of gzip.
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end(gzipSync(Buffer.alloc(60 * 1024 * 1024)));
      return;
    }
    if (url === '/more.xml.gz') {
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end(
        gzipSync(
          `<urlset><url><loc>${origin}/guide</loc></url><url><loc>${origin}/private?a=1&amp;b=2</loc></url></urlset>`,
        ),
      );
      return;
    }
    const page = pages[url];
    response.writeHead(page?.status ?? (page ? 200 : 404), { 'content-type': page?.type ?? 'text/plain' });
    response.end(page?.body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('text files load from disk or memory, and a directory loads in sorted order through parsers', async () => {
  const directory = path.join(work, 'docs');
  mkdirSync(path.join(directory, 'guides'), { recursive: true });
  mkdirSync(path.join(directory, 'node_modules'), { recursive: true });
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'b.txt'), '﻿second');
  writeFileSync(path.join(directory, 'a.md'), '---\ntitle: First\n---\n# Heading\nbody');
  writeFileSync(path.join(directory, 'guides', 'c.html'), '<title>Third</title><p>third</p>');
  writeFileSync(path.join(directory, 'node_modules', 'x.txt'), 'dependency');
  writeFileSync(path.join(directory, '.git', 'y.txt'), 'internals');
  writeFileSync(path.join(directory, 'image.png'), 'not text');

  const [fromDisk] = await collectDocuments(loadText(path.join(directory, 'b.txt')));
  assert.equal(fromDisk.text, 'second', 'a byte-order mark is dropped');
  const [fromMemory] = await collectDocuments(
    loadText({ source: 'upload.txt', content: 'hello' }, { metadata: { tenant: 'acme' } }),
  );
  assert.deepEqual(fromMemory, { id: 'upload.txt', text: 'hello', source: 'upload.txt', metadata: { tenant: 'acme' } });

  const loaded = await collectDocuments(
    loadDirectory(directory, {
      parsers: { '.md': (file) => loadMarkdown(file), '.html': (file) => loadHtml(file) },
      metadata: { corpus: 'docs' },
    }),
  );
  assert.deepEqual(
    loaded.map((document) => document.id),
    ['a.md', 'b.txt', 'guides/c.html'],
    'sorted, relative, and without node_modules, dot directories, or other extensions',
  );
  assert.equal(loaded[0].metadata?.title, 'First');
  assert.equal(loaded[2].metadata?.title, 'Third');
  assert.equal(loaded[2].metadata?.corpus, 'docs');
  await assert.rejects(collectDocuments(loadDirectory(directory, { maxFiles: 1 })), /more than maxFiles/);
});

test('Markdown keeps its front matter and title as metadata, and can be reduced to plain text', async () => {
  const parsed = parseMarkdown(
    '---\ntitle: "Refunds"\ntags: [billing, policy]\ndraft: false\norder: 2\n---\n# Ignored\nText',
  );
  assert.deepEqual(parsed.frontMatter, { title: 'Refunds', tags: ['billing', 'policy'], draft: false, order: 2 });
  assert.equal(parsed.title, 'Refunds');
  assert.equal(parseMarkdown('# From heading\n\nbody').title, 'From heading');
  assert.equal(
    markdownToPlainText('# Title\n\nSee **the** [docs](https://x.test) and `code`.\n\n```ts\nconst a = 1;\n```'),
    'Title\n\nSee the docs and code.\n\nconst a = 1;',
  );
  const [document] = await collectDocuments(
    loadMarkdown({ source: 'r.md', content: '---\nteam: billing\n---\n# Refunds\n**Fast**' }, { plainText: true }),
  );
  assert.equal(document.text, 'Refunds\nFast');
  assert.deepEqual(document.metadata, { team: 'billing', title: 'Refunds' });
});

test('HTML becomes readable text with headings, without scripts, navigation, or entities', () => {
  const page = htmlToText(
    '<html><head><title>A &amp; B</title><script>alert(1)</script></head><body><header>Menu</header><main><h2>Section</h2><p>One&#8217;s <b>bold</b><br>line</p><ul><li>first</li><li>second</li></ul><a href="/next">next</a><style>p{}</style></main><footer>Footer</footer></body></html>',
    { baseUrl: 'https://example.test/docs/' },
  );
  assert.equal(page.title, 'A & B');
  assert.equal(page.text, '## Section\n\nOne’s bold\nline\n\n- first\n- second\nnext');
  assert.deepEqual(page.links, ['https://example.test/next']);
  assert.match(htmlToText('<body><nav>Menu</nav><p>All</p></body>', { mainContent: false }).text, /Menu/);
});

test('CSV parses by RFC 4180 and loads one document per row', async () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",2\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['multi\nline', '2'],
  ]);
  assert.deepEqual(parseCsv('a\tb\n1\t2', { delimiter: '\t' }), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.throws(() => parseCsv('"open'), /inside a quoted field/);

  const rows = await collectDocuments(
    loadCsv(
      { source: 'products.csv', content: 'sku,name,description,region\nA-1,Kettle,Boils water,eu\nB-2,Toaster,,us\n' },
      { idColumn: 'sku', metadataColumns: ['region'] },
    ),
  );
  assert.deepEqual(rows[0], {
    id: 'products.csv#A-1',
    text: 'name: Kettle\ndescription: Boils water',
    source: 'products.csv',
    metadata: { region: 'eu', row: 1 },
  });
  assert.equal(rows[1].text, 'name: Toaster', 'an empty value is left out');
  await assert.rejects(
    collectDocuments(loadCsv({ source: 'x.csv', content: 'a\n1' }, { idColumn: 'nope' })),
    /no column "nope"/,
  );
});

test('JSON and JSON Lines load one document per record', async () => {
  const json = await collectDocuments(
    loadJson(
      {
        source: 'faq.json',
        content: JSON.stringify({
          items: [{ q: { text: 'Refunds?' }, key: 'r', team: 'billing' }, { q: { text: 'Shipping?' } }],
        }),
      },
      {
        records: (value) => (value as { items: unknown[] }).items,
        text: 'q.text',
        id: 'key',
        metadataFields: ['team'],
      },
    ),
  );
  assert.deepEqual(
    json.map((document) => [document.id, document.text, document.metadata?.team]),
    [
      ['faq.json#r', 'Refunds?', 'billing'],
      ['faq.json#2', 'Shipping?', undefined],
    ],
  );
  const lines = await collectDocuments(loadJson({ source: 'events.jsonl', content: '"first"\n\n{"a":1}\n' }));
  assert.deepEqual(
    lines.map((document) => document.text),
    ['first', '{\n  "a": 1\n}'],
  );
  await assert.rejects(collectDocuments(loadJson({ source: 'bad.ndjson', content: '{}\n{oops' })), /line 2/);
});

test('PDFs go through the injected parser, page by page, and non-PDFs are refused first', async () => {
  const pdf = { source: 'manual.pdf', content: new TextEncoder().encode('%PDF-1.7 fake') };
  let calls = 0;
  const paged = await collectDocuments(
    loadPdf(pdf, {
      extract: () => {
        calls++;
        return ['Page one', '  ', 'Page three'];
      },
    }),
  );
  assert.deepEqual(
    paged.map((document) => [document.id, document.metadata?.page]),
    [
      ['manual.pdf#page-1', 1],
      ['manual.pdf#page-3', 3],
    ],
  );
  const joined = await collectDocuments(loadPdf(pdf, { extract: () => ['a', 'b'], splitPages: false }));
  assert.equal(joined[0].text, 'a\n\nb');
  await assert.rejects(
    collectDocuments(loadPdf({ source: 'fake.pdf', content: 'hello' }, { extract: () => 'x' })),
    PdfLoaderError,
  );
  assert.equal(calls, 1);
});

test('web pages load through the SSRF-safe fetch, in order, and fail or skip as asked', async () => {
  const loaded = await collectDocuments(
    loadWebPages([`${origin}/guide`, `${origin}/notes.txt`], { allowPrivateNetworks: true, concurrency: 2 }),
  );
  assert.equal(loaded[0].id, `${origin}/guide`);
  assert.equal(loaded[0].text, '# Refunds\n\nRefunds take 14 days.\nFAQ');
  assert.equal(loaded[0].metadata?.title, 'Refund guide');
  assert.equal(loaded[0].metadata?.description, 'How refunds work');
  assert.equal(loaded[1].text, 'Plain notes');

  await assert.rejects(
    collectDocuments(loadWebPages([`${origin}/guide`])),
    /non-public/,
    'private addresses are refused by default',
  );
  const missing = await collectDocuments(loadWebPages([`${origin}/missing`], { allowPrivateNetworks: true })).catch(
    (error: unknown) => error,
  );
  assert.ok(missing instanceof WebLoaderError);
  assert.equal(missing.status, 404);

  const skipped: string[] = [];
  const kept = await collectDocuments(
    loadWebPages([`${origin}/logo.png`, `${origin}/missing`, `${origin}/notes.txt`], {
      allowPrivateNetworks: true,
      onError: 'skip',
      onSkip: (url) => skipped.push(url),
    }),
  );
  assert.deepEqual(
    kept.map((document) => document.text),
    ['Plain notes'],
  );
  assert.equal(skipped.length, 2);
});

test('a gzipped sitemap that inflates past the protocol’s 50 MB is refused, not decompressed into memory', async () => {
  await assert.rejects(
    sitemapUrls(`${origin}/bomb.xml.gz`, { allowPrivateNetworks: true }),
    (error: unknown) => error instanceof WebLoaderError && /at most 50 MB/.test(error.message),
  );
});

test('a sitemap index is followed, gzip included, and its pages load', async () => {
  const urls = await sitemapUrls(`${origin}/sitemap.xml`, { allowPrivateNetworks: true });
  assert.deepEqual(urls, [`${origin}/guide`, `${origin}/notes.txt`, `${origin}/private?a=1&b=2`]);
  const filtered = await sitemapUrls(`${origin}/sitemap.xml`, {
    allowPrivateNetworks: true,
    include: (url) => !url.includes('private'),
    limit: 1,
  });
  assert.deepEqual(filtered, [`${origin}/guide`]);
  const loaded = await collectDocuments(
    loadSitemap(`${origin}/sitemap.xml`, { allowPrivateNetworks: true, include: (url) => !url.includes('private') }),
  );
  assert.equal(loaded.length, 2);
});

test('a Git repository loads its tracked text files, locally or cloned at a ref', async () => {
  const repository = path.join(work, 'repo');
  mkdirSync(path.join(repository, 'docs'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', ...args], {
      cwd: repository,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repository, 'README.md'), '# Project\nreadme');
  writeFileSync(path.join(repository, 'docs', 'guide.md'), '---\ntitle: Guide\n---\nguide');
  writeFileSync(path.join(repository, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(path.join(repository, 'untracked.md'), 'not committed');
  git('add', 'README.md', 'docs/guide.md', 'logo.bin');
  git('commit', '-q', '-m', 'first');
  git('branch', 'release');
  writeFileSync(path.join(repository, 'README.md'), '# Project\nchanged on main');
  git('commit', '-q', '-am', 'second');

  const local = await collectDocuments(
    loadGitRepository(repository, { parsers: { '.md': (file) => loadMarkdown(file) } }),
  );
  assert.deepEqual(
    local.map((document) => document.id),
    ['README.md', 'docs/guide.md'],
    'tracked text files only: no binary, nothing untracked',
  );
  assert.match(local[0].text, /changed on main/);
  assert.equal(local[1].metadata?.title, 'Guide');
  assert.match(String(local[0].metadata?.commit), /^[0-9a-f]{40}$/);
  assert.equal(local[0].metadata?.path, 'README.md');

  const release = await collectDocuments(
    loadGitRepository(repository, { ref: 'release', extensions: ['.md'], ignore: (file) => file.startsWith('docs/') }),
  );
  assert.deepEqual(
    release.map((document) => [document.id, document.text]),
    [['README.md', '# Project\nreadme']],
  );
  await assert.rejects(collectDocuments(loadGitRepository(repository, { ref: 'no-such-branch' })), GitLoaderError);
  await assert.rejects(collectDocuments(loadGitRepository('--upload-pack=evil')), /must not start/);
});

test('a Git repository never reads through a tracked symbolic link, cloned or in place', async (t) => {
  const secret = path.join(work, 'host-secret.md');
  writeFileSync(secret, 'PRIVATE KEY that must never be loaded');
  const repository = path.join(work, 'linked-repo');
  mkdirSync(repository, { recursive: true });
  try {
    symlinkSync(secret, path.join(repository, 'notes.md'));
  } catch {
    t.skip('this machine cannot create symbolic links');
    return;
  }
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', '-c', 'core.symlinks=true', ...args],
      {
        cwd: repository,
        stdio: 'pipe',
      },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repository, 'README.md'), '# Linked\nreadme');
  git('add', 'README.md', 'notes.md');
  git('commit', '-q', '-m', 'a link to a file outside the repository');
  assert.match(git('ls-files', '-s', 'notes.md').toString(), /^120000 /, 'the link is tracked as a link');

  const inPlace = await collectDocuments(loadGitRepository(repository));
  const cloned = await collectDocuments(loadGitRepository(`file://${repository.split(path.sep).join('/')}`));
  for (const documents of [inPlace, cloned]) {
    assert.deepEqual(
      documents.map((document) => document.id),
      ['README.md'],
    );
    assert.ok(documents.every((document) => !document.text.includes('PRIVATE KEY')));
  }
});

test('loadIntoStore streams documents into a store in batches, and reloading replaces chunks', async () => {
  const store = new MemoryVectorStore((texts) => createHashEmbeddings(texts, 64));
  const batches: number[] = [];
  const documents = Array.from({ length: 5 }, (_, index) => ({
    text: `Document number ${index} about refunds`,
    source: 'gen',
  }));
  const result = await loadIntoStore(store, [documents, loadText({ source: 'extra.txt', content: 'Extra text' })], {
    batchSize: 2,
    onBatch: (progress) => batches.push(progress.documents),
  });
  assert.deepEqual(result, { documents: 6, chunks: 6, totalCharacters: result.totalCharacters });
  assert.deepEqual(batches, [2, 4, 6]);
  assert.equal(store.size(), 6);
  await loadIntoStore(store, [documents, loadText({ source: 'extra.txt', content: 'Extra text' })], { batchSize: 4 });
  assert.equal(store.size(), 6, 'the same corpus loaded again replaces its chunks');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadIntoStore(store, documents, { signal: controller.signal }));
  await assert.rejects(loadIntoStore(store, documents, { batchSize: 0 }), /positive integer/);
});
