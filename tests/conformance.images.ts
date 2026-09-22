/**
 * Image provider conformance, from recordings.
 *
 *   tsx tests/conformance.images.ts --record   runs the suite live and writes recordings
 *   tsx tests/conformance.images.ts            replays the recordings, with no credentials
 *
 * Recording needs OPENAI_API_KEY, GOOGLE_API_KEY, or COMFYUI_URL, and generates a handful of small
 * images on each backend it can reach, which costs a few cents. Replay needs nothing, runs in CI, and
 * fails on any conformance failure. A backend without recordings is reported, never counted as a pass:
 * the image family leaves experimental only when all three have recordings that pass.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ComfyUIImageProvider } from '../src/images/comfyui.js';
import { GoogleImageProvider } from '../src/images/google.js';
import { OpenAIImageProvider } from '../src/images/openai.js';
import { runImageProviderConformance } from '../src/testing/image-provider-conformance.js';
import { type MatchInput, recordingFetch, replayFetch } from '../src/testing/record.js';
import type { ImageProvider } from '../src/types/images.js';

const record = process.argv.includes('--record');
const root = path.resolve('tests/fixtures/images');

interface Backend {
  name: string;
  /** Present when recording is possible here. */
  credential: string | undefined;
  create(fetch: typeof globalThis.fetch, credential: string): ImageProvider;
  model?: string;
  /** How requests match recordings, when the body carries something random. */
  match?: (request: MatchInput) => string;
}

const backends: Backend[] = [
  {
    name: 'openai',
    credential: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_IMAGE_CONFORMANCE_MODEL ?? 'gpt-image-1',
    create: (fetch, apiKey) => new OpenAIImageProvider({ apiKey, fetch }),
  },
  {
    name: 'google',
    credential: process.env.GOOGLE_API_KEY,
    model: process.env.GOOGLE_IMAGE_CONFORMANCE_MODEL ?? 'imagen-4.0-generate-001',
    create: (fetch, apiKey) => new GoogleImageProvider({ apiKey, fetch }),
  },
  {
    name: 'comfyui',
    credential: process.env.COMFYUI_URL,
    create: (fetch, baseUrl) => new ComfyUIImageProvider({ baseUrl, fetch }),
    // A ComfyUI workflow carries a random client id and seed, so requests are matched by method,
    // URL, and order rather than body.
    match: ({ method, url }) => `${method} ${url}`,
  },
];

async function hasRecordings(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).some((file) => file.endsWith('.json'));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let failures = 0;
  const missing: string[] = [];

  for (const backend of backends) {
    const directory = path.join(root, backend.name);
    let provider: ImageProvider;
    let flush: (() => Promise<void>) | undefined;

    if (record) {
      if (!backend.credential) {
        console.log(`SKIP ${backend.name}: no credential in the environment, nothing recorded`);
        missing.push(backend.name);
        continue;
      }
      const recorder = recordingFetch({ directory, ...(backend.match ? { match: backend.match } : {}) });
      flush = recorder.flush;
      provider = backend.create(recorder, backend.credential);
    } else {
      if (!(await hasRecordings(directory))) {
        console.log(`MISSING ${backend.name}: no recordings in ${path.relative(process.cwd(), directory)}`);
        missing.push(backend.name);
        continue;
      }
      provider = backend.create(
        replayFetch({ directory, ...(backend.match ? { match: backend.match } : {}) }),
        backend.name === 'comfyui' ? 'http://127.0.0.1:8188' : 'replay-placeholder',
      );
    }

    const results = await runImageProviderConformance(backend.name, provider, {
      ...(backend.model ? { model: backend.model } : {}),
    });
    await flush?.();
    for (const result of results) {
      const ok = result.operationOk && result.abortOk !== false;
      if (!ok) failures += 1;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${backend.name} ${result.caseName}${result.error ? ` - ${result.error}` : ''}`,
      );
    }
  }

  const recorded = backends.length - missing.length;
  console.log(
    `${record ? 'Recorded' : 'Replayed'} ${recorded} of ${backends.length} image backends` +
      (missing.length
        ? `; without recordings: ${missing.join(', ')}. The image family stays experimental until all three pass.`
        : '.'),
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
