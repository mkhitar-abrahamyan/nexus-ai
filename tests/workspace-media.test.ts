/**
 * Workspace search and a multimodal workspace, proved on the reference sandbox: glob and grep are
 * bounded and never leave the root, and an image, audio, or a PDF a tool reads reaches each provider
 * as content the model sees, after the transcript has been through a checkpoint's JSON.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { agentInput } from '../src/agent/create-agent.js';
import { globMatcher } from '../src/agent/glob.js';
import { processSandbox, type Sandbox, SandboxPathError, sandboxTools } from '../src/agent/sandbox.js';
import { createDeepAgent } from '../src/deep-agent/index.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { SchemaValidator } from '../src/security/schema-validator.js';
import type { CompletionRequest, ContentPart, Message, ToolDefinition, ToolOutput } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-workspace-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const wav = Uint8Array.from([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function workspace(name: string): { root: string; sandbox: Sandbox } {
  const root = path.join(scratch, name);
  const put = (file: string, content: string | Uint8Array) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  put('c.ts', 'export const c = 3;\n');
  put('src/a.ts', 'const value = 1;\n// TODO: fix the rounding\nexport const Other = 2;\n');
  put('src/deep/b.ts', `export const long = '${'y'.repeat(100)}TODO${'z'.repeat(1_000)}';\n`);
  put('src/d.js', 'module.exports = {};\n');
  put('src/e.json', '{}\n');
  put('notes.md', 'todo: call the bank about the invoice total, see docs/invoice.pdf\n');
  put('minified.js', `${'x'.repeat(5_000)}TODO\n`);
  put('binary.dat', Uint8Array.from([84, 79, 68, 79, 0, 0, 1]));
  put('large.txt', `TODO\n${'w'.repeat(1_100_000)}\n`);
  put('node_modules/pkg/index.ts', '// TODO: vendored\n');
  put('.git/hooks/pre-commit.ts', '// TODO: hook\n');
  put('docs/invoice.pdf', pdf);
  put('media/chart.png', png);
  put('media/memo.wav', wav);
  put('media/readme.txt', 'not media\n');
  return { root, sandbox: processSandbox({ root }) };
}

const run = (tools: ToolDefinition[], name: string, args: Record<string, unknown>) => {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found?.execute, `${name} is offered`);
  return found.execute(args);
};
const declared = (tools: ToolDefinition[], name: string, args: Record<string, unknown>) => {
  const capabilities = tools.find((candidate) => candidate.name === name)?.capabilities;
  return typeof capabilities === 'function' ? capabilities(args) : capabilities;
};

test('globs match within and across segments, alternatives, and no directory at all for **/', () => {
  const ts = globMatcher('**/*.ts');
  assert.ok(ts('a.ts'));
  assert.ok(ts('src/deep/b.ts'));
  assert.ok(!ts('src/a.tsx'));
  assert.ok(globMatcher('src/*.{js,json}')('src/e.json'));
  assert.ok(!globMatcher('src/*.{js,json}')('src/deep/e.json'));
  assert.ok(globMatcher('./src/?.ts')('src/a.ts'));
  assert.ok(globMatcher('src\\**')('src/deep/b.ts'), 'a backslash is a separator');
  assert.ok(!globMatcher('*.TS')('a.ts'), 'matching is case-sensitive');
  assert.ok(globMatcher('a+b(1).ts')('a+b(1).ts'), 'other characters are literal');
});

test('the process sandbox finds files by glob, skips .git and node_modules, and never leaves its root', async () => {
  const { root, sandbox } = workspace('glob');
  assert.deepEqual(await sandbox.glob?.('**/*.ts'), ['c.ts', 'src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(await sandbox.glob?.('*.ts', { cwd: 'src' }), ['src/a.ts'], 'the glob is relative to cwd');
  assert.deepEqual(await sandbox.glob?.('src/*.{js,json}'), ['src/d.js', 'src/e.json']);
  assert.deepEqual(await sandbox.glob?.('**/*.ts', { limit: 1 }), ['c.ts']);
  await assert.rejects(sandbox.glob?.('**', { cwd: '../' }) as Promise<string[]>, SandboxPathError);
  await assert.rejects(sandbox.grep?.('x', { cwd: '../..' }) as Promise<unknown>, SandboxPathError);

  // A link to a directory outside the root is never followed.
  const outside = path.join(scratch, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.ts'), '// TODO: secret\n');
  let linked = true;
  try {
    symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  if (linked) {
    assert.deepEqual(await sandbox.glob?.('**/secret.ts'), []);
    assert.ok(!(await sandbox.grep?.('secret'))?.length);
  }
});

test('grep reports each matching line with its number, and skips binary, large, and vendored files', async () => {
  const { sandbox } = workspace('grep');
  const found = await sandbox.grep?.('TODO');
  assert.deepEqual(
    found?.map((match) => [match.file, match.line]),
    [
      ['src/a.ts', 2],
      ['src/deep/b.ts', 1],
    ],
    'the binary file, the 1 MB file, the match past 4,000 characters, .git, and node_modules are skipped',
  );
  assert.equal(found?.[0]?.text, '// TODO: fix the rounding');
  assert.equal(found?.[1]?.text.length, 300, 'a long line is cut to 300 characters');

  assert.deepEqual(
    (await sandbox.grep?.('todo', { ignoreCase: true, glob: '*.md' }))?.map((match) => match.file),
    ['notes.md'],
  );
  assert.deepEqual(
    (await sandbox.grep?.('TODO', { cwd: 'src', glob: 'deep/**' }))?.map((match) => match.file),
    ['src/deep/b.ts'],
  );
  assert.equal((await sandbox.grep?.('TODO', { limit: 1 }))?.length, 1);
  await assert.rejects(sandbox.grep?.('(unclosed') as Promise<unknown>, SyntaxError);
});

test('the workspace tools search and show media through the sandbox, declaring what each call reads', async () => {
  const { sandbox } = workspace('tools');
  const tools = sandboxTools(sandbox, { maxMediaBytes: 1_000 });
  for (const name of ['glob_files', 'grep_files', 'read_media']) assert.ok(tools.some((tool) => tool.name === name));

  assert.deepEqual(declared(tools, 'glob_files', { pattern: '*.ts', path: '/workspace/src' }), [
    'filesystem:read:/workspace/src',
  ]);
  assert.deepEqual(declared(tools, 'grep_files', { pattern: 'x' }), ['filesystem:read:/workspace/.']);
  assert.deepEqual(declared(tools, 'read_media', { path: 'docs/invoice.pdf' }), [
    'filesystem:read:/workspace/docs/invoice.pdf',
  ]);

  assert.equal(await run(tools, 'glob_files', { pattern: '*.ts', path: 'src' }), 'src/a.ts');
  assert.equal(await run(tools, 'glob_files', { pattern: '**/*.rs' }), 'No files match.');
  assert.equal(
    await run(tools, 'grep_files', { pattern: 'rounding|invoice', ignore_case: true }),
    'notes.md:1: todo: call the bank about the invoice total, see docs/invoice.pdf\nsrc/a.ts:2: // TODO: fix the rounding',
  );
  assert.equal(await run(tools, 'grep_files', { pattern: 'nothing-here' }), 'No lines match.');

  const parts = async (file: string) => ((await run(tools, 'read_media', { path: file })) as ToolOutput).content;
  assert.deepEqual(await parts('/workspace/media/chart.png'), [
    { type: 'text', text: 'media/chart.png (image/png, 10 bytes)' },
    { type: 'image', source: { base64: base64(png), mimeType: 'image/png' } },
  ]);
  assert.deepEqual((await parts('docs/invoice.pdf'))[1], {
    type: 'document',
    source: { base64: base64(pdf), mimeType: 'application/pdf' },
    filename: 'invoice.pdf',
  });
  assert.deepEqual((await parts('media/memo.wav'))[1], {
    type: 'audio',
    source: { base64: base64(wav), format: 'wav' },
  });
  await assert.rejects(parts('media/readme.txt') as Promise<unknown>, /not an image, audio, or PDF/);
  await assert.rejects(
    run(sandboxTools(sandbox, { maxMediaBytes: 5 }), 'read_media', { path: 'media/chart.png' }),
    /over the 5-byte limit/,
  );

  // A sandbox that cannot search or read bytes is offered none of these tools.
  const plain: Sandbox = {
    name: 'plain',
    isolation: { filesystem: true, network: true, processes: true },
    exec: sandbox.exec.bind(sandbox),
    readFile: sandbox.readFile.bind(sandbox),
    writeFile: sandbox.writeFile.bind(sandbox),
  };
  assert.deepEqual(
    sandboxTools(plain).map((tool) => tool.name),
    ['run_command', 'read_file', 'write_file'],
  );
});

/** A tool turn whose result is an image, a PDF, and audio, as read_media returns them. */
function mediaConversation(): Message[] {
  const content: ContentPart[] = [
    { type: 'text', text: 'Three files.' },
    { type: 'image', source: { base64: base64(png), mimeType: 'image/png' } },
    { type: 'document', source: { base64: base64(pdf), mimeType: 'application/pdf' }, filename: 'invoice.pdf' },
    { type: 'audio', source: { base64: base64(wav), format: 'wav' } },
  ];
  const messages: Message[] = [
    { role: 'user', content: 'What do these say?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_media', arguments: '{}' } }],
    },
    { role: 'tool', toolCallId: 'call-1', content },
  ];
  // A checkpoint stores the transcript as JSON; base64 survives it where a buffer would not.
  return JSON.parse(JSON.stringify(messages)) as Message[];
}

const meta = {
  requestId: 'r',
  providerUsed: 'mock',
  modelUsed: 'mock',
  latencyMs: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensSaved: 0,
  cacheHit: false,
  guardrailsApplied: [],
};

test('a document part passes the request schema, and an unknown part type still does not', () => {
  const validator = new SchemaValidator();
  assert.deepEqual(validator.validate({ model: 'm', messages: mediaConversation() }), []);
  const findings = validator.validate({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'spreadsheet' } as never] }],
  });
  assert.match(findings[0]?.message ?? '', /text, image, audio, video, document, tool_reference, or asset/);
});

test('Anthropic sends a PDF a tool read as a document block inside its tool result', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test' });
  let params: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    messages: {
      async create(sent: Record<string, unknown>) {
        params = sent;
        return { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
      },
    },
  };
  await provider.complete({ model: 'claude-sonnet-5-5', messages: mediaConversation() });
  const messages = params.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const result = messages[2]?.content[0] as { type: string; content: Array<Record<string, unknown>> };
  assert.equal(result.type, 'tool_result');
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Three files.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64(png) } },
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64(pdf) },
      title: 'invoice.pdf',
    },
    // Claude takes no audio; without a transcript the model is told the audio is there.
    { type: 'text', text: '[audio content is not yet supported for this provider]' },
  ]);
});

test('OpenAI chat sends tool media after the results: a PDF as a file, audio only to an audio model', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const provider = new OpenAIProvider({ apiKey: 'test' });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          sent.push(params);
          return { model: 'gpt-4o', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      },
    },
  };
  await provider.complete({ model: 'gpt-4o', messages: mediaConversation() });
  await provider.complete({ model: 'gpt-4o-audio-preview', messages: mediaConversation() });

  const [plain, hearing] = sent.map((params) => params.messages as Array<Record<string, unknown>>);
  assert.deepEqual(
    plain?.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user'],
  );
  assert.equal(plain?.[2]?.content, 'Three files.');
  assert.deepEqual(plain?.[3]?.content, [
    { type: 'text', text: 'Files the tools returned:' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64(png)}` } },
    { type: 'file', file: { filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${base64(pdf)}` } },
    { type: 'text', text: '[audio content is not yet supported for this provider]' },
  ]);
  const heard = (hearing?.[3]?.content as Array<Record<string, unknown>> | undefined)?.at(-1);
  assert.deepEqual(heard, { type: 'input_audio', input_audio: { data: base64(wav), format: 'wav' } });
});

test('OpenAI Responses sends a PDF a tool read as an input file after the results', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test' });
  let params: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    responses: {
      async create(sent: Record<string, unknown>) {
        params = sent;
        return { model: 'gpt-5.6-sol', output_text: 'ok', status: 'completed', output: [] };
      },
    },
  };
  await provider.complete({ model: 'gpt-5.6-sol', messages: mediaConversation() });
  const input = params.input as Array<Record<string, unknown>>;
  const output = input.find((item) => item.type === 'function_call_output');
  assert.equal(output?.output, 'Three files.');
  const files = input.at(-1)?.content as Array<Record<string, unknown>>;
  assert.equal(files[0]?.text, 'Files the tools returned:');
  assert.deepEqual(files[2], {
    type: 'input_file',
    filename: 'invoice.pdf',
    file_data: `data:application/pdf;base64,${base64(pdf)}`,
  });
  assert.equal(files[3]?.type, 'input_text', 'the Responses API takes no audio input');
});

test('Google sends a PDF and audio a tool read as inline data beside its function response', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    await new GoogleProvider({ apiKey: 'test' }).complete({ model: 'gemini-3.5-flash', messages: mediaConversation() });
  } finally {
    globalThis.fetch = original;
  }
  const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const parts = contents[2]?.parts ?? [];
  assert.deepEqual(parts[0], { functionResponse: { name: 'read_media', response: { result: 'Three files.' } } });
  assert.deepEqual(
    parts.slice(1).map((part) => (part.inlineData as { mimeType: string }).mimeType),
    ['image/png', 'application/pdf', 'audio/wav'],
  );
  assert.equal((parts[2]?.inlineData as { data: string } | undefined)?.data, base64(pdf));
});

test('a deep agent searches its workspace, then reads the PDF it found as a document', async () => {
  const { sandbox } = workspace('deep');
  const requests: CompletionRequest[] = [];
  let ids = 0;
  const call = (name: string, args: unknown) => ({
    id: `call-${++ids}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  const reply = (partial: Partial<NexusResponse>): NexusResponse =>
    ({ content: '', role: 'assistant', finishReason: 'stop', meta, ...partial }) as NexusResponse;
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const results = request.messages.filter((message) => message.role === 'tool');
      if (results.length === 0) {
        return reply({ toolCalls: [call('grep_files', { pattern: 'invoice', glob: '**/*.md' })] });
      }
      if (results.length === 1) {
        const found = /docs\/\S+\.pdf/.exec(JSON.parse(String(results[0]?.content)) as string)?.[0];
        if (!found) return reply({ content: 'No invoice found.' });
        return reply({ toolCalls: [call('read_media', { path: found })] });
      }
      const parts = results[1]?.content;
      const document = Array.isArray(parts) ? parts.find((part) => part.type === 'document') : undefined;
      return reply({ content: document ? 'I read the invoice.' : 'The invoice did not arrive as a document.' });
    },
  };
  const agent = createDeepAgent({ client: model, planning: false, sandbox });
  const outcome = await agent.invoke(agentInput('What does the invoice say?'), { threadId: 'invoice' });
  assert.equal(outcome.state.answer, 'I read the invoice.');

  const offered = requests[0]?.tools?.map((tool) => tool.name) ?? [];
  for (const name of ['glob_files', 'grep_files', 'read_media']) assert.ok(offered.includes(name), name);
  const system = requests[0]?.messages[0]?.content;
  assert.match(String(system), /glob_files[\s\S]*grep_files[\s\S]*read_media/);
});
