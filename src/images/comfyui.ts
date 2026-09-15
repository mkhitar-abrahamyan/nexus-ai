import type {
  AssetDescriptor,
  AssetInput,
  ImageDimensions,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageProvider,
  ImageProviderCallContext,
  ImageProviderInfo,
  ImageResult,
} from '../types/images.js';
import {
  ImageCapabilityError,
  ImageProviderError,
  ImageProviderResponseError,
  ImageValidationError,
} from './errors.js';
import type { AssetTransformer } from './transform.js';

/** One node of a ComfyUI API-format workflow. */
export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export type ComfyWorkflow = Record<string, ComfyNode>;

export interface ComfyUploadedImage {
  name: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyWorkflowContext {
  operation: ImageOperation;
  /** Uploaded input image, present for edits. */
  input?: ComfyUploadedImage;
  /** Uploaded mask, already converted to white-is-editable, present for masked edits. */
  mask?: ComfyUploadedImage;
  /** A seed to use when the request did not supply one, so every run is reproducible after the fact. */
  seed: number;
}

/**
 * Builds the workflow graph for one request.
 *
 * ComfyUI has no fixed request shape — a workflow is an arbitrary graph — so the adapter owns the
 * queue-upload-poll-download protocol and the application owns the graph. The bundled
 * `comfyTextToImageWorkflow` and `comfyInpaintWorkflow` cover the stock Stable Diffusion shapes.
 */
export type ComfyWorkflowBuilder = (
  request: ImageGenerateRequest | ImageEditRequest,
  context: ComfyWorkflowContext,
) => ComfyWorkflow;

export interface ComfyUIImageProviderConfig {
  baseUrl?: string;
  workflow?: ComfyWorkflowBuilder;
  /** Checkpoint used by the bundled workflows. */
  checkpoint?: string;
  fetch?: typeof globalThis.fetch;
  /** Starting poll interval. Defaults to 500 ms; it backs off to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Gives up waiting for the queue after this long. Defaults to 10 minutes. */
  timeoutMs?: number;
  dimensions?: readonly ImageDimensions[];
  maskTransformer?: AssetTransformer;
  headers?: Record<string, string>;
  clientId?: string;
}

interface ComfyHistoryImage {
  filename?: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: ComfyHistoryImage[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_DIMENSIONS: readonly ImageDimensions[] = [
  { width: 512, height: 512 },
  { width: 768, height: 768 },
  { width: 1024, height: 1024 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];

/**
 * A self-hosted ComfyUI server.
 *
 * Validates the neutral contract against a backend unlike either hosted API: work is queued and
 * polled rather than answered in the response, inputs are uploaded as files the graph refers to by
 * name, outputs are fetched by filename afterwards, and a cancelled request has to be removed from
 * the queue explicitly or it keeps consuming the GPU.
 */
export class ComfyUIImageProvider implements ImageProvider {
  readonly info: ImageProviderInfo;

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly workflow: ComfyWorkflowBuilder;
  private readonly clientId: string;

  constructor(private readonly config: ComfyUIImageProviderConfig = {}) {
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new ImageValidationError('ComfyUI image provider requires a fetch implementation');
    }
    this.fetchImplementation = fetchImplementation;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.clientId = config.clientId ?? `nexus-${Math.random().toString(36).slice(2, 10)}`;
    const checkpoint = config.checkpoint ?? 'sd_xl_base_1.0.safetensors';
    this.workflow =
      config.workflow ??
      ((request, context) =>
        context.operation === 'edit'
          ? comfyInpaintWorkflow(request, context, checkpoint)
          : comfyTextToImageWorkflow(request, context, checkpoint));

    this.info = {
      name: 'comfyui',
      isLocal: true,
      version: 'comfyui-api',
      capabilities: {
        operations: ['generate', 'edit'],
        inputLocationKinds: ['bytes'],
        deliveryKinds: ['bytes'],
        inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        outputFormats: ['png'],
        dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
        minCount: 1,
        maxCount: 8,
        supportsMask: true,
        supportsReferences: false,
        supportsTransparency: false,
        supportsSeed: true,
        supportsNegativePrompt: true,
      },
    };
  }

  generate(request: ImageGenerateRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    return this.run('generate', request, context);
  }

  edit(request: ImageEditRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    return this.run('edit', request, context);
  }

  private async run(
    operation: ImageOperation,
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageProviderCallContext,
  ): Promise<ImageResult> {
    const startedAt = Date.now();
    if (request.delivery && request.delivery.kind !== 'bytes') {
      throw new ImageCapabilityError('comfyui', 'delivery', request.delivery.kind);
    }

    const seed = request.seed ?? Math.floor(Math.random() * 2 ** 32);
    const workflowContext: ComfyWorkflowContext = { operation, seed };

    if (operation === 'edit') {
      const edit = request as ImageEditRequest;
      workflowContext.input = await this.upload(edit.input, 'input', context.signal);
      if (edit.mask) {
        const transform = await import('./transform.js');
        const transformer = this.config.maskTransformer ?? transform.defaultMaskTransformer();
        const target = transform.requireImageDimensions(edit.input, 'comfyui');
        const prepared = await transformer.prepareMask(edit.mask, {
          ...target,
          semantics: 'white-is-editable',
          provider: 'comfyui',
        });
        workflowContext.mask = await this.upload(prepared, 'mask', context.signal);
      }
    }

    const graph = this.workflow(request, workflowContext);
    const queued = (await this.json('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
      signal: context.signal,
    })) as { prompt_id?: string; node_errors?: Record<string, unknown> };

    if (queued.node_errors && Object.keys(queued.node_errors).length > 0) {
      throw new ImageProviderError('ComfyUI rejected the workflow graph', 'comfyui', queued.node_errors);
    }
    const promptId = queued.prompt_id;
    if (!promptId) throw new ImageProviderResponseError('comfyui', 'the queue response carried no prompt_id');

    let entry: ComfyHistoryEntry;
    try {
      entry = await this.waitForCompletion(promptId, context);
    } catch (error) {
      // An abandoned prompt otherwise keeps running on the server.
      await this.cancel(promptId);
      throw error;
    }

    const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
    const saved = images.filter((image) => image.type !== 'temp' && image.filename);
    if (saved.length === 0) throw new ImageProviderResponseError('comfyui', 'the workflow produced no saved images');

    const assets: AssetDescriptor[] = [];
    for (const image of saved) {
      const data = await this.download(image, context.signal);
      assets.push({
        location: { kind: 'bytes', data },
        mimeType: 'image/png',
        filename: image.filename,
        byteLength: data.byteLength,
        width: request.dimensions?.width,
        height: request.dimensions?.height,
        provenance: {
          provider: 'comfyui',
          operation,
          requestId: context.requestId,
          metadata: { promptId, seed },
        },
      });
    }

    return {
      assets,
      usage: {
        outputImages: assets.length,
        outputBytes: assets.reduce((total, asset) => total + (asset.byteLength ?? 0), 0),
      },
      meta: {
        operationId: context.operationId,
        requestId: context.requestId,
        provider: 'comfyui',
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
        // The seed is recorded even when the caller did not choose one, so a good result can be
        // reproduced later.
        metadata: { promptId, seed },
      },
    };
  }

  private async waitForCompletion(promptId: string, context: ImageProviderCallContext): Promise<ComfyHistoryEntry> {
    const timeoutMs = this.config.timeoutMs ?? 10 * 60 * 1000;
    const deadline = Math.min(context.deadline ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs);
    let interval = this.config.pollIntervalMs ?? 500;
    const maxInterval = this.config.maxPollIntervalMs ?? 5_000;

    while (true) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('aborted');
      const history = (await this.json(`/history/${encodeURIComponent(promptId)}`, {
        signal: context.signal,
      })) as Record<string, ComfyHistoryEntry>;
      const entry = history[promptId];

      if (entry?.status?.status_str === 'error') {
        throw new ImageProviderError('ComfyUI reported an execution error', 'comfyui', entry.status.messages);
      }
      if (entry && (entry.status?.completed ?? Object.keys(entry.outputs ?? {}).length > 0)) return entry;

      if (Date.now() + interval > deadline) {
        throw new ImageProviderError(`ComfyUI did not finish prompt ${promptId} before the deadline`, 'comfyui');
      }
      await sleep(interval, context.signal);
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }
  }

  private async cancel(promptId: string): Promise<void> {
    try {
      await this.fetchImplementation(`${this.baseUrl}/queue`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ delete: [promptId] }),
      });
      await this.fetchImplementation(`${this.baseUrl}/interrupt`, { method: 'POST', headers: this.headers(false) });
    } catch {
      // Cancellation is best effort; the original error is the one the caller needs.
    }
  }

  private async upload(asset: AssetInput, kind: 'input' | 'mask', signal: AbortSignal): Promise<ComfyUploadedImage> {
    if (asset.location.kind !== 'bytes') {
      throw new ImageCapabilityError('comfyui', `${kind}.location`, asset.location.kind);
    }
    const form = new FormData();
    const name = asset.filename ?? `${kind}-${Date.now()}.png`;
    form.set('image', new Blob([Buffer.from(asset.location.data)], { type: asset.mimeType }), name);
    form.set('type', 'input');
    form.set('overwrite', 'true');

    const uploaded = (await this.json(
      '/upload/image',
      { method: 'POST', body: form, signal },
      false,
    )) as ComfyUploadedImage;
    if (!uploaded?.name) throw new ImageProviderResponseError('comfyui', `the ${kind} upload returned no name`);
    return uploaded;
  }

  private async download(image: ComfyHistoryImage, signal: AbortSignal): Promise<Uint8Array> {
    const query = new URLSearchParams({
      filename: image.filename ?? '',
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    });
    const response = await this.send(`/view?${query}`, { signal });
    return new Uint8Array(await response.arrayBuffer());
  }

  private async json(path: string, init: RequestInit, jsonBody = true): Promise<unknown> {
    const response = await this.send(path, { ...init, headers: this.headers(jsonBody && init.body !== undefined) });
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (error) {
      throw new ImageProviderResponseError('comfyui', `${path} did not return JSON`, error);
    }
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ImageProviderError(`ComfyUI is unreachable at ${this.baseUrl}`, 'comfyui', error);
    }
    if (!response.ok) {
      throw new ImageProviderError(
        `ComfyUI ${path} failed with HTTP ${response.status}`,
        'comfyui',
        await response.text(),
      );
    }
    return response;
  }

  private headers(json: boolean): Headers {
    const headers = new Headers(this.config.headers);
    if (json) headers.set('content-type', 'application/json');
    return headers;
  }
}

/** The stock Stable Diffusion text-to-image graph. */
export function comfyTextToImageWorkflow(
  request: ImageGenerateRequest | ImageEditRequest,
  context: ComfyWorkflowContext,
  checkpoint: string,
): ComfyWorkflow {
  const size = request.dimensions ?? { width: 1024, height: 1024 };
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt ?? '', clip: ['1', 1] } },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width: size.width, height: size.height, batch_size: request.count ?? 1 },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed: context.seed,
        steps: 25,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'nexus' } },
  };
}

/**
 * The stock inpainting graph.
 *
 * The mask arrives white-is-editable and is read from its red channel, which is what
 * `VAEEncodeForInpaint` treats as the region to repaint. Without a mask it degrades to a whole-image
 * img2img pass.
 */
export function comfyInpaintWorkflow(
  request: ImageGenerateRequest | ImageEditRequest,
  context: ComfyWorkflowContext,
  checkpoint: string,
): ComfyWorkflow {
  if (!context.input) throw new ImageValidationError('An inpaint workflow needs an uploaded input image');

  const graph: ComfyWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt ?? '', clip: ['1', 1] } },
    '4': { class_type: 'LoadImage', inputs: { image: context.input.name } },
    '6': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['5', 0],
        seed: context.seed,
        steps: 25,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: context.mask ? 1 : 0.6,
      },
    },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'nexus-edit' } },
  };

  if (context.mask) {
    graph['9'] = { class_type: 'LoadImageMask', inputs: { image: context.mask.name, channel: 'red' } };
    graph['5'] = {
      class_type: 'VAEEncodeForInpaint',
      inputs: { pixels: ['4', 0], vae: ['1', 2], mask: ['9', 0], grow_mask_by: 6 },
    };
  } else {
    graph['5'] = { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } };
  }
  return graph;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
