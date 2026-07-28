import assert from 'node:assert/strict';
import test from 'node:test';
import { NexusConfigBuilder } from '../src/core/config-builder.js';
import {
  ImageCapabilityError,
  ImageOperationCancelledError,
  ImageProviderError,
  ImageProviderResponseError,
  ImageSafetyError,
} from '../src/images/errors.js';
import { ImageManager } from '../src/images/manager.js';
import { MockImageProvider } from '../src/images/mock.js';
import { OpenAIImageProvider, OpenAIImageProviderError } from '../src/images/openai.js';
import { runImageProviderConformance } from '../src/testing/image-provider-conformance.js';
import type {
  AssetInput,
  ImageGenerateRequest,
  ImageProvider,
  ImageProviderCallContext,
  ImageResult,
} from '../src/types/images.js';

const INPUT_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function callContext(overrides: Partial<ImageProviderCallContext> = {}): ImageProviderCallContext {
  return {
    operationId: 'image-operation-test',
    requestId: 'image-request-test',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function byteAsset(data: Uint8Array = INPUT_BYTES, filename = 'input.png', mimeType = 'image/png'): AssetInput {
  return {
    location: { kind: 'bytes', data },
    mimeType,
    filename,
  };
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function generationProvider(
  name: string,
  generate: (request: ImageGenerateRequest, context: ImageProviderCallContext) => Promise<ImageResult>,
): ImageProvider {
  return {
    info: {
      name,
      capabilities: {
        operations: ['generate'],
        deliveryKinds: ['bytes'],
        outputFormats: ['png'],
        minCount: 1,
        maxCount: 4,
      },
    },
    generate,
  };
}

function validGeneratedResult(name: string, context: ImageProviderCallContext): ImageResult {
  return {
    assets: [
      {
        location: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) },
        mimeType: 'image/png',
        byteLength: 3,
        provenance: {
          provider: name,
          operation: 'generate',
          requestId: context.requestId,
        },
      },
    ],
    meta: {
      operationId: context.operationId,
      requestId: context.requestId,
      provider: name,
    },
  };
}

test('image config registers providers and Nexus runtime registration delegates to ImageManager', async () => {
  const configured = new MockImageProvider({ name: 'configured-mock' });
  const runtime = new MockImageProvider({ name: 'runtime-mock' });
  const nexus = new NexusConfigBuilder({ providers: {} })
    .images({
      defaultProvider: 'configured',
      providers: { configured },
      createOperationId: () => 'configured-operation',
    })
    .create();

  assert.ok(nexus.images instanceof ImageManager);
  assert.equal(nexus.hasImageProvider('configured'), true);
  assert.deepEqual(nexus.listImageProviders(), ['configured']);

  const configuredResult = await nexus.images.generate({ prompt: 'Configured provider selection' });
  assert.equal(configuredResult.meta.operationId, 'configured-operation');
  assert.equal(configuredResult.meta.provider, 'configured-mock');

  assert.equal(nexus.registerImageProvider(' runtime ', runtime), nexus);
  assert.equal(nexus.hasImageProvider('runtime'), true);
  assert.deepEqual(nexus.listImageProviders(), ['configured', 'runtime']);

  const runtimeResult = await nexus.images.generate({
    provider: 'runtime',
    prompt: 'Runtime provider selection',
  });
  assert.equal(runtimeResult.meta.provider, 'runtime-mock');
});

test('MockImageProvider deterministically generates and edits image assets', async () => {
  const provider = new MockImageProvider({ name: 'deterministic-mock' });
  const context = callContext();
  const generateRequest = {
    prompt: 'A deterministic landscape',
    count: 2,
    aspectRatio: '16:9',
    outputFormat: 'png',
    delivery: { kind: 'stored' as const, format: 'png' },
    seed: 42,
  };

  const generated = await provider.generate(generateRequest, context);
  const generatedAgain = await provider.generate(generateRequest, context);

  assert.deepEqual(generatedAgain, generated);
  assert.equal(generated.assets.length, 2);
  assert.deepEqual(
    generated.assets.map((asset) => ({
      location: asset.location,
      width: asset.width,
      height: asset.height,
      operation: asset.provenance.operation,
    })),
    generated.assets.map((asset) => ({
      location: asset.location,
      width: 1536,
      height: 864,
      operation: 'generate',
    })),
  );
  assert.notDeepEqual(generated.assets[0]?.location, generated.assets[1]?.location);

  const editRequest = {
    prompt: 'Apply a deterministic edit',
    input: byteAsset(new Uint8Array([1, 2, 3])),
    mask: {
      ...byteAsset(new Uint8Array([4, 5]), 'mask.png'),
      polarity: 'white-is-editable' as const,
    },
    references: [
      {
        location: { kind: 'stored' as const, uri: 'mock://assets/reference', assetId: 'reference' },
        mimeType: 'image/png',
      },
    ],
    delivery: { kind: 'stored' as const, format: 'png' },
    seed: 7,
  };
  const edited = await provider.edit(editRequest, context);
  const editedAgain = await provider.edit(editRequest, context);

  assert.deepEqual(editedAgain, edited);
  assert.equal(edited.assets[0]?.provenance.operation, 'edit');
  assert.equal(edited.assets[0]?.provenance.parentAssetIds?.length, 3);
  assert.equal(edited.assets[0]?.provenance.parentAssetIds?.[2], 'reference');
  assert.deepEqual(edited.usage, {
    inputImages: 3,
    outputImages: 1,
    inputBytes: 5,
    outputBytes: 0,
    megapixels: 1.048576,
  });
});

test('ImageManager rejects requests outside declared provider capabilities', async () => {
  const manager = new ImageManager({
    defaultProvider: 'limited',
    providers: {
      limited: new MockImageProvider({
        name: 'limited',
        capabilities: { supportsSeed: false, supportsNegativePrompt: false },
      }),
    },
  });

  await assert.rejects(manager.generate({ prompt: 'Unsupported seeded request', seed: 99 }), (error: unknown) => {
    assert.ok(error instanceof ImageCapabilityError);
    assert.equal(error.code, 'IMAGE_CAPABILITY_ERROR');
    assert.equal(error.provider, 'limited');
    assert.equal(error.option, 'seed');
    assert.equal(error.requestedValue, 99);
    return true;
  });

  const privateNegativePrompt = 'confidential-negative-prompt-marker';
  await assert.rejects(
    manager.generate({ prompt: 'Unsupported negative prompt', negativePrompt: privateNegativePrompt }),
    (error: unknown) => {
      assert.ok(error instanceof ImageCapabilityError);
      assert.equal(error.option, 'negativePrompt');
      assert.equal(error.requestedValue, undefined);
      assert.doesNotMatch(error.message, new RegExp(privateNegativePrompt));
      return true;
    },
  );
});

test('submit emits queued, running, and succeeded events in sequence', async () => {
  let clockTick = 0;
  const manager = new ImageManager({
    providers: { mock: new MockImageProvider() },
    createOperationId: () => 'ordered-operation',
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clockTick++)),
  });
  const handle = manager.submit('generate', { prompt: 'Ordered operation' });

  assert.equal(handle.id, 'ordered-operation');
  assert.equal(handle.status(), 'queued');
  const eventsPromise = collectEvents(handle.events());
  const result = await handle.result();
  const events = await eventsPromise;

  assert.equal(handle.status(), 'succeeded');
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      status: event.status,
      sequence: event.sequence,
      operationId: event.operationId,
    })),
    [
      { type: 'queued', status: 'queued', sequence: 1, operationId: 'ordered-operation' },
      { type: 'running', status: 'running', sequence: 2, operationId: 'ordered-operation' },
      { type: 'succeeded', status: 'succeeded', sequence: 3, operationId: 'ordered-operation' },
    ],
  );
  const succeeded = events[2];
  assert.ok(succeeded?.type === 'succeeded');
  assert.equal(succeeded.result, result);
  assert.equal(handle.cancel('too late'), false);
});

test('submit cancellation aborts in-flight work and emits a terminal cancelled event', async () => {
  const manager = new ImageManager({
    providers: { mock: new MockImageProvider({ latencyMs: 60_000 }) },
    createOperationId: () => 'cancelled-operation',
  });
  const handle = manager.submit({ operation: 'generate', request: { prompt: 'Long-running image' } });
  const eventsPromise = collectEvents(handle.events());

  await Promise.resolve();
  assert.equal(handle.status(), 'running');
  assert.equal(handle.cancel('user requested stop'), true);
  assert.equal(handle.cancel('duplicate stop'), false);

  await assert.rejects(handle.result(), (error: unknown) => {
    assert.ok(error instanceof ImageOperationCancelledError);
    assert.equal(error.code, 'IMAGE_OPERATION_CANCELLED');
    assert.equal(error.operationId, 'cancelled-operation');
    assert.equal(error.reason, 'user requested stop');
    return true;
  });

  const events = await eventsPromise;
  assert.equal(handle.status(), 'cancelled');
  assert.deepEqual(
    events.map((event) => [event.sequence, event.type, event.status]),
    [
      [1, 'queued', 'queued'],
      [2, 'running', 'running'],
      [3, 'cancelling', 'cancelling'],
      [4, 'cancelled', 'cancelled'],
    ],
  );
});

test('ImageManager rejects malformed results and wraps unexpected provider failures', async () => {
  const malformed = generationProvider('malformed', async (_request, context) => ({
    assets: [],
    meta: {
      operationId: context.operationId,
      requestId: context.requestId,
      provider: 'malformed',
    },
  }));
  const malformedManager = new ImageManager({ providers: { malformed } });

  await assert.rejects(malformedManager.generate({ prompt: 'Malformed response' }), (error: unknown) => {
    assert.ok(error instanceof ImageProviderResponseError);
    assert.equal(error.code, 'IMAGE_PROVIDER_RESPONSE_ERROR');
    assert.equal(error.provider, 'malformed');
    assert.match(error.message, /assets must be a non-empty array/);
    return true;
  });

  const cause = new TypeError('provider implementation exploded');
  const throwing = generationProvider('throwing', async () => {
    throw cause;
  });
  const throwingManager = new ImageManager({ providers: { throwing } });

  await assert.rejects(throwingManager.generate({ prompt: 'Wrapped failure' }), (error: unknown) => {
    assert.ok(error instanceof ImageProviderError);
    assert.equal(error.name, 'ImageProviderError');
    assert.equal(error.code, 'IMAGE_PROVIDER_ERROR');
    assert.equal(error.provider, 'throwing');
    assert.equal(error.cause, cause);
    assert.equal(error.message, 'Image generate failed for provider "throwing"');
    return true;
  });
});

test('ImageManager rejects provider results that violate the normalized response contract', async () => {
  const cases: Array<{
    name: string;
    request?: Partial<ImageGenerateRequest>;
    mutate?: (result: ImageResult) => void;
    message: RegExp;
  }> = [
    { name: 'wrong-count', request: { count: 2 }, message: /asset count 1 does not match requested count 2/ },
    {
      name: 'wrong-meta-provider',
      mutate: (result) => {
        result.meta.provider = 'different-provider';
      },
      message: /meta\.provider must match/,
    },
    {
      name: 'wrong-provenance',
      mutate: (result) => {
        const asset = result.assets[0];
        if (asset) asset.provenance.operation = 'edit';
      },
      message: /provenance\.operation must be "generate"/,
    },
    {
      name: 'wrong-mime',
      mutate: (result) => {
        const asset = result.assets[0];
        if (asset) asset.mimeType = 'image/jpeg';
      },
      message: /mimeType must be "image\/png"/,
    },
    {
      name: 'wrong-delivery',
      mutate: (result) => {
        const asset = result.assets[0];
        if (asset) asset.location = { kind: 'url', url: 'https://assets.example.test/image.png' };
      },
      message: /location\.kind must match requested delivery kind "bytes"/,
    },
    {
      name: 'wrong-byte-length',
      mutate: (result) => {
        const asset = result.assets[0];
        if (asset) asset.byteLength = 99;
      },
      message: /byteLength does not match/,
    },
  ];

  for (const testCase of cases) {
    const provider = generationProvider(testCase.name, async (_request, context) => {
      const result = validGeneratedResult(testCase.name, context);
      testCase.mutate?.(result);
      return result;
    });
    const manager = new ImageManager({ providers: { [testCase.name]: provider } });

    await assert.rejects(
      manager.generate({
        prompt: 'Validate the normalized result',
        outputFormat: 'png',
        delivery: { kind: 'bytes', format: 'png' },
        ...testCase.request,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ImageProviderResponseError);
        assert.match(error.message, testCase.message);
        return true;
      },
    );
  }
});

test('ImageManager runs visual safety hooks and preserves non-blocking findings', async () => {
  const contexts: string[] = [];
  const manager = new ImageManager({
    providers: { mock: new MockImageProvider() },
    safety: {
      inspectInput: (_request, context) => {
        contexts.push(`input:${context.operation}:${context.provider}`);
        return [
          {
            id: 'input-review',
            category: 'brand-review',
            severity: 'low',
            action: 'review',
            source: 'input',
          },
        ];
      },
      inspectOutput: (_result, context) => {
        contexts.push(`output:${context.operation}:${context.provider}`);
        return [
          {
            id: 'output-allow',
            category: 'visual-policy',
            severity: 'low',
            action: 'allow',
            source: 'output',
          },
        ];
      },
    },
  });

  const result = await manager.generate({ prompt: 'Safety hook coverage' });

  assert.deepEqual(contexts, ['input:generate:mock', 'output:generate:mock']);
  assert.deepEqual(
    result.safetyFindings?.map((finding) => finding.id),
    ['input-review', 'output-allow'],
  );
});

test('ImageManager blocks before the provider when input safety returns a blocking finding', async () => {
  let providerCalled = false;
  const provider = generationProvider('guarded', async (_request, context) => {
    providerCalled = true;
    return {
      assets: [],
      meta: { operationId: context.operationId, requestId: context.requestId, provider: 'guarded' },
    };
  });
  const manager = new ImageManager({
    providers: { guarded: provider },
    safety: {
      inspectInput: () => [
        {
          id: 'blocked-input',
          category: 'unsafe-visual-request',
          severity: 'high',
          action: 'block',
          source: 'input',
        },
      ],
    },
  });

  await assert.rejects(manager.generate({ prompt: 'Blocked before provider' }), (error: unknown) => {
    assert.ok(error instanceof ImageSafetyError);
    assert.equal(error.code, 'IMAGE_SAFETY_ERROR');
    assert.deepEqual(
      error.findings.map((finding) => finding.id),
      ['blocked-input'],
    );
    return true;
  });
  assert.equal(providerCalled, false);
});

test('runImageProviderConformance passes generate, edit, and abort checks for the mock provider', async () => {
  const results = await runImageProviderConformance('mock', new MockImageProvider(), { testAbort: true });

  assert.deepEqual(results, [
    {
      providerName: 'mock',
      model: 'mock-image-v1',
      caseName: 'basic-image-generation',
      operation: 'generate',
      operationOk: true,
      abortOk: true,
      error: undefined,
    },
    {
      providerName: 'mock',
      model: 'mock-image-v1',
      caseName: 'basic-image-edit',
      operation: 'edit',
      operationOk: true,
      abortOk: true,
      error: undefined,
    },
  ]);
});

test('runImageProviderConformance only exercises operations declared by a provider', async () => {
  const provider = new MockImageProvider({ capabilities: { operations: ['edit'] } });
  const results = await runImageProviderConformance('edit-only', provider);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.operation, 'edit');
  assert.equal(results[0]?.operationOk, true);
});

test('runImageProviderConformance rejects relative URL delivery locations', async () => {
  const provider: ImageProvider = {
    info: {
      name: 'relative-url',
      capabilities: {
        operations: ['generate'],
        deliveryKinds: ['url'],
        outputFormats: ['png'],
        minCount: 1,
        maxCount: 1,
      },
    },
    generate: async (_request, context) => ({
      assets: [
        {
          location: { kind: 'url', url: '/relative/image.png' },
          mimeType: 'image/png',
          provenance: { provider: 'relative-url', operation: 'generate', requestId: context.requestId },
        },
      ],
      meta: { provider: 'relative-url', operationId: context.operationId, requestId: context.requestId },
    }),
  };

  const results = await runImageProviderConformance('relative-url', provider);
  assert.equal(results[0]?.operationOk, false);
  assert.match(results[0]?.error ?? '', /absolute HTTP\(S\) URL/);
});

test('OpenAIImageProvider sends JSON generation requests and normalizes byte results', async () => {
  const responseBody = {
    created: 1_700_000_000,
    data: [
      { b64_json: Buffer.from([1, 2, 3]).toString('base64'), revised_prompt: 'A revised prompt' },
      { b64_json: Buffer.from([4, 5]).toString('base64') },
    ],
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      total_tokens: 12,
      input_tokens_details: { image_tokens: 3, text_tokens: 2 },
    },
  };
  let captured: { input: string; init: RequestInit } | undefined;
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    captured = { input: String(input), init: init ?? {} };
    return jsonResponse(responseBody, 200, { 'x-request-id': 'req_openai_generate' });
  };
  const provider = new OpenAIImageProvider({
    apiKey: 'test-api-key',
    baseUrl: 'https://images.example.test/v1/',
    organization: 'org_test',
    project: 'project_test',
    defaultHeaders: { 'x-client-test': 'images' },
    defaultModel: 'gpt-image-test',
    includeRawResponse: true,
    fetch: fakeFetch,
  });
  const context = callContext({ idempotencyKey: 'idem-generate' });

  const result = await provider.generate(
    {
      prompt: 'Generate two test images',
      model: 'auto',
      count: 2,
      dimensions: { width: 1024, height: 1024 },
      quality: 'high',
      outputFormat: 'webp',
      delivery: { kind: 'bytes', format: 'webp' },
      background: 'opaque',
    },
    context,
  );

  assert.ok(captured);
  assert.equal(captured.input, 'https://images.example.test/v1/images/generations');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.signal, context.signal);
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-api-key');
  assert.equal(headers.get('openai-organization'), 'org_test');
  assert.equal(headers.get('openai-project'), 'project_test');
  assert.equal(headers.get('idempotency-key'), 'idem-generate');
  assert.equal(headers.get('x-client-test'), 'images');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    model: 'gpt-image-test',
    prompt: 'Generate two test images',
    n: 2,
    size: '1024x1024',
    quality: 'high',
    output_format: 'webp',
    background: 'opaque',
  });

  assert.equal(result.assets.length, 2);
  assert.ok(result.assets[0]?.location.kind === 'bytes');
  assert.deepEqual([...result.assets[0].location.data], [1, 2, 3]);
  assert.equal(result.assets[0].mimeType, 'image/webp');
  assert.equal(result.assets[0].byteLength, 3);
  assert.equal(result.assets[0].provenance.operation, 'generate');
  assert.deepEqual(result.usage, {
    outputImages: 2,
    outputBytes: 5,
    providerUnits: {
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      inputImageTokens: 3,
      inputTextTokens: 2,
    },
  });
  assert.deepEqual(result.warnings, [
    {
      code: 'provider.revised_prompt',
      message: 'OpenAI revised the image prompt',
      option: 'prompt',
      requestedValue: 'A revised prompt',
    },
  ]);
  assert.deepEqual(result.meta.metadata, {
    providerRequestId: 'req_openai_generate',
    providerCreatedAt: new Date(responseBody.created * 1000).toISOString(),
  });
  assert.deepEqual(result.raw, responseBody);
});

test('OpenAIImageProvider sends multipart image edits without overriding the form content type', async () => {
  let captured: { input: string; init: RequestInit } | undefined;
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    captured = { input: String(input), init: init ?? {} };
    return jsonResponse({ data: [{ b64_json: Buffer.from([9, 8, 7]).toString('base64') }] });
  };
  const provider = new OpenAIImageProvider({ apiKey: 'edit-key', fetch: fakeFetch });
  const context = callContext({ idempotencyKey: 'idem-edit' });

  const result = await provider.edit(
    {
      prompt: 'Edit the supplied images',
      model: 'gpt-image-2',
      count: 1,
      dimensions: { width: 1024, height: 1536 },
      quality: 'medium',
      outputFormat: 'jpeg',
      delivery: { kind: 'bytes', format: 'jpeg' },
      background: 'opaque',
      input: byteAsset(new Uint8Array([1, 2, 3]), 'source.png'),
      references: [byteAsset(new Uint8Array([4, 5]), 'reference.jpg', 'image/jpeg')],
    },
    context,
  );

  assert.ok(captured);
  assert.equal(captured.input, 'https://api.openai.com/v1/images/edits');
  assert.equal(captured.init.method, 'POST');
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer edit-key');
  assert.equal(headers.get('idempotency-key'), 'idem-edit');
  assert.equal(headers.has('content-type'), false);

  const form = captured.init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'gpt-image-2');
  assert.equal(form.get('prompt'), 'Edit the supplied images');
  assert.equal(form.get('n'), '1');
  assert.equal(form.get('size'), '1024x1536');
  assert.equal(form.get('quality'), 'medium');
  assert.equal(form.get('output_format'), 'jpeg');
  assert.equal(form.get('background'), 'opaque');

  const files = form.getAll('image[]');
  assert.equal(files.length, 2);
  const source = files[0];
  const reference = files[1];
  assert.ok(source && typeof source !== 'string');
  assert.ok(reference && typeof reference !== 'string');
  assert.equal(source.name, 'source.png');
  assert.equal(source.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await source.arrayBuffer())], [1, 2, 3]);
  assert.equal(reference.name, 'reference.jpg');
  assert.equal(reference.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await reference.arrayBuffer())], [4, 5]);

  assert.ok(result.assets[0]?.location.kind === 'bytes');
  assert.deepEqual([...result.assets[0].location.data], [9, 8, 7]);
  assert.equal(result.assets[0].mimeType, 'image/jpeg');
  assert.equal(result.assets[0].provenance.operation, 'edit');
});

test('OpenAIImageProvider normalizes moderation failures into provider safety details', async () => {
  const responseBody = {
    error: {
      code: 'moderation_blocked',
      moderation_details: {
        moderation_stage: 'output',
        categories: ['violence', 123, 'graphic'],
      },
    },
  };
  const fakeFetch: typeof globalThis.fetch = async () =>
    jsonResponse(responseBody, 400, { 'x-request-id': 'req_moderation' });
  const provider = new OpenAIImageProvider({ apiKey: 'moderation-key', fetch: fakeFetch });

  await assert.rejects(provider.generate({ prompt: 'A blocked image request' }, callContext()), (error: unknown) => {
    assert.ok(error instanceof OpenAIImageProviderError);
    assert.equal(error.name, 'OpenAIImageProviderError');
    assert.equal(error.code, 'IMAGE_PROVIDER_ERROR');
    assert.equal(error.provider, 'openai');
    assert.equal(error.status, 400);
    assert.equal(error.requestId, 'req_moderation');
    assert.equal(error.apiCode, 'moderation_blocked');
    assert.equal(error.message, 'OpenAI image request was blocked by moderation');
    assert.deepEqual(error.moderation, {
      moderationStage: 'output',
      categories: ['violence', 'graphic'],
    });
    assert.deepEqual(error.safetyFindings, [
      {
        id: 'openai-moderation-1',
        category: 'violence',
        severity: 'high',
        action: 'block',
        source: 'output',
      },
      {
        id: 'openai-moderation-2',
        category: 'graphic',
        severity: 'high',
        action: 'block',
        source: 'output',
      },
    ]);
    assert.deepEqual(error.cause, responseBody);
    return true;
  });
});
