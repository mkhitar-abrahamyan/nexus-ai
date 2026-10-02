import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { classifyRoute, summarizeVerifyFormat } from '../src/workflow/chains.js';
import { supportTriageWorkflow } from '../src/workflow/domain.js';

function response(content: string): NexusResponse {
  return {
    content,
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'test',
      providerUsed: 'mock',
      modelUsed: 'mock/test',
      latencyMs: 1,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      cacheHit: false,
      guardrailsApplied: [],
    },
  } as NexusResponse;
}

/** A client that answers each request with the next scripted reply and records what it was asked. */
function scripted(replies: string[]) {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(request: CompletionRequest) {
      requests.push(request);
      return response(replies[requests.length - 1] ?? '');
    },
  };
}

const text = (request: CompletionRequest | undefined) => String(request?.messages.at(-1)?.content ?? '');

test('summarize-verify-format without sources is two steps, and asks for the format only at the end', async () => {
  const client = scripted(['The launch moved to May.', '{"summary":"The launch moved to May."}']);
  const result = await summarizeVerifyFormat(client, {
    model: 'mock/test',
    input: 'Long notes about the launch.',
    responseFormat: { type: 'json' },
  });

  assert.deepEqual(
    result.steps.map((step) => step.step),
    ['summarize', 'format'],
  );
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0]?.responseFormat, undefined);
  assert.equal(client.requests[1]?.responseFormat?.type, 'json');
  assert.equal(result.content, '{"summary":"The launch moved to May."}');
});

test('the verify step restates the summary against the sources rather than answering it', async () => {
  const client = scripted(['The launch moved to May.', 'The launch moved to May.', 'Final: the launch moved to May.']);
  const result = await summarizeVerifyFormat(client, {
    model: 'mock/test',
    input: 'Long notes about the launch.',
    verifyContext: ['The launch moved to May.'],
  });

  assert.deepEqual(
    result.steps.map((step) => step.step),
    ['summarize', 'verify', 'format'],
  );
  const verify = text(client.requests[1]);
  assert.match(verify, /Restate this summary/);
  assert.match(verify, /\[source-1\] The launch moved to May\./);
  assert.match(verify, /Summary:\nThe launch moved to May\./);
  assert.equal(client.requests[1]?.responseFormat, undefined, 'formatting waits for the last step');
});

test('classification and domain workflows ask for JSON with their fields', async () => {
  const client = scripted(['{"label":"billing","confidence":0.9}', '{}']);
  await classifyRoute(client, { model: 'mock/test', input: 'I was charged twice', labels: ['billing', 'bug'] });
  await supportTriageWorkflow(client, { model: 'mock/test', input: 'Down for everyone', customerTier: 'enterprise' });

  assert.equal(client.requests[0]?.temperature, 0);
  assert.deepEqual(client.requests[0]?.responseFormat?.schema?.required, ['label']);
  assert.deepEqual(client.requests[1]?.responseFormat?.schema?.required, [
    'severity',
    'category',
    'nextAction',
    'reply',
  ]);
  assert.match(text(client.requests[1]), /Customer tier: enterprise/);
});
