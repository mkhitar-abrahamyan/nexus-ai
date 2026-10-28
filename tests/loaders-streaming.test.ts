/**
 * Loaders that stream: CSV rows, JSON Lines, and the records of a JSON array read as a file arrives,
 * from a stream, a file on disk, or memory, each the same however the text is cut into pieces; and a
 * page built by script rendered by a browser of the application's own.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CsvRowParser, loadCsv, parseCsv } from '../src/loaders/csv.js';
import { collectDocuments, type DocumentSource } from '../src/loaders/index.js';
import { loadJson } from '../src/loaders/json.js';
import { loadText } from '../src/loaders/text.js';
import { browserRenderer, loadWebPages, type RenderingBrowser } from '../src/loaders/web.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-streaming-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** Text as a stream of bytes, cut every `size` bytes, through the middle of a character if it falls there. */
function streamOf(text: string, size: number, pulled: { count: number } = { count: 0 }) {
  const bytes = Buffer.from(text);
  return (async function* () {
    for (let at = 0; at < bytes.length; at += size) {
      pulled.count += 1;
      yield new Uint8Array(bytes.subarray(at, at + size));
    }
  })();
}

const TRICKY = '﻿name,quote,note\r\n"Smith, Ann","She said ""hi""","line one\nline two"\r\nBo,"",\rCé,😀,x"y\n';

test('a CSV parsed a piece at a time reads the rows parsed whole, wherever the pieces are cut', () => {
  const whole = parseCsv(TRICKY);
  assert.deepEqual(whole, [
    ['name', 'quote', 'note'],
    ['Smith, Ann', 'She said "hi"', 'line one\nline two'],
    ['Bo', '', ''],
    ['Cé', '😀', 'x"y'],
  ]);
  for (let cut = 0; cut <= TRICKY.length; cut++) {
    const parser = new CsvRowParser();
    const rows = [...parser.push(TRICKY.slice(0, cut)), ...parser.push(TRICKY.slice(cut)), ...parser.end()];
    assert.deepEqual(rows, whole, `cut at ${cut}`);
  }
  const parser = new CsvRowParser();
  const byCharacter = [...[...TRICKY].flatMap((char) => parser.push(char)), ...parser.end()];
  assert.deepEqual(byCharacter, whole, 'a character at a time');
  // A closing quote at the very end, a trailing field, and a field left open.
  assert.deepEqual(parseCsv('a,"b"'), [['a', 'b']]);
  const open = new CsvRowParser();
  open.push('a,"b');
  assert.throws(() => open.end(), /ends inside a quoted field/);
  const tabs = new CsvRowParser({ delimiter: '\t' });
  assert.deepEqual([...tabs.push('a\tb\n'), ...tabs.end()], [['a', 'b']]);
  assert.throws(() => new CsvRowParser({ delimiter: '"' }), /one character other than a quote/);
  assert.deepEqual(new CsvRowParser().push(''), [], 'nothing yet');
});

test('CSV rows stream from a stream, cut through characters, and from a file read in chunks', async () => {
  const content = await collectDocuments(loadCsv({ source: 'people.csv', content: TRICKY }, { idColumn: 'name' }));
  for (const size of [1, 3, 7]) {
    const streamed = await collectDocuments(
      loadCsv({ source: 'people.csv', stream: streamOf(TRICKY, size) }, { idColumn: 'name' }),
    );
    assert.deepEqual(streamed, content, `in pieces of ${size} bytes`);
  }
  assert.deepEqual(
    content.map((document) => document.id),
    ['people.csv#Smith, Ann', 'people.csv#Bo', 'people.csv#Cé'],
  );
  assert.equal(content[0]?.text, 'quote: She said "hi"\nnote: line one\nline two');
  assert.equal(content[2]?.metadata?.row, 3);

  // The first row arrives before the rest of the stream is read.
  const rows = Array.from({ length: 20_000 }, (_, index) => `${index},row ${index}`).join('\n');
  const pulled = { count: 0 };
  const loader = loadCsv(
    { source: 'big.csv', stream: streamOf(`id,text\n${rows}\n`, 1024, pulled) },
    { idColumn: 'id' },
  );
  const first = (await loader.next()).value as DocumentSource;
  assert.equal(first.id, 'big.csv#0');
  assert.ok(pulled.count <= 2, `read ${pulled.count} pieces for the first row`);
  await loader.return(undefined);

  // A file on disk, larger than one chunk, read in chunks.
  const file = path.join(work, 'big.csv');
  writeFileSync(file, `id,text\n${rows}\n`);
  const fromDisk = await collectDocuments(loadCsv(file, { idColumn: 'id' }));
  assert.equal(fromDisk.length, 20_000);
  assert.equal(fromDisk.at(-1)?.text, 'text: row 19999');
  await assert.rejects(
    collectDocuments(loadCsv({ source: 'x.csv', stream: streamOf('a,b\n1,2\n', 2) }, { idColumn: 'nope' })),
    /x\.csv has no column "nope"/,
  );
  assert.deepEqual(await collectDocuments(loadCsv({ source: 'empty.csv', stream: streamOf('', 4) })), []);
});

const ITEMS = [
  { id: 'a', body: 'commas, [brackets] and {braces}', tags: ['x', 'y'] },
  { id: 'b', body: 'a "quoted" word and a \\ backslash', nested: { deep: [1, [2, 3]] } },
  { id: 'c', body: 'café 😀' },
];

test('the records of a JSON array stream one at a time, wherever the text is cut', async () => {
  const text = JSON.stringify(ITEMS, null, 2);
  for (const size of [1, 5, 64]) {
    const loaded = await collectDocuments(
      loadJson({ source: 'items.json', stream: streamOf(text, size) }, { id: 'id', text: 'body' }),
    );
    assert.deepEqual(
      loaded.map((document) => [document.id, document.text]),
      ITEMS.map((item) => [`items.json#${item.id}`, item.body]),
      `in pieces of ${size} bytes`,
    );
  }
  const primitives = await collectDocuments(
    loadJson({ source: 'p.json', stream: streamOf('[1, "two" , true,null ,{"k":[]}]', 3) }),
  );
  assert.deepEqual(
    primitives.map((document) => document.text),
    ['1', 'two', 'true', 'null', '{\n  "k": []\n}'],
  );
  assert.deepEqual(
    primitives.map((document) => document.id),
    ['p.json#1', 'p.json#2', 'p.json#3', 'p.json#4', 'p.json#5'],
  );
  assert.deepEqual(await collectDocuments(loadJson({ source: 'e.json', content: ' [ ] ' })), []);

  // An array at a path, past other arrays and keys that look like it, by keys written with escapes.
  const wrapped = JSON.stringify({
    meta: { items: ['not these'], data: { items: ['nor these'] } },
    'd\\u0061ta': 'a string, not the object',
    data: { count: 3, items: ITEMS, after: [9] },
  }).replace('"data":{"count"', '"d\\u0061ta":{"count"');
  const nested = await collectDocuments(
    loadJson({ source: 'w.json', stream: streamOf(wrapped, 7) }, { recordsAt: 'data.items', id: 'id', text: 'body' }),
  );
  assert.deepEqual(
    nested.map((document) => document.id),
    ['w.json#a', 'w.json#b', 'w.json#c'],
  );

  // The first record arrives before the rest of the file is read.
  const many = JSON.stringify({ data: { items: Array.from({ length: 5_000 }, (_, index) => ({ index })) } });
  const pulled = { count: 0 };
  const loader = loadJson({ source: 'many.json', stream: streamOf(many, 256, pulled) }, { recordsAt: 'data.items' });
  assert.equal(((await loader.next()).value as DocumentSource).text, '{\n  "index": 0\n}');
  assert.ok(pulled.count <= 2, `read ${pulled.count} pieces for the first record`);
  await loader.return(undefined);

  // A document that is not an array is one record, read whole; one with no array where asked is refused.
  const single = await collectDocuments(
    loadJson({ source: 's.json', stream: streamOf('{"title":"one"}', 4) }, { text: 'title' }),
  );
  assert.deepEqual(
    single.map((document) => [document.id, document.text]),
    [['s.json#1', 'one']],
  );
  await assert.rejects(
    collectDocuments(loadJson({ source: 'w.json', content: '{"data":{"items":{}}}' }, { recordsAt: 'data.items' })),
    /w\.json has no array at "data\.items"/,
  );
  await assert.rejects(
    collectDocuments(loadJson({ source: 't.json', content: '[{"a":1},{"b"' })),
    /t\.json ends inside its array of records/,
  );
  await assert.rejects(collectDocuments(loadJson({ source: 'n.json', content: '   ' })), /n\.json holds no JSON value/);
  await assert.rejects(collectDocuments(loadJson({ source: 'bad.json', content: '[{"a":1},{"a":}]' })), SyntaxError);
  // A records function reads the file whole, as before.
  const picked = await collectDocuments(
    loadJson(
      { source: 'r.json', stream: streamOf(JSON.stringify({ rows: ITEMS }), 9) },
      { records: (value) => (value as { rows: unknown[] }).rows, id: 'id' },
    ),
  );
  assert.deepEqual(
    picked.map((document) => document.id),
    ['r.json#a', 'r.json#b', 'r.json#c'],
  );
});

test('JSON Lines stream a line at a time, cut anywhere, and a bad line is named by its number', async () => {
  const text = `${ITEMS.map((item) => JSON.stringify(item)).join('\r\n')}\n\n${JSON.stringify({ id: 'd', body: 'last' })}`;
  for (const size of [1, 4, 100]) {
    const loaded = await collectDocuments(
      loadJson({ source: 'items.jsonl', stream: streamOf(text, size) }, { id: 'id', text: 'body' }),
    );
    assert.deepEqual(
      loaded.map((document) => document.id),
      ['items.jsonl#a', 'items.jsonl#b', 'items.jsonl#c', 'items.jsonl#d'],
      `in pieces of ${size} bytes`,
    );
  }
  await assert.rejects(
    collectDocuments(loadJson({ source: 'bad.ndjson', stream: streamOf('{"a":1}\n\n{"a":\n', 3) })),
    /bad\.ndjson line 3:/,
  );
  await assert.rejects(
    collectDocuments(loadJson({ source: 'last.jsonl', content: '{"a":1}\n{"a"' })),
    /last\.jsonl line 2:/,
  );
  const whole = await collectDocuments(
    loadJson(
      { source: 'w.jsonl', content: '{"n":1}\n{"n":2}\n' },
      { records: (value) => (value as unknown[]).slice(1), text: 'n' },
    ),
  );
  assert.deepEqual(
    whole.map((document) => document.text),
    ['2'],
  );
  await assert.rejects(
    collectDocuments(
      loadJson({ source: 'w.jsonl', content: '{"n":1}\nnope\n' }, { records: (value) => value as unknown[] }),
    ),
    /w\.jsonl line 2:/,
  );
});

test('every loader reads a stream input, whole where it must be', async () => {
  const [document] = await collectDocuments(loadText({ source: 'note.txt', stream: streamOf('héllo wörld', 1) }));
  assert.equal(document?.text, 'héllo wörld');
  const mixed = (async function* () {
    yield 'plain ';
    yield new TextEncoder().encode('bytes');
  })();
  assert.equal((await collectDocuments(loadText({ source: 'm.txt', stream: mixed })))[0]?.text, 'plain bytes');
});

test('the edges a stream must keep: marks, blank lines, last rows, cut characters, and what follows the records', async () => {
  // A byte-order mark is dropped at the start, and kept as text anywhere after; end() ends once.
  const parser = new CsvRowParser();
  assert.deepEqual(
    [...parser.push('\ufeffa,b\n'), ...parser.push('\ufeffc,d\n'), ...parser.push('e,f'), ...parser.end()],
    [
      ['a', 'b'],
      ['\ufeffc', 'd'],
      ['e', 'f'],
    ],
  );
  assert.deepEqual(parser.end(), [], 'the last row is given once');
  // A last row with no line break, and blank lines passed over, their numbers still counted.
  const rows = await collectDocuments(
    loadCsv({ source: 'r.csv', stream: streamOf('id,t\n1,a\n\n2,b', 3) }, { idColumn: 'id' }),
  );
  assert.deepEqual(
    rows.map((document) => [document.id, document.metadata?.row]),
    [
      ['r.csv#1', 1],
      ['r.csv#2', 3],
    ],
  );
  // A character cut off at the very end is decoded as a replacement, not lost.
  const cut = new Uint8Array([...Buffer.from('t\nx'), 0xc3]);
  assert.equal((await collectDocuments(loadCsv({ source: 'c.csv', stream: [cut] })))[0]?.text, 't: x\ufffd');
  // A JSON Lines stream's mark is dropped; a mark inside a value, at a piece's start, is kept.
  const marked = await collectDocuments(
    loadJson({ source: 'm.jsonl', stream: ['\ufeff{"t":"a"}\n{"t":"x', '\ufeffy"}\n'] }, { text: 't' }),
  );
  assert.deepEqual(
    marked.map((document) => document.text),
    ['a', 'x\ufeffy'],
  );
  // A quote escaped beside a comma and a bracket stays inside its string.
  const escaped = await collectDocuments(
    loadJson(
      { source: 'q.json', stream: streamOf(JSON.stringify([{ t: 'one " then , and ] inside' }, { t: 'two' }]), 4) },
      { text: 't' },
    ),
  );
  assert.deepEqual(
    escaped.map((document) => document.text),
    ['one " then , and ] inside', 'two'],
  );
  // A path that ends too soon has no array there.
  await assert.rejects(
    collectDocuments(loadJson({ source: 'd.json', content: '{"data":[1,2]}' }, { recordsAt: 'data.items' })),
    /d\.json has no array at "data\.items"/,
  );
  // Nothing after the array of records is read: not a second array at the path, nor the rest.
  const pulled = { count: 0 };
  const tail = `{"items":[{"n":1},{"n":2}],"items":[{"n":3}],"rest":"${'x'.repeat(100_000)}"}`;
  const first = await collectDocuments(
    loadJson({ source: 't.json', stream: streamOf(tail, 64, pulled) }, { recordsAt: 'items', text: 'n' }),
  );
  assert.deepEqual(
    first.map((document) => document.text),
    ['1', '2'],
  );
  assert.ok(pulled.count < 5, `read ${pulled.count} pieces of 64 bytes`);
});

let server: Server;
let origin = '';
const SERVED = 'Already here, written by the server, with words enough to need no browser to build them. '
  .repeat(3)
  .trim();
before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    if (request.url === '/app') {
      response.end('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
    } else if (request.url === '/static') {
      response.end(`<html><body><main><p>${SERVED}</p></main><script>track()</script></body></html>`);
    } else if (request.url === '/medium') {
      response.end(
        `<html><body><main><p>${'A sentence of a page half built. '.repeat(4)}</p></main><script>build()</script></body></html>`,
      );
    } else response.end('<html><body><main><p>Short.</p></main></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('a page built by script is rendered by the application’s browser, and only such a page', async () => {
  const visits: Array<{ url: string; options: unknown }> = [];
  let closed = 0;
  const browser: RenderingBrowser = {
    newPage: async () => {
      let at = '';
      return {
        goto: async (url, options) => {
          at = url;
          visits.push({ url, options });
        },
        content: async () =>
          `<html><body><main><h1>Rendered</h1><p>Built at ${new URL(at).pathname}.</p></main></body></html>`,
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  const loaded = await collectDocuments(
    loadWebPages([`${origin}/app`, `${origin}/static`, `${origin}/plain`], {
      allowPrivateNetworks: true,
      render: browserRenderer(browser, { timeoutMs: 5_000 }),
      renderBelow: 30,
    }),
  );
  assert.deepEqual(visits, [{ url: `${origin}/app`, options: { waitUntil: 'networkidle', timeout: 5_000 } }]);
  assert.equal(closed, 1, 'the tab is closed');
  assert.equal(loaded[0]?.text, '# Rendered\n\nBuilt at /app.');
  assert.equal(loaded[0]?.metadata?.rendered, true);
  assert.equal(loaded[1]?.text, SERVED, 'text enough already, though it runs a script');
  assert.equal(loaded[1]?.metadata?.rendered, undefined);
  assert.equal(loaded[2]?.text, 'Short.', 'short, but no script to build it');

  // Every page that runs a script, when asked; and a renderer given the page as fetched.
  const seen: string[] = [];
  const always = await collectDocuments(
    loadWebPages([`${origin}/static`], {
      allowPrivateNetworks: true,
      renderBelow: Number.POSITIVE_INFINITY,
      render: ({ url, html }) => {
        seen.push(`${new URL(url).pathname} ${html.includes('track()')}`);
        return '<main><p>From the renderer.</p></main>';
      },
    }),
  );
  assert.deepEqual(seen, ['/static true']);
  assert.equal(always[0]?.text, 'From the renderer.');
  const byDefault = await collectDocuments(
    loadWebPages([`${origin}/app`, `${origin}/medium`, `${origin}/static`], {
      allowPrivateNetworks: true,
      render: () => '<main>R</main>',
    }),
  );
  assert.deepEqual(
    byDefault.map((page) => page.text),
    ['R', 'R', SERVED],
    'under 200 characters by default',
  );
  visits.length = 0;
  await collectDocuments(
    loadWebPages([`${origin}/app`], {
      allowPrivateNetworks: true,
      render: browserRenderer(browser, { waitUntil: 'load' }),
    }),
  );
  assert.deepEqual(visits, [{ url: `${origin}/app`, options: { waitUntil: 'load', timeout: 30_000 } }]);

  // A tab that fails is closed all the same, and a stopped load renders nothing.
  let shut = 0;
  const failing: RenderingBrowser = {
    newPage: async () => ({
      goto: async () => {
        throw new Error('navigation failed');
      },
      content: async () => '',
      close: async () => {
        shut += 1;
        throw new Error('already closed');
      },
    }),
  };
  await assert.rejects(
    collectDocuments(loadWebPages([`${origin}/app`], { allowPrivateNetworks: true, render: browserRenderer(failing) })),
    /navigation failed/,
  );
  assert.equal(shut, 1);
  const stopped = new AbortController();
  stopped.abort();
  let opened = 0;
  await assert.rejects(async () =>
    browserRenderer({
      newPage: async () => {
        opened += 1;
        return failing.newPage();
      },
    })({ url: `${origin}/app`, html: '' }, stopped.signal),
  );
  assert.equal(opened, 0, 'no tab for a stopped load');
});
