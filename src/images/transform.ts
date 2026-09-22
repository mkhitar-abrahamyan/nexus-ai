import type { AssetInput, ImageMaskInput } from '../types/images.js';
import { decodePng, encodePng, readImageDimensions, sniffImageType, type RgbaImage } from './codec.js';
import { ImageCapabilityError, ImageValidationError } from './errors.js';

export {
  type DecodePngOptions,
  decodePng,
  encodePng,
  type ImageDimensionsInfo,
  type RgbaImage,
  readImageDimensions,
  type SniffedImage,
  type SniffedImageFormat,
  sniffImageType,
} from './codec.js';

/**
 * What a provider means by a mask.
 *
 * The neutral contract describes a mask by polarity — which colour marks the editable region —
 * because that is how people draw one. Providers disagree: OpenAI reads the alpha channel and edits
 * where it is fully transparent, while Imagen and most diffusion backends read a greyscale image and
 * edit where it is white. Converting between them is this module's whole job.
 */
export type MaskSemantics = 'white-is-editable' | 'black-is-editable' | 'alpha-transparent-is-editable';

/** What a mask must be converted to. */
export interface MaskTarget {
  /** How the provider reads masks. */
  semantics: MaskSemantics;
  /** Dimensions of the image the mask applies to. The prepared mask always matches them. */
  width: number;
  /** Height of the image the mask applies to. */
  height: number;
  /** The provider, named in errors. */
  provider?: string;
}

/** A mask converted for one provider, at the image's exact dimensions. */
export interface PreparedMask extends AssetInput {
  /** Width, equal to the image's. */
  width: number;
  /** Height, equal to the image's. */
  height: number;
  /** Share of pixels marked editable, between 0 and 1. */
  coverage: number;
}

/**
 * Converts a neutral mask into what one provider expects.
 *
 * An injection seam: the bundled `PngMaskTransformer` handles PNG masks, and an application with a
 * native image library can supply its own to accept JPEG or WebP masks or to resample with
 * anti-aliasing.
 */
export interface AssetTransformer {
  /** Converts a mask to the target's semantics and dimensions. */
  prepareMask(mask: ImageMaskInput, target: MaskTarget): Promise<PreparedMask> | PreparedMask;
}

/** Options for the bundled PNG mask transformer. */
export interface PngMaskTransformerOptions {
  /** Luminance, 0–255, at or above which a pixel counts as white. Defaults to 128. */
  threshold?: number;
  /** Largest mask accepted before decoding, as a guard against a decompression bomb. */
  maxPixels?: number;
}

const DEFAULT_MAX_MASK_PIXELS = 40_000_000;

/**
 * Converts PNG masks between polarities and alpha semantics, resizing with nearest-neighbour when
 * the mask's `resizeMode` allows.
 */
export class PngMaskTransformer implements AssetTransformer {
  private readonly threshold: number;
  private readonly maxPixels: number;

  constructor(options: PngMaskTransformerOptions = {}) {
    this.threshold = options.threshold ?? 128;
    this.maxPixels = options.maxPixels ?? DEFAULT_MAX_MASK_PIXELS;
    if (!Number.isInteger(this.threshold) || this.threshold < 0 || this.threshold > 255) {
      throw new ImageValidationError('Mask threshold must be an integer from 0 to 255');
    }
  }

  /**
   * Converts a PNG mask. Throws for a mask that is not PNG bytes, or of the wrong size when
   * `resizeMode` is `reject`.
   */
  prepareMask(mask: ImageMaskInput, target: MaskTarget): PreparedMask {
    if (mask.location.kind !== 'bytes') {
      throw new ImageCapabilityError(
        target.provider ?? 'mask transformer',
        'mask.location',
        mask.location.kind,
        'A mask must be resolved to bytes before it can be transformed; configure an image input resolver',
      );
    }

    const sniffed = sniffImageType(mask.location.data);
    if (sniffed?.format !== 'png') {
      throw new ImageCapabilityError(
        target.provider ?? 'mask transformer',
        'mask.mimeType',
        sniffed?.mimeType ?? mask.mimeType,
        'The bundled mask transformer reads PNG masks only; supply a custom AssetTransformer for other formats',
      );
    }

    const decoded = decodePng(mask.location.data, { maxPixels: this.maxPixels });
    const editable = this.toEditableMap(decoded, mask.polarity);
    const fitted = fitMask(editable, decoded.width, decoded.height, target, mask.resizeMode ?? 'reject');
    const rgba = render(fitted, target.width, target.height, target.semantics);

    let editableCount = 0;
    for (const cell of fitted) editableCount += cell;

    return {
      location: { kind: 'bytes', data: encodePng({ width: target.width, height: target.height, data: rgba }) },
      mimeType: 'image/png',
      filename: mask.filename ?? 'mask.png',
      width: target.width,
      height: target.height,
      coverage: editableCount / (target.width * target.height),
    };
  }

  /**
   * One byte per pixel, 1 where editable.
   *
   * A partly transparent pixel is composited over the non-editable colour first, so transparency in
   * a hand-drawn mask never silently widens the editable region.
   */
  private toEditableMap(image: RgbaImage, polarity: ImageMaskInput['polarity']): Uint8Array {
    const map = new Uint8Array(image.width * image.height);
    const background = polarity === 'white-is-editable' ? 0 : 255;

    for (let index = 0; index < map.length; index += 1) {
      const offset = index * 4;
      const alpha = (image.data[offset + 3] as number) / 255;
      const luminance =
        0.299 * (image.data[offset] as number) +
        0.587 * (image.data[offset + 1] as number) +
        0.114 * (image.data[offset + 2] as number);
      const composited = luminance * alpha + background * (1 - alpha);
      const isWhite = composited >= this.threshold;
      map[index] = polarity === 'white-is-editable' ? (isWhite ? 1 : 0) : isWhite ? 0 : 1;
    }
    return map;
  }
}

/**
 * Brings a mask to the target dimensions.
 *
 * Nearest-neighbour throughout: a mask is binary, and any smoothing resampler would invent a grey
 * fringe that each provider interprets differently.
 */
function fitMask(
  editable: Uint8Array,
  width: number,
  height: number,
  target: MaskTarget,
  mode: NonNullable<ImageMaskInput['resizeMode']>,
): Uint8Array {
  if (width === target.width && height === target.height) return editable;

  if (mode === 'reject') {
    throw new ImageValidationError(
      `Mask is ${width}x${height} but the image is ${target.width}x${target.height}. Resize the mask, or set mask.resizeMode to "stretch", "contain", or "cover".`,
    );
  }

  const out = new Uint8Array(target.width * target.height);
  let scaleX = target.width / width;
  let scaleY = target.height / height;
  let offsetX = 0;
  let offsetY = 0;

  if (mode === 'contain' || mode === 'cover') {
    const scale = mode === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
    scaleX = scale;
    scaleY = scale;
    offsetX = (target.width - width * scale) / 2;
    offsetY = (target.height - height * scale) / 2;
  }

  for (let y = 0; y < target.height; y += 1) {
    const sourceY = Math.floor((y - offsetY) / scaleY);
    for (let x = 0; x < target.width; x += 1) {
      const sourceX = Math.floor((x - offsetX) / scaleX);
      // Padding introduced by "contain" is never editable.
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      out[y * target.width + x] = editable[sourceY * width + sourceX] as number;
    }
  }
  return out;
}

function render(editable: Uint8Array, width: number, height: number, semantics: MaskSemantics): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < editable.length; index += 1) {
    const offset = index * 4;
    const isEditable = editable[index] === 1;
    if (semantics === 'alpha-transparent-is-editable') {
      rgba[offset + 3] = isEditable ? 0 : 255;
      continue;
    }
    const value = semantics === 'white-is-editable' ? (isEditable ? 255 : 0) : isEditable ? 0 : 255;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

/**
 * Reads the dimensions of an image a mask will be applied to.
 *
 * Providers need the target size before preparing a mask, and asking them to each parse headers
 * would repeat the same code in every adapter.
 */
export function requireImageDimensions(asset: AssetInput, provider: string): { width: number; height: number } {
  if (asset.location.kind !== 'bytes') {
    throw new ImageCapabilityError(provider, 'input.location', asset.location.kind);
  }
  const dimensions = readImageDimensions(asset.location.data);
  if (!dimensions) {
    throw new ImageValidationError('Could not read the input image dimensions to size its mask');
  }
  return dimensions;
}

let defaultTransformer: PngMaskTransformer | undefined;

/** Shared default instance, built on first use. */
export function defaultMaskTransformer(): AssetTransformer {
  defaultTransformer ??= new PngMaskTransformer();
  return defaultTransformer;
}
