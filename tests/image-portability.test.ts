import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { decodePng, encodePng, readImageDimensions, sniffImageType } from '../src/images/codec.js';
import { ComfyUIImageProvider } from '../src/images/comfyui.js';
import { MediaEvalRunner, MemoryReviewQueue, perceptualSimilarity, stats, textAccuracy } from '../src/images/evals.js';
import {
  ImageCapabilityError,
  ImageProviderError,
  ImageSafetyError,
  ImageValidationError,
} from '../src/images/errors.js';
import { GoogleImageProvider } from '../src/images/google.js';
import { ImageInputError, ImageInputResolver } from '../src/images/inputs.js';
import { ImageManager } from '../src/images/manager.js';
import { MockImageProvider } from '../src/images/mock.js';
import { combineSafetyPolicies, createOpenAIVisualModeration } from '../src/images/moderation.js';
import { OpenAIImageProvider } from '../src/images/openai.js';
import { PngMaskTransformer } from '../src/images/transform.js';
import { runImageProviderConformance } from '../src/testing/image-provider-conformance.js';
import type {
  AssetInput,
  ImageEditRequest,
  ImageMaskInput,
  ImageProvider,
  ImageProviderCallContext,
  ImageResult,
  ImageSafetyContext,
} from '../src/types/images.js';

type Rgba = [number, number, number, number];

function solidPng(width: number, height: number, colour: Rgba): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set(colour, index * 4);
  return encodePng({ width, height, data });
}

/** Left half one colour, right half another. */
function splitPng(width: number, height: number, left: Rgba, right: Rgba): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(x < width / 2 ? left : right, (y * width + x) * 4);
  }
  return encodePng({ width, height, data });
}

function pngAsset(bytes: Uint8Array, filename = 'image.png'): AssetInput {
  return { location: { kind: 'bytes', data: bytes }, mimeType: 'image/png', filename };
}

function maskAsset(bytes: Uint8Array, overrides: Partial<ImageMaskInput> = {}): ImageMaskInput {
  return { ...pngAsset(bytes, 'mask.png'), polarity: 'white-is-editable', ...overrides };
}

function callContext(overrides: Partial<ImageProviderCallContext> = {}): ImageProviderCallContext {
  return { operationId: 'op-1', requestId: 'req-1', signal: new AbortController().signal, ...overrides };
}

function safetyContext(): ImageSafetyContext {
  return { ...callContext(), operation: 'generate', provider: 'mock' };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A PNG header that claims a canvas far too large to decode, carried in a few dozen bytes. */
function pngHeaderClaiming(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

// ---------------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------------

test('PNG encode and decode round-trip RGBA pixels exactly', () => {
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
  const decoded = decodePng(encodePng({ width: 2, height: 2, data }));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data], [...data]);
});

test('PNG decoder expands greyscale-with-alpha to RGBA', () => {
  // The literal 1 × 1 grey+alpha PNG the conformance harness ships.
  const bytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
    0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78,
    68, 174, 66, 96, 130,
  ]);
  const decoded = decodePng(bytes);
  assert.equal(decoded.data.length, 4);
  assert.equal(decoded.data[0], decoded.data[1]);
  assert.equal(decoded.data[1], decoded.data[2]);
});

test('PNG decoder refuses a pixel bomb from its header before inflating', () => {
  assert.throws(() => decodePng(pngHeaderClaiming(100_000, 100_000), { maxPixels: 1_000_000 }), ImageValidationError);
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a PNG/);
});

test('image sniffing identifies formats by content and reads header dimensions', () => {
  const png = solidPng(7, 3, [0, 0, 0, 255]);
  assert.deepEqual(sniffImageType(png), { format: 'png', mimeType: 'image/png' });
  assert.deepEqual(readImageDimensions(png), { width: 7, height: 3 });

  const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 44, 1, 200, 0]);
  assert.equal(sniffImageType(gif)?.format, 'gif');
  assert.deepEqual(readImageDimensions(gif), { width: 300, height: 200 });

  // SOI, an APP0 segment to skip, then SOF0 with height 480 and width 640.
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0,
  ]);
  assert.equal(sniffImageType(jpeg)?.mimeType, 'image/jpeg');
  assert.deepEqual(readImageDimensions(jpeg), { width: 640, height: 480 });

  const webp = new Uint8Array(30);
  webp.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88]);
  webp.set([0x7f, 0x07, 0x00], 24); // width - 1 = 1919
  webp.set([0x37, 0x04, 0x00], 27); // height - 1 = 1079
  assert.equal(sniffImageType(webp)?.format, 'webp');
  assert.deepEqual(readImageDimensions(webp), { width: 1920, height: 1080 });

  assert.equal(sniffImageType(new TextEncoder().encode('<svg></svg>')), undefined);
  assert.equal(readImageDimensions(new TextEncoder().encode('not an image')), undefined);
});

// ---------------------------------------------------------------------------------------------------
// Mask transformation
// ---------------------------------------------------------------------------------------------------

test('mask transformer converts polarity into each provider semantics', () => {
  const transformer = new PngMaskTransformer();
  // Left half white, right half black: with white-is-editable, the left half is editable.
  const mask = maskAsset(splitPng(4, 2, [255, 255, 255, 255], [0, 0, 0, 255]));

  const alpha = decodePng(
    (
      transformer.prepareMask(mask, { width: 4, height: 2, semantics: 'alpha-transparent-is-editable' }).location as {
        data: Uint8Array;
      }
    ).data,
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => alpha.data[x * 4 + 3]),
    [0, 0, 255, 255],
  );

  const prepared = transformer.prepareMask(mask, { width: 4, height: 2, semantics: 'white-is-editable' });
  assert.equal(prepared.coverage, 0.5);
  assert.equal(prepared.mimeType, 'image/png');
  const white = decodePng((prepared.location as { data: Uint8Array }).data);
  assert.deepEqual(
    [0, 3].map((x) => white.data[x * 4]),
    [255, 0],
  );

  const inverted = transformer.prepareMask(
    maskAsset(splitPng(4, 2, [255, 255, 255, 255], [0, 0, 0, 255]), { polarity: 'black-is-editable' }),
    {
      width: 4,
      height: 2,
      semantics: 'black-is-editable',
    },
  );
  const black = decodePng((inverted.location as { data: Uint8Array }).data);
  // Black-is-editable in, black-is-editable out: the black right half stays the editable black half.
  assert.deepEqual(
    [0, 3].map((x) => black.data[x * 4]),
    [255, 0],
  );
});

test('mask transformer treats partial transparency as non-editable rather than widening the edit', () => {
  const transformer = new PngMaskTransformer();
  const translucentWhite = maskAsset(solidPng(2, 2, [255, 255, 255, 60]));
  const prepared = transformer.prepareMask(translucentWhite, { width: 2, height: 2, semantics: 'white-is-editable' });
  assert.equal(prepared.coverage, 0);
});

test('mask transformer resizes only when asked, and contain padding is never editable', () => {
  const transformer = new PngMaskTransformer();
  const square = solidPng(2, 2, [255, 255, 255, 255]);

  assert.throws(
    () => transformer.prepareMask(maskAsset(square), { width: 4, height: 2, semantics: 'white-is-editable' }),
    /resizeMode/,
  );

  const stretched = transformer.prepareMask(maskAsset(square, { resizeMode: 'stretch' }), {
    width: 4,
    height: 2,
    semantics: 'white-is-editable',
  });
  assert.equal(stretched.coverage, 1);
  assert.equal(stretched.width, 4);

  const contained = transformer.prepareMask(maskAsset(square, { resizeMode: 'contain' }), {
    width: 4,
    height: 2,
    semantics: 'white-is-editable',
  });
  assert.equal(contained.coverage, 0.5);

  const covered = transformer.prepareMask(maskAsset(square, { resizeMode: 'cover' }), {
    width: 4,
    height: 2,
    semantics: 'white-is-editable',
  });
  assert.equal(covered.coverage, 1);
});

test('mask transformer refuses non-PNG and unresolved masks with capability errors', () => {
  const transformer = new PngMaskTransformer();
  const target = { width: 1, height: 1, semantics: 'white-is-editable' as const, provider: 'test' };
  const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
  assert.throws(
    () => transformer.prepareMask({ ...maskAsset(gif), mimeType: 'image/gif' }, target),
    ImageCapabilityError,
  );
  assert.throws(
    () =>
      transformer.prepareMask(
        {
          location: { kind: 'url', url: 'https://example.test/mask.png' },
          mimeType: 'image/png',
          polarity: 'white-is-editable',
        },
        target,
      ),
    ImageCapabilityError,
  );
  assert.throws(() => new PngMaskTransformer({ threshold: 300 }), ImageValidationError);
});

// ---------------------------------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------------------------------

async function rejectsWith(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ImageInputError, `expected ImageInputError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    assert.equal(error.code, 'IMAGE_INPUT_REJECTED');
    return true;
  });
}

const resolverContext = (option = 'input') => ({ option, signal: new AbortController().signal });

test('input resolver validates byte inputs by content, not by claim', async () => {
  const resolver = new ImageInputResolver();
  const png = solidPng(4, 4, [1, 2, 3, 255]);

  const resolved = await resolver
    .resolve({ ...pngAsset(png), mimeType: 'image/jpg; charset=binary' as string }, resolverContext())
    .catch((error: unknown) => error);
  assert.ok(resolved instanceof ImageInputError && resolved.reason === 'mime-mismatch');

  const ok = await resolver.resolve({ ...pngAsset(png), mimeType: 'application/octet-stream' }, resolverContext());
  assert.equal(ok.mimeType, 'image/png');

  await rejectsWith(
    resolver.resolve(pngAsset(new TextEncoder().encode('#!/bin/sh')), resolverContext()),
    'unsupported-type',
  );
  await rejectsWith(resolver.resolve(pngAsset(new Uint8Array()), resolverContext()), 'unsupported-type');

  const bmp = new Uint8Array(26);
  bmp.set([66, 77]);
  await rejectsWith(
    resolver.resolve({ ...pngAsset(bmp), mimeType: 'image/bmp' }, resolverContext()),
    'unsupported-type',
  );
});

test('input resolver enforces byte and pixel ceilings before any decode', async () => {
  const small = new ImageInputResolver({ maxBytes: 64 });
  await rejectsWith(small.resolve(pngAsset(solidPng(64, 64, [9, 9, 9, 255])), resolverContext()), 'too-large');

  const resolver = new ImageInputResolver({ maxPixels: 1_000_000 });
  await rejectsWith(
    resolver.resolve(pngAsset(pngHeaderClaiming(50_000, 50_000)), resolverContext()),
    'too-many-pixels',
  );

  // A JPEG with no frame header cannot be measured, so its pixel ceiling cannot be enforced.
  const unmeasurable = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xd9, 0, 0]);
  const jpegAsset = { location: { kind: 'bytes' as const, data: unmeasurable }, mimeType: 'image/jpeg' };
  await rejectsWith(resolver.resolve(jpegAsset, resolverContext()), 'unmeasurable');
  const lenient = new ImageInputResolver({ allowUnmeasurableDimensions: true });
  assert.equal((await lenient.resolve(jpegAsset, resolverContext())).mimeType, 'image/jpeg');

  assert.throws(() => new ImageInputResolver({ maxPixels: 0 }), ImageValidationError);
});

test('input resolver blocks loopback, private, and metadata URLs by default', async () => {
  const resolver = new ImageInputResolver();
  const urlAsset = (url: string): AssetInput => ({ location: { kind: 'url', url }, mimeType: 'image/png' });

  await rejectsWith(resolver.resolve(urlAsset('http://127.0.0.1/image.png'), resolverContext()), 'blocked-url');
  await rejectsWith(
    resolver.resolve(urlAsset('http://169.254.169.254/latest/meta-data'), resolverContext()),
    'blocked-url',
  );
  await rejectsWith(resolver.resolve(urlAsset('file:///etc/passwd'), resolverContext()), 'blocked-url');

  const rebinding = new ImageInputResolver({ resolveHostname: async () => ['10.0.0.5'] });
  await rejectsWith(rebinding.resolve(urlAsset('https://images.example/cat.png'), resolverContext()), 'blocked-url');
});

test('input resolver fetches remote images, and refuses oversize bodies and mislabelled content', async (context) => {
  const png = solidPng(8, 8, [200, 100, 50, 255]);
  const server = createServer((request, response) => {
    if (request.url === '/cat.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from(png));
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: '/cat.png' });
      response.end();
    } else if (request.url === '/lying.jpg') {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(Buffer.from(png));
    } else if (request.url === '/huge.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.alloc(4096, 1));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const urlAsset = (path: string): AssetInput => ({
    location: { kind: 'url', url: `${base}${path}` },
    mimeType: 'image/png',
  });

  const resolver = new ImageInputResolver({ allowPrivateNetworks: true, maxBytes: 1024 });
  const fetched = await resolver.resolve(urlAsset('/redirect'), resolverContext());
  assert.equal(fetched.location.kind, 'bytes');
  assert.deepEqual([...(fetched.location as { data: Uint8Array }).data], [...png]);
  assert.equal(fetched.filename, 'redirect');

  await rejectsWith(resolver.resolve(urlAsset('/lying.jpg'), resolverContext()), 'mime-mismatch');
  await rejectsWith(resolver.resolve(urlAsset('/huge.png'), resolverContext()), 'too-large');
  await rejectsWith(resolver.resolve(urlAsset('/missing.png'), resolverContext()), 'fetch-failed');
});

test('input resolver reads stored assets through a tenant-scoped store', async () => {
  const png = solidPng(2, 2, [0, 0, 0, 255]);
  const store = {
    get: async (assetId: string, tenantId: string) =>
      assetId === 'a1' && tenantId === 't1'
        ? { location: { kind: 'bytes' as const, data: png }, mimeType: 'image/png', filename: 'stored.png' }
        : undefined,
  };
  const stored: AssetInput = { location: { kind: 'stored', uri: 'store://a1', assetId: 'a1' }, mimeType: 'image/png' };

  const resolver = new ImageInputResolver({ store: store as never });
  const resolved = await resolver.resolve(stored, { ...resolverContext(), tenantId: 't1' });
  assert.equal(resolved.filename, 'stored.png');

  await rejectsWith(resolver.resolve(stored, resolverContext()), 'not-found');
  await rejectsWith(resolver.resolve(stored, { ...resolverContext(), tenantId: 'other' }), 'not-found');
  await rejectsWith(new ImageInputResolver().resolve(stored, resolverContext()), 'not-found');
});

test('ImageManager resolves edit inputs before capability checks, and skips resolution when unset', async () => {
  const png = solidPng(4, 4, [5, 5, 5, 255]);
  const seen: ImageEditRequest[] = [];
  const provider = new MockImageProvider({ capabilities: { inputLocationKinds: ['bytes'] } });
  const recording: ImageProvider = {
    info: provider.info,
    generate: (request, context) => provider.generate(request, context),
    edit: (request, context) => {
      seen.push(request);
      return provider.edit(request, context);
    },
  };
  const remote: ImageEditRequest = {
    prompt: 'edit',
    input: { location: { kind: 'url', url: 'https://images.example/in.png' }, mimeType: 'image/png' },
    mask: {
      location: { kind: 'url', url: 'https://images.example/mask.png' },
      mimeType: 'image/png',
      polarity: 'black-is-editable',
    },
  };

  const unresolved = new ImageManager({ providers: { mock: recording } });
  await assert.rejects(unresolved.edit(remote), ImageCapabilityError);

  const options: string[] = [];
  const manager = new ImageManager({
    providers: { mock: recording },
    tenantId: 'tenant-7',
    inputResolver: {
      resolve: (asset, context) => {
        options.push(`${context.option}:${context.tenantId}`);
        return { ...asset, location: { kind: 'bytes', data: png } };
      },
    },
  });
  await manager.edit(remote);
  assert.deepEqual(options.sort(), ['input:tenant-7', 'mask:tenant-7']);
  assert.equal(seen[0]?.input.location.kind, 'bytes');
  assert.equal(seen[0]?.mask?.location.kind, 'bytes');
  // Resolution replaces the location but keeps the mask's own fields.
  assert.equal(seen[0]?.mask?.polarity, 'black-is-editable');

  let generateResolved = false;
  const generating = new ImageManager({
    providers: { mock: provider },
    inputResolver: {
      resolve: (asset) => {
        generateResolved = true;
        return asset;
      },
    },
  });
  await generating.generate({ prompt: 'no inputs to resolve' });
  assert.equal(generateResolved, false);
});

// ---------------------------------------------------------------------------------------------------
// OpenAI masks
// ---------------------------------------------------------------------------------------------------

test('OpenAIImageProvider converts a neutral mask to alpha-transparent-is-editable', async () => {
  let form: FormData | undefined;
  const provider = new OpenAIImageProvider({
    apiKey: 'key',
    fetch: async (_input, init) => {
      form = init?.body as FormData;
      return jsonResponse({ data: [{ b64_json: Buffer.from(solidPng(4, 2, [0, 0, 0, 255])).toString('base64') }] });
    },
  });

  await provider.edit(
    {
      prompt: 'fill the left half',
      input: pngAsset(solidPng(4, 2, [10, 10, 10, 255])),
      mask: maskAsset(splitPng(4, 2, [255, 255, 255, 255], [0, 0, 0, 255])),
      background: 'transparent',
      outputFormat: 'png',
    },
    callContext(),
  );

  const mask = form?.get('mask');
  assert.ok(mask && typeof mask !== 'string');
  const decoded = decodePng(new Uint8Array(await mask.arrayBuffer()));
  assert.deepEqual(
    [0, 3].map((x) => decoded.data[x * 4 + 3]),
    [0, 255],
  );
  assert.equal(form?.get('background'), 'transparent');

  await assert.rejects(
    provider.edit(
      {
        prompt: 'mismatched',
        input: pngAsset(solidPng(8, 8, [0, 0, 0, 255])),
        mask: maskAsset(solidPng(4, 4, [255, 255, 255, 255])),
      },
      callContext(),
    ),
    /resizeMode/,
  );
  await assert.rejects(
    provider.generate({ prompt: 'transparent jpeg', background: 'transparent', outputFormat: 'jpeg' }, callContext()),
    ImageCapabilityError,
  );
});

test('OpenAIImageProvider uses an injected mask transformer', async () => {
  const calls: string[] = [];
  const provider = new OpenAIImageProvider({
    apiKey: 'key',
    maskTransformer: {
      prepareMask: (mask, target) => {
        calls.push(`${target.semantics}:${target.width}x${target.height}`);
        return { ...mask, width: target.width, height: target.height, coverage: 1 };
      },
    },
    fetch: async () => jsonResponse({ data: [{ b64_json: Buffer.from([1]).toString('base64') }] }),
  });
  await provider.edit(
    { prompt: 'edit', input: pngAsset(solidPng(3, 5, [0, 0, 0, 255])), mask: maskAsset(new Uint8Array([1])) },
    callContext(),
  );
  assert.deepEqual(calls, ['alpha-transparent-is-editable:3x5']);
});

// ---------------------------------------------------------------------------------------------------
// Google Imagen
// ---------------------------------------------------------------------------------------------------

test('GoogleImageProvider sends predict requests with aspect ratio, seed, and negative prompt', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const provider = new GoogleImageProvider({
    apiKey: 'g-key',
    personGeneration: 'dont_allow',
    includeRawResponse: true,
    fetch: async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return jsonResponse({
        predictions: [
          { bytesBase64Encoded: Buffer.from([1, 2]).toString('base64'), mimeType: 'image/png' },
          { bytesBase64Encoded: Buffer.from([3]).toString('base64'), mimeType: 'image/png' },
        ],
      });
    },
  });

  const result = await provider.generate(
    { prompt: 'a lighthouse', count: 2, aspectRatio: '16:9', seed: 42, negativePrompt: 'fog', outputFormat: 'png' },
    callContext(),
  );

  assert.ok(captured);
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict');
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get('x-goog-api-key'), 'g-key');
  assert.equal(headers.get('authorization'), null);
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    instances: [{ prompt: 'a lighthouse' }],
    parameters: {
      sampleCount: 2,
      outputOptions: { mimeType: 'image/png' },
      aspectRatio: '16:9',
      negativePrompt: 'fog',
      personGeneration: 'dont_allow',
      seed: 42,
      addWatermark: false,
    },
  });
  assert.equal(result.assets.length, 2);
  assert.equal(result.meta.provider, 'google');
  assert.equal(result.warnings?.[0]?.code, 'provider.watermark_disabled');
  assert.ok(result.raw);

  await assert.rejects(
    provider.generate({ prompt: 'sized', dimensions: { width: 1024, height: 1024 } }, callContext()),
    (error: unknown) => error instanceof ImageCapabilityError && error.option === 'dimensions',
  );
  await assert.rejects(
    provider.generate({ prompt: 'webp', outputFormat: 'webp' }, callContext()),
    ImageCapabilityError,
  );
  assert.throws(() => new GoogleImageProvider({}), ImageValidationError);
});

test('GoogleImageProvider inpaints with a white-is-editable mask reference and a bearer token', async () => {
  let body: Record<string, unknown> = {};
  let headers = new Headers();
  const provider = new GoogleImageProvider({
    accessToken: 'vertex-token',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/',
    fetch: async (input, init) => {
      assert.match(String(input), /publishers\/google\/models\/imagen-3\.0-capability-001:predict$/);
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return jsonResponse({ predictions: [{ bytesBase64Encoded: Buffer.from([7]).toString('base64') }] });
    },
  });

  const result = await provider.edit(
    {
      prompt: 'add a boat',
      input: pngAsset(solidPng(4, 2, [0, 0, 255, 255])),
      // Black-is-editable in: Imagen must receive the right half as white.
      mask: maskAsset(splitPng(4, 2, [255, 255, 255, 255], [0, 0, 0, 255]), { polarity: 'black-is-editable' }),
    },
    callContext(),
  );

  assert.equal(headers.get('authorization'), 'Bearer vertex-token');
  assert.equal(headers.get('x-goog-api-key'), null);
  const instance = (body.instances as Array<{ referenceImages: Array<Record<string, unknown>> }>)[0];
  assert.equal(instance?.referenceImages[0]?.referenceType, 'REFERENCE_TYPE_RAW');
  const maskReference = instance?.referenceImages[1] ?? {};
  assert.equal(maskReference.referenceType, 'REFERENCE_TYPE_MASK');
  assert.deepEqual(maskReference.maskImageConfig, { maskMode: 'MASK_MODE_USER_PROVIDED' });
  const maskBytes = Buffer.from(
    (maskReference.referenceImage as { bytesBase64Encoded: string }).bytesBase64Encoded,
    'base64',
  );
  const decoded = decodePng(new Uint8Array(maskBytes));
  assert.deepEqual(
    [0, 3].map((x) => decoded.data[x * 4]),
    [0, 255],
  );
  assert.equal((body.parameters as Record<string, unknown>).editMode, 'EDIT_MODE_INPAINT_INSERTION');
  assert.equal(result.assets[0]?.provenance.operation, 'edit');
});

test('GoogleImageProvider keeps images that passed when Imagen filters part of a batch', async () => {
  const provider = new GoogleImageProvider({
    apiKey: 'key',
    fetch: async () =>
      jsonResponse({
        predictions: [
          { bytesBase64Encoded: Buffer.from(solidPng(1, 1, [0, 0, 0, 255])).toString('base64'), mimeType: 'image/png' },
          { raiFilteredReason: 'filtered for safety' },
        ],
      }),
  });

  const manager = new ImageManager({ providers: { google: provider } });
  const result = await manager.generate({ prompt: 'two images', count: 2, outputFormat: 'png' });
  assert.equal(result.assets.length, 1);
  assert.equal(result.warnings?.[0]?.code, 'provider.partial_result');
  assert.equal(result.safetyFindings?.[0]?.metadata?.withheld, true);

  const allFiltered = new GoogleImageProvider({
    apiKey: 'key',
    fetch: async () => jsonResponse({ predictions: [{ raiFilteredReason: 'filtered' }] }),
  });
  await assert.rejects(allFiltered.generate({ prompt: 'filtered' }, callContext()), ImageProviderError);

  const failing = new GoogleImageProvider({
    apiKey: 'key',
    fetch: async () => jsonResponse({ error: { message: 'quota exhausted' } }, 429),
  });
  await assert.rejects(failing.generate({ prompt: 'x' }, callContext()), /quota exhausted/);
});

test('ImageManager still blocks a result when a non-withheld output finding blocks', async () => {
  const manager = new ImageManager({
    providers: { mock: new MockImageProvider() },
    safety: {
      inspectOutput: () => [
        { id: 'b', category: 'x', severity: 'high', action: 'block', source: 'output', assetIndex: 0 },
      ],
    },
  });
  await assert.rejects(manager.generate({ prompt: 'blocked' }), ImageSafetyError);
});

// ---------------------------------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------------------------------

interface ComfyFake {
  fetch: typeof globalThis.fetch;
  calls: string[];
  prompts: Array<Record<string, unknown>>;
  uploads: Array<{ name: string; bytes: Uint8Array }>;
}

function comfyFake(
  options: { pendingPolls?: number; status?: 'error'; nodeErrors?: Record<string, unknown> } = {},
): ComfyFake {
  const calls: string[] = [];
  const prompts: Array<Record<string, unknown>> = [];
  const uploads: Array<{ name: string; bytes: Uint8Array }> = [];
  let polls = 0;
  const output = solidPng(2, 2, [9, 9, 9, 255]);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);

    if (url.pathname === '/upload/image') {
      const form = init?.body;
      assert.ok(form instanceof FormData);
      const file = form.get('image') as File;
      uploads.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      return jsonResponse({ name: `uploaded-${uploads.length}.png`, subfolder: '', type: 'input' });
    }
    if (url.pathname === '/prompt') {
      prompts.push(JSON.parse(String(init?.body)));
      return jsonResponse({ prompt_id: 'p-1', number: 1, node_errors: options.nodeErrors ?? {} });
    }
    if (url.pathname === '/history/p-1') {
      polls += 1;
      if (options.status === 'error')
        return jsonResponse({ 'p-1': { status: { status_str: 'error', messages: ['boom'] } } });
      if (polls <= (options.pendingPolls ?? 0)) return jsonResponse({});
      return jsonResponse({
        'p-1': {
          status: { status_str: 'success', completed: true },
          outputs: {
            '9': {
              images: [
                { filename: 'nexus_00001_.png', subfolder: '', type: 'output' },
                { filename: 'preview.png', subfolder: '', type: 'temp' },
              ],
            },
          },
        },
      });
    }
    if (url.pathname === '/view')
      return new Response(Buffer.from(output), { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/queue' || url.pathname === '/interrupt') return jsonResponse({});
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls, prompts, uploads };
}

test('ComfyUIImageProvider queues a workflow, polls with backoff, and downloads saved outputs', async () => {
  const fake = comfyFake({ pendingPolls: 2 });
  const provider = new ComfyUIImageProvider({
    fetch: fake.fetch,
    pollIntervalMs: 1,
    maxPollIntervalMs: 2,
    clientId: 'c-1',
  });

  const result = await provider.generate(
    { prompt: 'a fox', negativePrompt: 'blurry', seed: 1234, dimensions: { width: 768, height: 768 } },
    callContext(),
  );

  assert.equal(provider.info.isLocal, true);
  assert.deepEqual(fake.calls, [
    'POST /prompt',
    'GET /history/p-1',
    'GET /history/p-1',
    'GET /history/p-1',
    'GET /view',
  ]);
  const queued = fake.prompts[0] as {
    client_id: string;
    prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  };
  assert.equal(queued.client_id, 'c-1');
  const sampler = Object.values(queued.prompt).find((node) => node.class_type === 'KSampler');
  assert.equal(sampler?.inputs.seed, 1234);
  const latent = Object.values(queued.prompt).find((node) => node.class_type === 'EmptyLatentImage');
  assert.equal(latent?.inputs.width, 768);

  // Temp previews are not results.
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.filename, 'nexus_00001_.png');
  assert.deepEqual(result.meta.metadata, { promptId: 'p-1', seed: 1234 });
});

test('ComfyUIImageProvider records a generated seed so an unseeded run can be reproduced', async () => {
  const fake = comfyFake();
  const provider = new ComfyUIImageProvider({ fetch: fake.fetch, pollIntervalMs: 1 });
  const result = await provider.generate({ prompt: 'unseeded' }, callContext());
  assert.equal(typeof result.meta.metadata?.seed, 'number');
});

test('ComfyUIImageProvider uploads the input and a white-is-editable mask for inpainting', async () => {
  const fake = comfyFake();
  const provider = new ComfyUIImageProvider({ fetch: fake.fetch, pollIntervalMs: 1 });

  await provider.edit(
    {
      prompt: 'replace the sky',
      input: pngAsset(solidPng(4, 2, [0, 0, 0, 255]), 'photo.png'),
      mask: maskAsset(splitPng(4, 2, [0, 0, 0, 255], [255, 255, 255, 255]), { polarity: 'black-is-editable' }),
    },
    callContext(),
  );

  assert.equal(fake.uploads.length, 2);
  assert.equal(fake.uploads[0]?.name, 'photo.png');
  const mask = decodePng(fake.uploads[1]?.bytes ?? new Uint8Array());
  assert.deepEqual(
    [0, 3].map((x) => mask.data[x * 4]),
    [255, 0],
  );
  const graph = (fake.prompts[0] as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> })
    .prompt;
  const classes = Object.values(graph).map((node) => node.class_type);
  assert.ok(classes.includes('LoadImageMask'));
  assert.ok(classes.includes('VAEEncodeForInpaint'));
  assert.equal(Object.values(graph).find((node) => node.class_type === 'LoadImage')?.inputs.image, 'uploaded-1.png');
});

test('ComfyUIImageProvider surfaces graph and execution errors, and removes abandoned prompts', async () => {
  const rejected = new ComfyUIImageProvider({ fetch: comfyFake({ nodeErrors: { '5': 'bad input' } }).fetch });
  await assert.rejects(rejected.generate({ prompt: 'x' }, callContext()), /rejected the workflow/);

  const failing = comfyFake({ status: 'error' });
  await assert.rejects(
    new ComfyUIImageProvider({ fetch: failing.fetch, pollIntervalMs: 1 }).generate({ prompt: 'x' }, callContext()),
    /execution error/,
  );
  assert.ok(failing.calls.includes('POST /queue'));
  assert.ok(failing.calls.includes('POST /interrupt'));

  const slow = comfyFake({ pendingPolls: 1_000 });
  await assert.rejects(
    new ComfyUIImageProvider({ fetch: slow.fetch, pollIntervalMs: 5, timeoutMs: 20 }).generate(
      { prompt: 'x' },
      callContext(),
    ),
    /before the deadline/,
  );
  assert.ok(slow.calls.includes('POST /queue'));

  const unreachable = new ComfyUIImageProvider({
    fetch: async () => {
      throw new TypeError('connect ECONNREFUSED');
    },
  });
  await assert.rejects(unreachable.generate({ prompt: 'x' }, callContext()), /unreachable/);
});

test('runImageProviderConformance passes generate, edit, masked edit, and abort for Google and ComfyUI', async () => {
  const pixel = Buffer.from(solidPng(1, 1, [0, 0, 0, 255])).toString('base64');
  const google = new GoogleImageProvider({
    apiKey: 'key',
    fetch: async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
      return jsonResponse({ predictions: [{ bytesBase64Encoded: pixel, mimeType: 'image/png' }] });
    },
  });
  const comfy = new ComfyUIImageProvider({ fetch: comfyFake().fetch, pollIntervalMs: 1 });

  for (const [name, provider] of [
    ['google', google],
    ['comfyui', comfy],
  ] as const) {
    const results = await runImageProviderConformance(name, provider, { testAbort: true });
    assert.deepEqual(
      results.map((result) => result.caseName),
      ['basic-image-generation', 'basic-image-edit', 'masked-image-edit'],
    );
    for (const result of results) {
      assert.equal(result.operationOk, true, `${name} ${result.caseName}: ${result.error}`);
      assert.equal(result.abortOk, true, `${name} ${result.caseName} abort: ${result.error}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// Visual moderation
// ---------------------------------------------------------------------------------------------------

test('visual moderation screens prompt and images, applying block and review thresholds', async () => {
  const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
  const policy = createOpenAIVisualModeration({
    apiKey: 'mod-key',
    blockThreshold: 0.8,
    reviewThreshold: 0.4,
    categoryThresholds: { 'self-harm': { block: 0.2 } },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const isImage = body.input[0].type === 'image_url';
      return jsonResponse({
        results: [
          {
            flagged: false,
            categories: {},
            category_scores: isImage ? { violence: 0.5, 'self-harm': 0.25 } : { violence: 0.9, harassment: 0.1 },
            category_applied_input_types: { violence: [isImage ? 'image' : 'text'] },
          },
        ],
      });
    },
  });

  const findings = await policy.inspectInput?.(
    {
      prompt: 'edit this',
      input: pngAsset(new Uint8Array([1, 2, 3])),
      mask: maskAsset(new Uint8Array([4])),
      references: [{ location: { kind: 'url', url: 'https://images.example/ref.png' }, mimeType: 'image/png' }],
    },
    safetyContext(),
  );

  // Prompt, input, and one reference; the mask is geometry and is not sent.
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0]?.input[0]?.type, 'text');
  const imageUrl = (index: number) => (bodies[index]?.input[0]?.image_url as { url?: string } | undefined)?.url;
  assert.match(String(imageUrl(1)), /^data:image\/png;base64,/);
  assert.equal(imageUrl(2), 'https://images.example/ref.png');

  const summary = (findings ?? []).map(
    (finding) => `${finding.assetIndex ?? 'prompt'}:${finding.category}:${finding.action}`,
  );
  assert.deepEqual(summary.sort(), [
    '0:self-harm:block',
    '0:violence:review',
    '1:self-harm:block',
    '1:violence:review',
    'prompt:violence:block',
  ]);
});

test('visual moderation fails closed by default and marks unsendable outputs for review', async () => {
  const down = createOpenAIVisualModeration({
    apiKey: 'k',
    fetch: async () => new Response('unavailable', { status: 503 }),
  });
  const findings = await down.inspectInput?.({ prompt: 'hello' }, safetyContext());
  assert.equal(findings?.[0]?.category, 'moderation-unavailable');
  assert.equal(findings?.[0]?.action, 'block');

  const open = createOpenAIVisualModeration({
    apiKey: 'k',
    failOpen: true,
    fetch: async () => new Response('', { status: 500 }),
  });
  assert.deepEqual(await open.inspectInput?.({ prompt: 'hello' }, safetyContext()), []);

  const flagged = createOpenAIVisualModeration({
    apiKey: 'k',
    inspectInput: false,
    fetch: async () =>
      jsonResponse({ results: [{ flagged: true, categories: { sexual: true }, category_scores: { sexual: 0.95 } }] }),
  });
  assert.equal(flagged.inspectInput, undefined);
  const output: ImageResult = {
    assets: [
      { ...pngAsset(new Uint8Array([1])), provenance: { provider: 'mock', operation: 'generate', requestId: 'r' } },
      {
        location: { kind: 'stored', uri: 'store://x', assetId: 'x' },
        mimeType: 'image/png',
        provenance: { provider: 'mock', operation: 'generate', requestId: 'r' },
      },
    ],
    meta: { operationId: 'op', requestId: 'r', provider: 'mock' },
  };
  const outputFindings = await flagged.inspectOutput?.(output, safetyContext());
  assert.deepEqual(
    outputFindings?.map((finding) => [finding.assetIndex, finding.category, finding.action, finding.severity]),
    [
      [0, 'sexual', 'block', 'critical'],
      [1, 'uninspectable-asset', 'review', 'medium'],
    ],
  );

  assert.throws(() => createOpenAIVisualModeration({ apiKey: ' ' }), ImageValidationError);
  assert.throws(
    () => createOpenAIVisualModeration({ apiKey: 'k', blockThreshold: 0.5, reviewThreshold: 0.5 }),
    ImageValidationError,
  );
});

test('combineSafetyPolicies runs every policy and keeps all findings', async () => {
  const combined = combineSafetyPolicies(
    { inspectInput: () => [{ id: 'a', category: 'a', severity: 'low', action: 'block', source: 'input' }] },
    { inspectInput: async () => [{ id: 'b', category: 'b', severity: 'low', action: 'review', source: 'input' }] },
    { inspectOutput: () => [] },
  );
  const findings = await combined.inspectInput?.({ prompt: 'x' }, safetyContext());
  assert.deepEqual(
    findings?.map((finding) => finding.id),
    ['a', 'b'],
  );
  assert.ok(combined.inspectOutput);
  assert.equal(combineSafetyPolicies().inspectInput, undefined);
});

// ---------------------------------------------------------------------------------------------------
// Media evaluation
// ---------------------------------------------------------------------------------------------------

function evalResult(
  bytes: Uint8Array,
  overrides: Partial<ImageResult['meta']> = {},
  extra: Partial<ImageResult> = {},
): ImageResult {
  return {
    assets: [{ ...pngAsset(bytes), provenance: { provider: 'mock', operation: 'edit', requestId: 'r' } }],
    meta: { operationId: 'op', requestId: 'r', provider: 'mock', latencyMs: 100, cost: 0.04, ...overrides },
    ...extra,
  };
}

test('perceptual similarity survives re-encoding but detects a changed image', () => {
  const original = decodePng(splitPng(32, 32, [255, 255, 255, 255], [0, 0, 0, 255]));
  const nearCopy = {
    ...original,
    data: original.data.map((value, index) => (index % 4 === 3 ? value : Math.min(255, value + 3))),
  };
  const inverted = decodePng(splitPng(32, 32, [0, 0, 0, 255], [255, 255, 255, 255]));

  assert.equal(perceptualSimilarity(original, original), 1);
  assert.ok(perceptualSimilarity(original, nearCopy) > 0.95);
  assert.ok(perceptualSimilarity(original, inverted) < 0.95);
});

test('text accuracy is edit-distance based and tolerant of case and whitespace', () => {
  assert.equal(textAccuracy('Grand  Opening', 'grand opening'), 1);
  assert.equal(textAccuracy('', ''), 1);
  assert.ok(Math.abs(textAccuracy('SALE', 'SALT') - 0.75) < 1e-9);
  assert.equal(textAccuracy('abc', ''), 0);
});

test('stats reports spread and a confidence interval for repeated runs', () => {
  const single = stats([0.5]);
  assert.deepEqual(single.ci95, [0.5, 0.5]);
  const repeated = stats([0.6, 0.8, 0.7, 0.9]);
  assert.equal(repeated.n, 4);
  assert.ok(Math.abs(repeated.mean - 0.75) < 1e-9);
  assert.equal(repeated.min, 0.6);
  assert.equal(repeated.max, 0.9);
  assert.ok(repeated.ci95[0] < repeated.mean && repeated.ci95[1] > repeated.mean);
});

test('MediaEvalRunner scores alignment, text, preservation, safety, and operations across repeated runs', async () => {
  const base = splitPng(16, 16, [255, 255, 255, 255], [0, 0, 0, 255]);
  const alignments = [0.9, 0.5, 0.2];
  let alignmentCall = 0;
  const queue = new MemoryReviewQueue();

  const runner = new MediaEvalRunner(
    async (evalCase, run) => {
      if (evalCase.id === 'should-block') {
        if (run === 0) throw new ImageSafetyError('Image request was blocked by input safety policy');
        return evalResult(base);
      }
      if (evalCase.id === 'benign-blocked') throw new ImageSafetyError('blocked');
      if (evalCase.id === 'broken') throw new Error('provider exploded');
      return evalResult(base, { route: run === 1 ? ['primary', 'fallback'] : ['primary'], cost: 0.05 });
    },
    {
      runs: 3,
      reviewQueue: queue,
      reviewBands: { alignment: { min: 0.4, max: 0.6 } },
      scorers: {
        alignment: () => alignments[alignmentCall++ % alignments.length] as number,
        ocr: () => 'OPEN',
      },
    },
  );

  const report = await runner.evaluate([
    {
      id: 'poster',
      operation: 'edit',
      request: { prompt: 'poster saying OPEN', input: pngAsset(base) },
      expect: {
        minAlignment: 0.7,
        text: 'open',
        preserve: { asset: pngAsset(base), minSimilarity: 0.9 },
        maxLatencyMs: 500,
        maxCost: 0.1,
      },
      tags: ['text'],
    },
    {
      id: 'should-block',
      operation: 'generate',
      request: { prompt: 'unsafe' },
      runs: 2,
      expect: { shouldBlock: true },
    },
    {
      id: 'benign-blocked',
      operation: 'generate',
      request: { prompt: 'a kitten' },
      runs: 1,
      expect: { shouldBlock: false },
    },
    { id: 'broken', operation: 'generate', request: { prompt: 'x' }, runs: 1 },
  ]);

  const poster = report.cases[0];
  assert.ok(poster);
  // Run 0 passes, run 1 lands in the review band (queued, not failed), run 2 fails alignment.
  assert.deepEqual(
    poster.runs.map((run) => run.passed),
    [true, true, false],
  );
  assert.match(poster.runs[2]?.failures[0] ?? '', /alignment 0\.200 below 0\.7/);
  assert.equal(poster.stats.alignment?.n, 3);
  assert.equal(poster.stats.textAccuracy?.mean, 1);
  assert.equal(poster.stats.similarity?.mean, 1);
  assert.ok(Math.abs((poster.passRate ?? 0) - 2 / 3) < 1e-9);
  assert.equal(poster.passed, false);
  assert.deepEqual(poster.tags, ['text']);

  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.reason, 'alignment is uncertain');
  assert.equal(report.reviewQueued, 1);

  assert.deepEqual(
    { tp: report.safety.truePositives, fn: report.safety.falseNegatives, fp: report.safety.falsePositives },
    { tp: 1, fn: 1, fp: 1 },
  );
  assert.equal(report.safety.falseNegativeRate, 0.5);
  assert.equal(report.safety.falsePositiveRate, 1);

  assert.equal(report.operational.runs, 7);
  assert.equal(report.operational.errors, 1);
  assert.equal(report.operational.failovers, 1);
  assert.ok(Math.abs((poster.stats.cost?.mean ?? 0) - 0.05) < 1e-9);
  assert.equal(report.metrics.cost?.n, 4);
});

test('MediaEvalRunner fails clearly when a case needs a scorer that is not configured', async () => {
  const runner = new MediaEvalRunner(async () => evalResult(solidPng(1, 1, [0, 0, 0, 255])));
  await assert.rejects(
    runner.evaluate([{ id: 'x', operation: 'generate', request: { prompt: 'x' }, expect: { text: 'hello' } }]),
    /no "ocr" scorer/,
  );
  await assert.rejects(runner.evaluate([]), ImageValidationError);
  await assert.rejects(
    runner.evaluate([{ id: 'x', operation: 'generate', request: { prompt: 'x' }, runs: 0 }]),
    /must run at least once/,
  );

  const slow = new MediaEvalRunner(async () => evalResult(solidPng(1, 1, [0, 0, 0, 255]), { latencyMs: 900, cost: 2 }));
  const report = await slow.evaluate([
    { id: 'budget', operation: 'generate', request: { prompt: 'x' }, expect: { maxLatencyMs: 500, maxCost: 1 } },
  ]);
  assert.deepEqual(report.cases[0]?.runs[0]?.failures, ['latency 900ms exceeded 500ms', 'cost 2 exceeded 1']);
});
