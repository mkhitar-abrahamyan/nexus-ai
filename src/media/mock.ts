import type {
  MediaAnswer,
  MediaAnswerRequest,
  MediaDescribeRequest,
  MediaDescription,
  MediaInput,
  MediaProvider,
  MediaProviderInfo,
  MediaReadRequest,
  MediaText,
  MediaTask,
} from './index.js';

/** Options for the mock media provider: what it finds in each medium. */
export interface MockMediaProviderOptions {
  /** Its name. Defaults to `mock-media`. */
  name?: string;
  /** The tasks it performs. Defaults to all three. */
  tasks?: readonly MediaTask[];
  /** Each page's text in a medium. Defaults to one page naming its kind. */
  read?: (media: MediaInput) => readonly string[];
  /** A medium's caption. Defaults to its kind. */
  describe?: (media: MediaInput) => string;
  /** The answer to a question about media. Defaults to the first page of the first medium. */
  answer?: (media: readonly MediaInput[], question: string) => string;
}

/**
 * A deterministic media provider, for tests: it finds in each medium what the options say, so a test
 * can drive reading, describing, answering, and media retrieval without a model. It keeps every
 * request it was given in `calls`.
 */
export class MockMediaProvider implements MediaProvider {
  /** Its name and capabilities. */
  readonly info: MediaProviderInfo;
  /** Every request, in order, with its task. */
  readonly calls: Array<{ task: MediaTask; media: readonly MediaInput[] }> = [];

  constructor(private readonly options: MockMediaProviderOptions = {}) {
    this.info = {
      name: options.name ?? 'mock-media',
      capabilities: { tasks: options.tasks ?? ['read', 'describe', 'answer'], inputs: ['image', 'document'] },
    };
  }

  /** The pages the options give the medium. */
  async read(request: MediaReadRequest): Promise<MediaText> {
    this.calls.push({ task: 'read', media: [request.media] });
    const all = this.options.read?.(request.media) ?? [`[${request.media.type}]`];
    const pages = all
      .map((text, index) => ({ index, text }))
      .filter((page) => !request.pages?.length || request.pages.includes(page.index));
    return {
      provider: this.info.name,
      model: 'mock',
      usage: { pages: pages.length },
      pages,
      text: pages.map((page) => page.text).join('\n\n'),
    };
  }

  /** The caption the options give the medium. */
  async describe(request: MediaDescribeRequest): Promise<MediaDescription> {
    this.calls.push({ task: 'describe', media: [request.media] });
    const caption = this.options.describe?.(request.media) ?? `an ${request.media.type}`;
    return {
      provider: this.info.name,
      model: 'mock',
      caption,
      altText: caption.slice(0, 125),
      tags: caption.split(/\s+/).slice(0, 5),
    };
  }

  /** The answer the options give. */
  async answer(request: MediaAnswerRequest): Promise<MediaAnswer> {
    const media = Array.isArray(request.media) ? request.media : [request.media as MediaInput];
    this.calls.push({ task: 'answer', media });
    const answer =
      this.options.answer?.(media, request.question) ??
      this.options.read?.(media[0] as MediaInput)[0] ??
      `[${media[0]?.type}]`;
    return { provider: this.info.name, model: 'mock', answer };
  }
}
