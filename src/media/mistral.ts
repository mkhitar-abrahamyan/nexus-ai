import { wireDocument, wireImage } from '../providers/content.js';
import {
  type MediaCallContext,
  MediaError,
  type MediaInput,
  type MediaPage,
  type MediaProvider,
  type MediaProviderInfo,
  type MediaReadRequest,
  type MediaText,
} from './index.js';

/** Options for Mistral's OCR service. */
export interface MistralOcrProviderOptions {
  /** Mistral API key. */
  apiKey: string;
  /** The OCR model. Defaults to `mistral-ocr-latest`. */
  model?: string;
  /** API base URL. Defaults to `https://api.mistral.ai/v1`. */
  baseUrl?: string;
  /** How tables are written: `markdown` by default, or `html`. */
  tableFormat?: 'markdown' | 'html';
  /**
   * Price per page, in US dollars, to report each reading's cost. Mistral prices OCR by the page; set
   * the rate your account pays. Without it, a result carries the page count and no cost.
   */
  pricePerPage?: number;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

interface OcrResponse {
  pages?: Array<{
    index?: number;
    markdown?: string;
    dimensions?: { width?: number; height?: number };
    images?: Array<{
      id?: string;
      top_left_x?: number;
      top_left_y?: number;
      bottom_right_x?: number;
      bottom_right_y?: number;
    }>;
  }>;
  model?: string;
  usage_info?: { pages_processed?: number; doc_size_bytes?: number };
}

/**
 * Mistral's OCR service (`/v1/ocr`): a PDF, slide deck, document, or image read into Markdown page by
 * page, with each page's size and the boxes of the pictures on it. It reads; describe and answer go
 * to a vision model. A medium is sent as a data URI, or by its URL.
 */
export class MistralOcrProvider implements MediaProvider {
  /** Its name and what it does: reading images and documents. */
  readonly info: MediaProviderInfo = {
    name: 'mistral-ocr',
    capabilities: { tasks: ['read'], inputs: ['image', 'document'] },
  };

  constructor(private readonly options: MistralOcrProviderOptions) {}

  /** Reads a medium's text, page by page. */
  async read(request: MediaReadRequest, context: MediaCallContext): Promise<MediaText> {
    const model = this.options.model ?? 'mistral-ocr-latest';
    const body = {
      model,
      document: ocrDocument(request.media),
      ...(request.pages?.length ? { pages: [...request.pages] } : {}),
      include_image_base64: false,
      ...(this.options.tableFormat ? { table_format: this.options.tableFormat } : {}),
    };
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(
      `${(this.options.baseUrl ?? 'https://api.mistral.ai/v1').replace(/\/+$/, '')}/ocr`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: context.signal,
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new MediaError(`Mistral OCR answered ${response.status}: ${text.slice(0, 300)}`, 'MEDIA_UNSUPPORTED');
    const payload = JSON.parse(text) as OcrResponse;
    const pages: MediaPage[] = (payload.pages ?? []).map((page, position) => ({
      index: page.index ?? position,
      text: page.markdown ?? '',
      ...(page.dimensions?.width ? { width: page.dimensions.width } : {}),
      ...(page.dimensions?.height ? { height: page.dimensions.height } : {}),
      ...(page.images?.length
        ? {
            images: page.images.map((image, index) => ({
              id: image.id ?? `img-${index}`,
              ...(image.top_left_x !== undefined
                ? {
                    box: {
                      left: image.top_left_x,
                      top: image.top_left_y ?? 0,
                      right: image.bottom_right_x ?? image.top_left_x,
                      bottom: image.bottom_right_y ?? image.top_left_y ?? 0,
                    },
                  }
                : {}),
            })),
          }
        : {}),
    }));
    const processed = payload.usage_info?.pages_processed ?? pages.length;
    return {
      provider: this.info.name,
      model: payload.model ?? model,
      usage: { pages: processed },
      ...(this.options.pricePerPage !== undefined
        ? { cost: { amount: processed * this.options.pricePerPage, currency: 'USD', basis: 'estimated' as const } }
        : {}),
      pages,
      text: pages.map((page) => page.text).join('\n\n'),
    };
  }
}

/** A medium as Mistral's document field: a data URI, or the URL that holds it. */
function ocrDocument(media: MediaInput): Record<string, string> {
  if (media.type === 'image') {
    const wire = wireImage(media);
    if (!wire) throw new MediaError('Mistral OCR reads an image from its bytes or a URL, not a path', 'MEDIA_INVALID');
    return {
      type: 'image_url',
      image_url: wire.kind === 'url' ? wire.url : `data:${wire.mimeType};base64,${wire.data}`,
    };
  }
  const wire = wireDocument(media);
  if (!wire) throw new MediaError('Mistral OCR reads a document from its bytes or a URL, not a path', 'MEDIA_INVALID');
  return {
    type: 'document_url',
    document_url: wire.kind === 'url' ? wire.url : `data:${wire.mimeType};base64,${wire.data}`,
    document_name: wire.filename,
  };
}
