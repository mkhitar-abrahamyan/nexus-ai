import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectStreamOutput } from '../src/core/secure-stream.js';
import { NexusSecurityError, SecurityPipeline } from '../src/security/index.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../src/types/response.js';

function toolCall(arguments_: string, id = 'call-1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'lookup', arguments: arguments_ },
  };
}

function response(content: string, toolCalls: ToolCall[]): NexusResponse {
  return {
    content,
    role: 'assistant',
    toolCalls,
    finishReason: 'tool_calls',
    meta: {
      requestId: 'tool-call-security',
      providerUsed: 'mock',
      modelUsed: 'mock/model',
      latencyMs: 1,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      estimatedCost: '$0.00',
      cacheHit: false,
      guardrailsApplied: [],
    },
  };
}

function streamOf(chunks: StreamChunk[], onChunk?: () => void): NexusStream {
  let aborted = false;
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (aborted) return;
        onChunk?.();
        yield chunk;
      }
    },
    abort() {
      aborted = true;
    },
  };
}

test('output guard inspects and redacts sensitive tool-call arguments', () => {
  const secret = `sk-${'a'.repeat(24)}`;
  const connection = 'postgresql://admin:password@db.example.com/private';
  const security = new SecurityPipeline({
    level: 'standard',
    output: { dlp: { enabled: true, proprietaryTerms: ['Project Moonbeam'] } },
  });
  const original = response('Public response.', [
    toolCall(JSON.stringify({ email: 'alice@example.com', secret, connection, project: 'Project Moonbeam' })),
  ]);

  const result = security.protectOutput(original);
  const arguments_ = result.value.toolCalls?.[0].function.arguments || '';

  assert.equal(result.ok, true);
  assert.equal(result.value.content, original.content, 'content behavior remains independent of tool arguments');
  assert.doesNotMatch(arguments_, /alice@example\.com/);
  assert.doesNotMatch(arguments_, new RegExp(secret));
  assert.doesNotMatch(arguments_, /postgresql:\/\//);
  assert.match(arguments_, /\[REDACTED\]/);
  assert.match(arguments_, /\[REDACTED_CONNECTION_STRING\]/);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.type === 'dlp' &&
        finding.path === 'response.toolCalls[0].function.arguments' &&
        finding.value === 'Project Moonbeam',
    ),
  );
});

test('output moderation redacts tool-call arguments', () => {
  const security = new SecurityPipeline({
    level: 'standard',
    output: {
      piiRedaction: false,
      moderation: { enabled: true, forbiddenTerms: ['restricted operation'], onViolation: 'redact' },
    },
  });

  const result = security.protectOutput(response('', [toolCall('{"action":"restricted operation"}')]));

  assert.equal(result.ok, true);
  assert.equal(result.value.toolCalls?.[0].function.arguments, '{"action":"[REDACTED]"}');
  assert.equal(result.findings[0]?.path, 'response.toolCalls[0].function.arguments');
});

test('blocked tool-call arguments are not observable in a SecurityResult or error', () => {
  const blockedTopic = 'private acquisition target';
  const security = new SecurityPipeline({
    level: 'standard',
    output: { topics: { forbiddenTopics: [blockedTopic], onViolation: 'block' } },
  });

  const result = security.protectOutput(response('Safe summary.', [toolCall(`{"query":"${blockedTopic}"}`)]));

  assert.equal(result.ok, false);
  assert.equal(result.value.content, '[BLOCKED_BY_OUTPUT_GUARD]');
  assert.equal(result.value.toolCalls?.[0].function.arguments, '[BLOCKED_BY_OUTPUT_GUARD]');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(blockedTopic, 'i'));
  assert.throws(
    () => security.assertOutputSafe(result),
    (error: unknown) => {
      assert.ok(error instanceof NexusSecurityError);
      assert.doesNotMatch(error.message, new RegExp(blockedTopic, 'i'));
      return true;
    },
  );
});

test('tool-call-only streams are fully guarded before yielding sanitized calls', async () => {
  const security = new SecurityPipeline({ level: 'standard', output: { piiRedaction: true } });
  let consumed = 0;
  const source = streamOf(
    [
      { type: 'tool_call', toolCall: toolCall('{"email":"alice@example.com"}') },
      { type: 'done', meta: { requestId: 'tool-only-stream' } },
    ],
    () => {
      consumed += 1;
    },
  );
  const iterator = protectStreamOutput(source, security)[Symbol.asyncIterator]();

  const first = await iterator.next();

  assert.equal(consumed, 2, 'all provider chunks must be validated before the first downstream yield');
  assert.equal(first.value?.type, 'tool_call');
  assert.equal(first.value?.toolCall?.function.arguments, '{"email":"[REDACTED]"}');
  assert.ok(first.value?.meta?.guardrailsApplied?.includes('output-pii-redaction'));
  const done = await iterator.next();
  assert.equal(done.value?.type, 'done');
  assert.ok(done.value?.meta?.guardrailsApplied?.includes('output-pii-redaction'));
});

test('mixed streams block unsafe tool-call arguments before yielding text', async () => {
  const forbidden = 'erase production';
  const security = new SecurityPipeline({
    level: 'standard',
    output: {
      moderation: { enabled: true, forbiddenTerms: [forbidden], onViolation: 'block' },
    },
  });
  let consumed = 0;
  const source = streamOf(
    [
      { type: 'text', content: 'I will call a tool.' },
      { type: 'tool_call', toolCall: toolCall(`{"command":"${forbidden}"}`) },
      { type: 'done' },
    ],
    () => {
      consumed += 1;
    },
  );

  await assert.rejects(async () => {
    for await (const _chunk of protectStreamOutput(source, security)) {
      assert.fail('mixed blocked output must not yield any chunk');
    }
  }, NexusSecurityError);
  assert.equal(consumed, 3);
});
