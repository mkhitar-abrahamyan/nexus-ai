/**
 * Media understanding: reading a document's or an image's text page by page, describing an image,
 * and answering a question about either, behind one contract, through any vision model or a
 * dedicated OCR service.
 */
import { withLifecycle } from '../lifecycle/run.js';
import type { OperationLifecycleLike, ProviderCallContext } from '../types/lifecycle.js';
import type { CompletionRequest, ContentPart, DocumentContent, ImageContent } from '../types/messages.js';
import type { NexusResponse, ResponseCost } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';

/** What a media provider can be asked to do. */
export type MediaTask = 'read' | 'describe' | 'answer';

/** A medium to understand: an image or a document part, holding bytes, base64, a URL, or an asset. */
export type MediaInput = ImageContent | DocumentContent;

/** The kinds of media there are: `image` or `document`. */
export type MediaKind = MediaInput['type'];

/** Reading a medium's text. */
export interface MediaReadRequest {
  /** The image or document. */
  media: MediaInput;
  /** Only these pages, numbered from 0, on a provider that can choose. */
  pages?: readonly number[];
  /** The provider to use. Defaults to the manager's for reading. */
  provider?: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Stops the call. */
  signal?: AbortSignal;
}

/** Describing an image, or a document's look. */
export interface MediaDescribeRequest {
  /** The image or document. */
  media: MediaInput;
  /** A sentence, or a paragraph. Defaults to `brief`. */
  detail?: 'brief' | 'detailed';
  /** The provider to use. */
  provider?: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Stops the call. */
  signal?: AbortSignal;
}

/** Asking a question about one medium or several. */
export interface MediaAnswerRequest {
  /** The media the question is about. */
  media: MediaInput | readonly MediaInput[];
  /** The question. */
  question: string;
  /** The provider to use. */
  provider?: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Stops the call. */
  signal?: AbortSignal;
}

/** One page of a medium's text. An image is one page. */
export interface MediaPage {
  /** The page's number, from 0. */
  index: number;
  /** Its text, as Markdown where the provider keeps structure such as tables and headings. */
  text: string;
  /** Its width and height, in pixels, when the provider says. */
  width?: number;
  /** Its height, in pixels, when the provider says. */
  height?: number;
  /** Pictures on the page, by the provider's id, with their box when it gives one. */
  images?: Array<{ id: string; box?: { left: number; top: number; right: number; bottom: number } }>;
}

/** What a call used, where the provider reports it. */
export interface MediaUsage {
  /** Input tokens, for a model. */
  inputTokens?: number;
  /** Output tokens, for a model. */
  outputTokens?: number;
  /** Pages processed, for an OCR service. */
  pages?: number;
}

/** What every media result carries: who produced it, and what it used and cost. */
export interface MediaResultMeta {
  /** The provider that answered. */
  provider: string;
  /** The model it used. */
  model: string;
  /** What the call used. */
  usage?: MediaUsage;
  /** What it cost, when the provider or the registry prices it. */
  cost?: ResponseCost;
}

/** A medium's text, page by page. */
export interface MediaText extends MediaResultMeta {
  /** The pages, in order. */
  pages: MediaPage[];
  /** Every page's text, joined by a blank line. */
  text: string;
}

/** A description of a medium. */
export interface MediaDescription extends MediaResultMeta {
  /** A caption, a sentence or a paragraph as asked. */
  caption: string;
  /** Short alternative text, for a screen reader. */
  altText: string;
  /** A few words naming what it shows. */
  tags: string[];
}

/** An answer about media. */
export interface MediaAnswer extends MediaResultMeta {
  /** The answer. */
  answer: string;
  /** The pages, numbered from 0, it rests on, when the provider says. */
  pages?: number[];
}

/** What a media provider supports. */
export interface MediaProviderCapabilities {
  /** The tasks it performs. */
  tasks: readonly MediaTask[];
  /** The kinds of media it takes. */
  inputs: readonly MediaKind[];
}

/** Identifies a media provider and what it supports. */
export interface MediaProviderInfo {
  /** Its name, which results carry. */
  name: string;
  /** What it supports. */
  capabilities: MediaProviderCapabilities;
}

/** What every media call receives: how to stop, and the request's id. */
export interface MediaCallContext {
  /** Stops the call. */
  signal: AbortSignal;
  /** The request's id, for logs and traces. */
  requestId: string;
  /** The tenant it is for. */
  tenantId?: string;
  /**
   * The tenant's credential for a provider, with a credential resolver: an adapter sends it in place
   * of the key it was configured with.
   */
  credential?: ProviderCallContext['credential'];
}

/** A media understanding backend: a vision model, an OCR service, or a stand-in. Each task is optional. */
export interface MediaProvider {
  /** What it is and supports. */
  readonly info: MediaProviderInfo;
  /** Reads a medium's text. */
  read?(request: MediaReadRequest, context: MediaCallContext): Promise<MediaText>;
  /** Describes a medium. */
  describe?(request: MediaDescribeRequest, context: MediaCallContext): Promise<MediaDescription>;
  /** Answers a question about media. */
  answer?(request: MediaAnswerRequest, context: MediaCallContext): Promise<MediaAnswer>;
}

/** Raised for a media request no provider can serve, or a medium a provider cannot read. */
export class MediaError extends Error {
  constructor(
    message: string,
    /** A stable code: `MEDIA_NO_PROVIDER`, `MEDIA_UNSUPPORTED`, or `MEDIA_INVALID`. */
    readonly code: 'MEDIA_NO_PROVIDER' | 'MEDIA_UNSUPPORTED' | 'MEDIA_INVALID',
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** Configuration for `MediaManager`. */
export interface MediaConfig {
  /** Providers, by name. */
  providers?: Record<string, MediaProvider>;
  /** The provider each task uses when a request names none. Otherwise the first that can. */
  defaults?: Partial<Record<MediaTask, string>>;
}

/** What the manager runs on. */
export interface MediaRuntime {
  /**
   * Runs every call as one operation of a client's lifecycle, family `media`: pass `ai.lifecycle`, so
   * it is authorized, budgeted, and audited as every other call is. A vision model reached through
   * the client already is; this covers a provider that calls its service directly, such as OCR.
   */
  lifecycle?: OperationLifecycleLike;
}

/**
 * Media understanding behind one handle: each task goes to the provider named, the task's default,
 * or the first provider that performs it on that kind of medium.
 *
 * ```ts
 * const media = new MediaManager({
 *   providers: { ocr: new MistralOcrProvider({ apiKey }), vision: modelMediaProvider(ai, { model: 'gpt-5.4' }) },
 *   defaults: { read: 'ocr', describe: 'vision', answer: 'vision' },
 * });
 * const { pages } = await media.read({ media: { type: 'document', source: { buffer: pdf } } });
 * ```
 */
export class MediaManager {
  private readonly providers = new Map<string, MediaProvider>();

  constructor(
    private readonly config: MediaConfig = {},
    private readonly runtime: MediaRuntime = {},
  ) {
    for (const [name, provider] of Object.entries(config.providers ?? {})) this.registerMediaProvider(name, provider);
  }

  /** Registers a provider under a name. Returns the manager, for chaining. */
  registerMediaProvider(name: string, provider: MediaProvider): this {
    if (!name.trim()) throw new MediaError('A media provider needs a name', 'MEDIA_INVALID');
    this.providers.set(name.trim(), provider);
    return this;
  }

  /** Whether a provider is registered. */
  hasMediaProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Every registered provider's name. */
  listMediaProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Reads a medium's text, page by page. */
  read(request: MediaReadRequest): Promise<MediaText> {
    return this.run('read', request, [request.media], (provider, context) =>
      (provider.read as NonNullable<MediaProvider['read']>).call(provider, request, context),
    );
  }

  /** Describes a medium: a caption, alternative text, and tags. */
  describe(request: MediaDescribeRequest): Promise<MediaDescription> {
    return this.run('describe', request, [request.media], (provider, context) =>
      (provider.describe as NonNullable<MediaProvider['describe']>).call(provider, request, context),
    );
  }

  /** Answers a question about one medium or several. */
  answer(request: MediaAnswerRequest): Promise<MediaAnswer> {
    if (!request.question?.trim()) throw new MediaError('A media question must not be empty', 'MEDIA_INVALID');
    const media = Array.isArray(request.media) ? request.media : [request.media as MediaInput];
    return this.run('answer', request, media, (provider, context) =>
      (provider.answer as NonNullable<MediaProvider['answer']>).call(provider, request, context),
    );
  }

  private async run<T extends MediaResultMeta>(
    task: MediaTask,
    request: { provider?: string; tenantId?: string; signal?: AbortSignal },
    media: readonly MediaInput[],
    call: (provider: MediaProvider, context: MediaCallContext) => Promise<T>,
  ): Promise<T> {
    if (media.length === 0) throw new MediaError('A media request needs at least one medium', 'MEDIA_INVALID');
    for (const item of media) {
      if (item?.type !== 'image' && item?.type !== 'document') {
        throw new MediaError('A medium is an image or a document part', 'MEDIA_INVALID');
      }
    }
    const [name, provider] = this.route(task, media, request.provider);
    const requestId = generateRequestId();
    return withLifecycle(
      this.runtime.lifecycle,
      {
        family: 'media',
        operation: `media.${task}`,
        requestId,
        provider: name,
        ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
        metadata: { media: media.length },
      },
      request.signal ? { signal: request.signal } : {},
      (ticket) =>
        call(provider, {
          signal: ticket?.context.signal ?? request.signal ?? new AbortController().signal,
          requestId,
          ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
          ...(ticket?.context.credential ? { credential: ticket.context.credential } : {}),
        }),
      (result) => (result.cost ? { cost: result.cost.amount, model: result.model } : { model: result.model }),
    );
  }

  private route(task: MediaTask, media: readonly MediaInput[], named?: string): [string, MediaProvider] {
    const able = (provider: MediaProvider) =>
      provider.info.capabilities.tasks.includes(task) &&
      typeof provider[task] === 'function' &&
      media.every((item) => provider.info.capabilities.inputs.includes(item.type));
    const choice = named ?? this.config.defaults?.[task];
    if (choice) {
      const provider = this.providers.get(choice);
      if (!provider) throw new MediaError(`No media provider is registered as "${choice}"`, 'MEDIA_NO_PROVIDER');
      if (!able(provider)) {
        throw new MediaError(
          `Media provider "${choice}" cannot ${task} ${[...new Set(media.map((item) => item.type))].join(' and ')} media`,
          'MEDIA_UNSUPPORTED',
        );
      }
      return [choice, provider];
    }
    for (const entry of this.providers) if (able(entry[1])) return entry;
    throw new MediaError(`No media provider can ${task} this media`, 'MEDIA_NO_PROVIDER');
  }
}

// ── A vision model as a media provider ────────────────────────────

/** Anything that completes a request, such as a `NexusAI` client. */
export interface CompletionClientLike {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/** Options for `modelMediaProvider()`. */
export interface ModelMediaProviderOptions {
  /** The vision model, which must take the media's kinds. */
  model: string;
  /** The provider's name in results. Defaults to `model`. */
  name?: string;
  /** The kinds of media the model takes. Defaults to images and documents. */
  inputs?: readonly MediaKind[];
  /** The most tokens a reading may produce. Defaults to 8,192. */
  maxTokens?: number;
}

const READ_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, text: { type: 'string' } },
        required: ['index', 'text'],
      },
    },
  },
  required: ['pages'],
};
const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    altText: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['caption', 'altText', 'tags'],
};
const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, pages: { type: 'array', items: { type: 'integer' } } },
  required: ['answer'],
};

/**
 * Any vision model as a media provider, through a client's own `complete()`: so the call is routed,
 * authorized, budgeted, traced, and priced as every completion is. It asks for JSON, and reads a
 * plain answer as one page, or one answer, when a model gives one.
 */
export function modelMediaProvider(client: CompletionClientLike, options: ModelMediaProviderOptions): MediaProvider {
  const name = options.name ?? options.model;
  const ask = async (
    parts: ContentPart[],
    schema: Record<string, unknown>,
    context: MediaCallContext,
    maxTokens?: number,
  ) => {
    // The client's own lifecycle resolves the tenant's credential for the model it routes to.
    const response = await client.complete({
      model: options.model,
      messages: [{ role: 'user', content: parts }],
      responseFormat: { type: 'json_schema', schema },
      temperature: 0,
      signal: context.signal,
      ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
    return { response, json: parseJson(response.content) };
  };
  const meta = (response: NexusResponse): MediaResultMeta => ({
    provider: name,
    model: response.meta.modelUsed || options.model,
    usage: {
      ...(response.meta.usage?.inputTokens !== undefined ? { inputTokens: response.meta.usage.inputTokens } : {}),
      ...(response.meta.usage?.outputTokens !== undefined ? { outputTokens: response.meta.usage.outputTokens } : {}),
    },
    ...(response.meta.cost ? { cost: response.meta.cost } : {}),
  });
  return {
    info: {
      name,
      capabilities: { tasks: ['read', 'describe', 'answer'], inputs: options.inputs ?? ['image', 'document'] },
    },
    async read(request, context) {
      const pages = request.pages?.length ? ` Only pages ${request.pages.join(', ')}, numbered from 0.` : '';
      const { response, json } = await ask(
        [
          request.media,
          {
            type: 'text',
            text: `Transcribe every word of this ${request.media.type} exactly, as Markdown, keeping headings, lists, and tables. Return {"pages": [{"index": n, "text": "..."}]}, one entry per page from 0; an image is page 0.${pages}`,
          },
        ],
        READ_SCHEMA,
        context,
        options.maxTokens ?? 8_192,
      );
      const listed = Array.isArray((json as { pages?: unknown })?.pages)
        ? ((json as { pages: Array<{ index?: unknown; text?: unknown }> }).pages ?? [])
        : undefined;
      const result: MediaPage[] = listed
        ? listed.map((page, position) => ({
            index: Number.isInteger(page.index) ? (page.index as number) : position,
            text: String(page.text ?? ''),
          }))
        : [{ index: 0, text: response.content }];
      return { ...meta(response), pages: result, text: result.map((page) => page.text).join('\n\n') };
    },
    async describe(request, context) {
      const length = request.detail === 'detailed' ? 'a paragraph' : 'one sentence';
      const { response, json } = await ask(
        [
          request.media,
          {
            type: 'text',
            text: `Describe this ${request.media.type} in ${length}. Return {"caption": "...", "altText": "under 125 characters", "tags": ["three to eight words naming what it shows"]}.`,
          },
        ],
        DESCRIBE_SCHEMA,
        context,
      );
      const found = json as { caption?: unknown; altText?: unknown; tags?: unknown } | undefined;
      const caption = typeof found?.caption === 'string' ? found.caption : response.content;
      return {
        ...meta(response),
        caption,
        altText: typeof found?.altText === 'string' ? found.altText : caption.slice(0, 125),
        tags: Array.isArray(found?.tags) ? found.tags.map(String) : [],
      };
    },
    async answer(request, context) {
      const media = Array.isArray(request.media) ? request.media : [request.media as MediaInput];
      const { response, json } = await ask(
        [
          ...media,
          {
            type: 'text',
            text: `Answer from these media alone; if they do not say, answer that they do not. Return {"answer": "...", "pages": [numbers of the pages, from 0, the answer rests on]}.\n\nQuestion: ${request.question}`,
          },
        ],
        ANSWER_SCHEMA,
        context,
      );
      const found = json as { answer?: unknown; pages?: unknown } | undefined;
      return {
        ...meta(response),
        answer: typeof found?.answer === 'string' ? found.answer : response.content,
        ...(Array.isArray(found?.pages)
          ? { pages: found.pages.filter((page): page is number => Number.isInteger(page)) }
          : {}),
      };
    },
  };
}

function parseJson(text: string): unknown {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// ── Conformance ────────────────────────────────────────────────────

/** Media to check a provider with, and what its text should contain. */
export interface MediaConformanceFixtures {
  /** An image the provider should read and describe. */
  image?: MediaInput;
  /** A document the provider should read. */
  document?: MediaInput;
  /** A pattern the read text must match, such as a word printed on the media. */
  expectText?: RegExp;
  /** A question about the media, and a pattern its answer must match. */
  question?: { ask: string; expect: RegExp };
}

/** How a provider did against the media contract. */
export interface MediaConformanceReport {
  /** The provider. */
  provider: string;
  /** Checks that passed. */
  passed: string[];
  /** Checks that failed, each with why. */
  failures: string[];
}

/**
 * Checks a provider against the media contract: every task it declares returns the right shape, and
 * the text it reads holds what the fixtures say. Never throws; failures are listed.
 */
export async function runMediaConformance(
  provider: MediaProvider,
  fixtures: MediaConformanceFixtures,
): Promise<MediaConformanceReport> {
  const report: MediaConformanceReport = { provider: provider.info.name, passed: [], failures: [] };
  const context = (): MediaCallContext => ({ signal: new AbortController().signal, requestId: generateRequestId() });
  const check = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      report.passed.push(name);
    } catch (error) {
      report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const { tasks, inputs } = provider.info.capabilities;
  for (const task of tasks) {
    if (typeof provider[task] !== 'function') report.failures.push(`${task}: declared, but not implemented`);
  }
  for (const kind of inputs) {
    const media = kind === 'image' ? fixtures.image : fixtures.document;
    if (!media) continue;
    if (tasks.includes('read') && provider.read) {
      await check(`read ${kind}`, async () => {
        const result = await provider.read?.({ media }, context());
        if (!result || !Array.isArray(result.pages) || result.pages.length === 0) throw new Error('no pages');
        result.pages.forEach((page, position) => {
          if (!Number.isInteger(page.index) || typeof page.text !== 'string')
            throw new Error(`page ${position} is malformed`);
        });
        if (typeof result.text !== 'string' || !result.provider || !result.model)
          throw new Error('missing text, provider, or model');
        if (fixtures.expectText && !fixtures.expectText.test(result.text)) {
          throw new Error(`the text does not match ${fixtures.expectText}`);
        }
      });
    }
    if (tasks.includes('describe') && provider.describe) {
      await check(`describe ${kind}`, async () => {
        const result = await provider.describe?.({ media }, context());
        if (!result?.caption || typeof result.altText !== 'string' || !Array.isArray(result.tags)) {
          throw new Error('missing caption, altText, or tags');
        }
      });
    }
    if (tasks.includes('answer') && provider.answer && fixtures.question) {
      const question = fixtures.question;
      await check(`answer ${kind}`, async () => {
        const result = await provider.answer?.({ media, question: question.ask }, context());
        if (!result?.answer) throw new Error('no answer');
        if (!question.expect.test(result.answer)) throw new Error(`the answer does not match ${question.expect}`);
      });
    }
  }
  return report;
}
