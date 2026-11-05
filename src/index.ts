import { toHeicBlob } from './bytes.ts';
import { HeicAbortError, HeicDecodeError, HeicUnsupportedError } from './errors.ts';
import { decodeNative } from './decoders/native.ts';
import { decodeWithWebCodecs, isWebCodecsAvailable } from './decoders/webcodecs.ts';
import { DETECTION_PREFIX_BYTES, detectFromBuffer } from './parser/detect.ts';
import { extractExifTiff, insertJpegExif, prepareExifForOutput } from './parser/exif.ts';
import { parseHeif } from './parser/meta.ts';
import { findThumbnailItemId, planDecode, planItem, type ImagePlan } from './plan.ts';
import { createCanvas, throwIfAborted } from './render/canvas.ts';
import { applyTransforms, summarizeTransforms } from './render/transform.ts';
import type {
  DecodeOptions,
  ConvertOptions,
  ConvertedImage,
  DecodedImage,
  DecoderAdapter,
  ExifMode,
  HeicWarning,
  Strategy,
  ThumbnailImage,
  ThumbnailOptions,
  TransformsApplied,
} from './types.ts';

export {
  HeicAbortError,
  HeicDecodeError,
  HeicError,
  HeicParseError,
  HeicUnsupportedError,
} from './errors.ts';
export type { HeicErrorContext } from './errors.ts';
export { parseHeif, propertiesForItem, findProperty, readItemData } from './parser/meta.ts';
export type {
  HeifFile,
  ItemInfo,
  ItemLocation,
  ItemProperty,
  ItemProperties,
  ItemReferences,
} from './parser/meta.ts';
export { readGrid, parseGridPayload } from './parser/grid.ts';
export type { GridDescriptor } from './parser/grid.ts';
export {
  hvccToAnnexBPrologue,
  hvccToCodecString,
  lengthPrefixedToAnnexB,
  parseHvcC,
} from './parser/hvcc.ts';
export type { HvcC } from './parser/hvcc.ts';
export { findThumbnailItemId, planDecode, planItem } from './plan.ts';
export type { ImagePlan, PlannedTile, TileGroup, TransformOp } from './plan.ts';
export { probeSupport } from './probe.ts';
export type {
  AdapterRequest,
  AdapterResult,
  DecodeOptions,
  ConvertOptions,
  ConvertedImage,
  DecodedImage,
  DecoderAdapter,
  ExifMode,
  HeicWarning,
  OutputColorSpace,
  SourceColor,
  Strategy,
  SupportReport,
  ThumbnailImage,
  ThumbnailOptions,
  TransformsApplied,
} from './types.ts';

export type BinaryInput = Blob | ArrayBuffer | Uint8Array;

export interface IsHeicResult {
  isHeic: boolean;
  /** ftyp major brand, when the file had one. */
  brand?: string | undefined;
  /** item_type of the primary item ('hvc1', 'grid', 'av01', ...). */
  primaryItemType?: string | undefined;
  /** What the primary item is coded with. 'av1' means this is an AVIF. */
  coding?: 'hevc' | 'av1' | 'unknown' | undefined;
}

/**
 * Identifies a HEIC file from its contents.
 *
 * Reads the `ftyp` brands and the primary item type — never the filename or the
 * MIME type the browser guessed, both of which are routinely wrong for photos
 * copied off a phone.
 *
 * Given a Blob, only the first 64 KB are read, because this gets called
 * speculatively on every file a user drops. AVIF also uses the `mif1` brand, so
 * the result is discriminated rather than boolean: `{ isHeic: false, coding:
 * 'av1' }` tells a caller to route the file to an AVIF decoder instead of
 * treating it as garbage.
 */
export async function isHeic(input: BinaryInput): Promise<IsHeicResult> {
  const prefix = await readPrefix(input, DETECTION_PREFIX_BYTES);
  const detection = detectFromBuffer(prefix);
  const result: IsHeicResult = { isHeic: detection.isHeic };
  if (detection.brand !== undefined) result.brand = detection.brand;
  if (detection.primaryItemType !== undefined) result.primaryItemType = detection.primaryItemType;
  if (detection.coding !== undefined) result.coding = detection.coding;
  return result;
}

/**
 * Decodes a HEIC image to an `ImageBitmap`.
 *
 * The container is parsed first regardless of which strategy ends up decoding —
 * parsing costs microseconds and every strategy needs its output. The cascade
 * then picks a *decode* path:
 *
 *   1. `createImageBitmap` — free, works on Safari and some Chrome builds
 *   2. WebCodecs `VideoDecoder` — ~15 KB of JS, hardware decode, most Chromium
 *   3. a wasm adapter — ~1.2 MB, only if the caller supplied one
 *
 * Step 3 never happens behind the caller's back: without `wasmLoader` or a
 * registered adapter, a file that needs wasm throws `HeicUnsupportedError`
 * naming what was missing, rather than silently fetching a megabyte.
 */
export async function decodeHeic(
  input: BinaryInput,
  options: DecodeOptions = {},
): Promise<DecodedImage> {
  const {
    strategy = 'auto',
    colorSpace = 'srgb',
    maxDimension,
    signal,
    wasmLoader,
  } = options;

  throwIfAborted(signal);

  // Read the whole buffer once and reuse it for both parse and decode.
  const bytes = await readAll(input);
  throwIfAborted(signal);

  const plan = planDecode(bytes);
  throwIfAborted(signal);

  const attempts: { strategy: string; reason: string }[] = [];
  const wants = (candidate: Strategy): boolean => strategy === 'auto' || strategy === candidate;

  // --- 1. native -----------------------------------------------------------
  if (wants('native')) {
    const blob = input instanceof Blob ? input : toHeicBlob(bytes);
    const outcome = await decodeNative(blob, plan, signal);
    if (outcome.status === 'ok') {
      // The native decoder already applied irot/imir/clap. Applying them again
      // would double-rotate, so the transform stage is skipped entirely.
      const finalBitmap = await resizeBitmap(outcome.bitmap, maxDimension, signal);
      return describe(plan, finalBitmap, 'native', summarizeTransforms(plan.transforms));
    }
    attempts.push({ strategy: 'native', reason: outcome.reason });
  }

  // --- 2. WebCodecs --------------------------------------------------------
  if (wants('webcodecs')) {
    if (!isWebCodecsAvailable()) {
      attempts.push({ strategy: 'webcodecs', reason: 'VideoDecoder is not available' });
    } else {
      try {
        const composited = await decodeWithWebCodecs(plan, colorSpace, signal);
        const { canvas, applied } = applyTransforms(composited, plan.transforms, colorSpace);
        const bitmap = await canvasToBitmap(canvas, maxDimension, signal);
        return describe(plan, bitmap, 'webcodecs', applied);
      } catch (error) {
        if (error instanceof HeicAbortError) throw error;
        if (strategy === 'webcodecs') throw error;
        attempts.push({ strategy: 'webcodecs', reason: describeError(error) });
      }
    }
  }

  // --- 3. wasm -------------------------------------------------------------
  if (wants('wasm')) {
    const adapter = await resolveAdapter(wasmLoader);
    if (!adapter) {
      attempts.push({
        strategy: 'wasm',
        reason: 'no adapter: pass options.wasmLoader or call registerDecoderAdapter()',
      });
    } else {
      try {
        const result = await adapter.decode({ data: bytes, colorSpace, signal });
        // Contract: an adapter that applies transforms itself gets ours skipped,
        // or the image comes out rotated twice relative to the WebCodecs path.
        const applied = summarizeTransforms(plan.transforms);
        let bitmap: ImageBitmap;
        if (result.image instanceof ImageBitmap) {
          const source = adapter.appliesTransforms
            ? result.image
            : await transformBitmap(result.image, plan, colorSpace);
          bitmap = await resizeBitmap(source, maxDimension, signal);
        } else {
          const canvas = adapter.appliesTransforms
            ? result.image
            : applyTransforms(result.image, plan.transforms, colorSpace).canvas;
          bitmap = await canvasToBitmap(canvas, maxDimension, signal);
        }
        return describe(plan, bitmap, 'wasm', applied);
      } catch (error) {
        if (error instanceof HeicAbortError) throw error;
        if (strategy === 'wasm') throw error;
        attempts.push({ strategy: 'wasm', reason: describeError(error) });
      }
    }
  }

  throw new HeicUnsupportedError('Could not decode this HEIC', attempts, {
    brand: plan.file.majorBrand,
    itemType: plan.file.items.get(plan.primaryItemId)?.itemType,
    itemId: plan.primaryItemId,
  });
}

const EXIF_MODES: readonly ExifMode[] = ['none', 'all', 'no-location'];

/**
 * Convert the primary HEIC image to JPEG or PNG using the browser's encoder.
 * Uses the same explicit decode cascade as decodeHeic and releases all pixels.
 *
 * Source EXIF is dropped unless `exif` asks for it (JPEG only). When it is
 * written, Orientation is reset to 1 and the pixel dimensions are updated, since
 * the output pixels are already upright.
 */
export async function convertHeic(
  input: BinaryInput,
  options: ConvertOptions = {},
): Promise<ConvertedImage> {
  const { type = 'image/jpeg', quality = 0.92, exif = 'none', ...decodeOptions } = options;
  if (type !== 'image/jpeg' && type !== 'image/png') {
    throw new TypeError('type must be image/jpeg or image/png');
  }
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError('quality must be a finite number between 0 and 1');
  }
  if (!EXIF_MODES.includes(exif)) {
    throw new TypeError("exif must be 'none', 'all' or 'no-location'");
  }
  if (exif !== 'none' && type !== 'image/jpeg') {
    throw new TypeError('exif can only be written to image/jpeg output');
  }
  const bytes = await readAll(input);
  const decoded = await decodeHeic(bytes, decodeOptions);
  let canvas: OffscreenCanvas | undefined;
  try {
    throwIfAborted(options.signal);
    canvas = createCanvas(decoded.width, decoded.height);
    const ctx = canvas.getContext('2d', { colorSpace: options.colorSpace ?? 'srgb', alpha: false });
    if (!ctx) throw new HeicDecodeError('Could not get a 2d context for conversion', {});
    ctx.drawImage(decoded.image, 0, 0);
    let blob = await canvas.convertToBlob({ type, quality });
    throwIfAborted(options.signal);
    if (blob.type !== type || blob.size === 0) {
      throw new HeicDecodeError(`Browser could not encode ${type}`, {});
    }

    const { image: _image, ...metadata } = decoded;
    const warnings: HeicWarning[] = [...metadata.warnings];
    let written: ExifMode = 'none';
    if (exif !== 'none') {
      const embedded = await embedExif(blob, bytes, exif, decoded.width, decoded.height);
      if (embedded.blob) {
        blob = embedded.blob;
        written = exif;
      } else {
        warnings.push(embedded.warning);
      }
    }
    return { ...metadata, warnings, exif: written, blob };
  } finally {
    decoded.image.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function embedExif(
  jpeg: Blob,
  source: Uint8Array,
  mode: Exclude<ExifMode, 'none'>,
  width: number,
  height: number,
): Promise<{ blob: Blob; warning?: never } | { blob?: never; warning: HeicWarning }> {
  const tiff = extractExifTiff(parseHeif(source));
  if (!tiff) {
    return { warning: { code: 'exif-missing', message: 'The source has no EXIF block to copy' } };
  }
  const prepared = prepareExifForOutput(tiff, { width, height, stripLocation: mode === 'no-location' });
  const merged = prepared && insertJpegExif(new Uint8Array(await jpeg.arrayBuffer()), prepared);
  if (!merged) {
    return {
      warning: {
        code: 'exif-not-written',
        message: prepared
          ? 'The EXIF block does not fit in a JPEG APP1 segment; written without EXIF'
          : 'The source EXIF block is malformed; written without EXIF',
      },
    };
  }
  return { blob: new Blob([merged as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }) };
}

/**
 * The primary image's raw EXIF as a TIFF block ("II*\0" or "MM\0*" onwards),
 * or `null` when the file has none. Hand it to an EXIF parser such as exifr.
 *
 * This is the metadata exactly as stored: Orientation there describes the coded
 * pixels, which `decodeHeic` has already rotated.
 */
export async function readExif(input: BinaryInput): Promise<Uint8Array | null> {
  return extractExifTiff(parseHeif(await readAll(input))) ?? null;
}

/** Longest side used when there is no thumbnail to size the fallback after. */
const DEFAULT_THUMBNAIL_SIZE = 320;

/**
 * Decodes a small preview: the embedded thumbnail when the file has one, which
 * is a ~320 px HEVC frame and far cheaper than the full grid.
 *
 * The embedded thumbnail is decoded with WebCodecs. When there is none, or it
 * cannot be decoded, the primary image is decoded through the normal cascade and
 * downscaled (see `fallback`). `embedded` says which happened.
 */
export async function decodeHeicThumbnail(
  input: BinaryInput,
  options: ThumbnailOptions = {},
): Promise<ThumbnailImage> {
  const { fallback = 'primary', strategy = 'auto', colorSpace = 'srgb', maxDimension, signal } =
    options;
  throwIfAborted(signal);
  const bytes = await readAll(input);
  throwIfAborted(signal);

  const file = parseHeif(bytes);
  const thumbnailId = findThumbnailItemId(file, file.primaryItemId);
  const attempts: { strategy: string; reason: string }[] = [];
  let thumbnailPlan: ImagePlan | undefined;
  if (thumbnailId !== undefined) {
    try {
      thumbnailPlan = planItem(file, thumbnailId);
    } catch (error) {
      attempts.push({ strategy: 'webcodecs', reason: describeError(error) });
    }
  }

  if (thumbnailPlan && (strategy === 'auto' || strategy === 'webcodecs')) {
    try {
      const plan = thumbnailPlan;
      if (!isWebCodecsAvailable()) throw new Error('VideoDecoder is not available');
      const composited = await decodeWithWebCodecs(plan, colorSpace, signal);
      const { canvas, applied } = applyTransforms(composited, plan.transforms, colorSpace);
      const bitmap = await canvasToBitmap(canvas, maxDimension, signal);
      return { ...describe(plan, bitmap, 'webcodecs', applied), embedded: true };
    } catch (error) {
      if (error instanceof HeicAbortError) throw error;
      attempts.push({ strategy: 'webcodecs', reason: describeError(error) });
    }
  }

  if (fallback === 'none') {
    throw new HeicUnsupportedError(
      thumbnailId === undefined
        ? 'This HEIC has no embedded thumbnail'
        : 'The embedded thumbnail could not be decoded',
      attempts,
      { brand: file.majorBrand, itemId: thumbnailId ?? file.primaryItemId },
    );
  }

  const decoded = await decodeHeic(bytes, {
    ...options,
    maxDimension:
      maxDimension ??
      (thumbnailPlan
        ? Math.max(thumbnailPlan.displayWidth, thumbnailPlan.displayHeight)
        : DEFAULT_THUMBNAIL_SIZE),
  });
  return { ...decoded, embedded: false };
}

// ---------------------------------------------------------------------------
// Adapter registration
// ---------------------------------------------------------------------------

let registeredAdapter: DecoderAdapter | undefined;

/**
 * Registers a wasm (or other) fallback adapter for every subsequent decode.
 *
 * An alternative to passing `wasmLoader` on each call. Either way the caller
 * chooses when the megabyte is paid for; nothing is fetched implicitly.
 */
export function registerDecoderAdapter(adapter: DecoderAdapter | undefined): void {
  registeredAdapter = adapter;
}

export function getRegisteredAdapter(): DecoderAdapter | undefined {
  return registeredAdapter;
}

async function resolveAdapter(
  loader?: () => Promise<DecoderAdapter>,
): Promise<DecoderAdapter | undefined> {
  if (registeredAdapter) return registeredAdapter;
  if (!loader) return undefined;
  return loader();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readAll(input: BinaryInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

async function readPrefix(input: BinaryInput, byteCount: number): Promise<Uint8Array> {
  if (input instanceof Blob) {
    // The reason isHeic takes a Blob at all: slicing avoids pulling a 5 MB photo
    // into memory to read a 24-byte header.
    return new Uint8Array(await input.slice(0, byteCount).arrayBuffer());
  }
  const bytes = await readAll(input);
  return bytes.subarray(0, byteCount);
}

/** Scale factor that fits the longest side within `maxDimension`. Never upscales. */
function scaleFor(width: number, height: number, maxDimension?: number): number {
  if (!maxDimension || maxDimension <= 0) return 1;
  const longest = Math.max(width, height);
  return longest <= maxDimension ? 1 : maxDimension / longest;
}

/**
 * Turns the composited canvas into the returned bitmap, releasing the canvas
 * immediately.
 *
 * This is where `maxDimension` earns its place: a 48 MP photo is a ~190 MB
 * canvas, and a caller building a 512 px avatar should never have to hold that.
 * Only the decoder can free it this early.
 */
async function canvasToBitmap(
  canvas: OffscreenCanvas,
  maxDimension?: number,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  throwIfAborted(signal);
  const scale = scaleFor(canvas.width, canvas.height, maxDimension);

  if (scale === 1) {
    // Zero-copy: hands the backing store to the bitmap and empties the canvas.
    return canvas.transferToImageBitmap();
  }

  const resizeWidth = Math.max(1, Math.round(canvas.width * scale));
  const resizeHeight = Math.max(1, Math.round(canvas.height * scale));
  try {
    return await createImageBitmap(canvas, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'high',
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function resizeBitmap(
  bitmap: ImageBitmap,
  maxDimension?: number,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  throwIfAborted(signal);
  const scale = scaleFor(bitmap.width, bitmap.height, maxDimension);
  if (scale === 1) return bitmap;

  const resized = await createImageBitmap(bitmap, {
    resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
    resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
    resizeQuality: 'high',
  });
  bitmap.close();
  return resized;
}

/** Runs an untransformed adapter bitmap through the transform stage. */
async function transformBitmap(
  bitmap: ImageBitmap,
  plan: ImagePlan,
  colorSpace: PredefinedColorSpace,
): Promise<ImageBitmap> {
  if (plan.transforms.length === 0) return bitmap;
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { colorSpace, alpha: false });
  if (!ctx) return bitmap;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { canvas: transformed } = applyTransforms(canvas, plan.transforms, colorSpace);
  return transformed.transferToImageBitmap();
}

function describe(
  plan: ImagePlan,
  image: ImageBitmap,
  strategy: Strategy,
  transformsApplied: TransformsApplied,
): DecodedImage {
  return {
    image,
    width: image.width,
    height: image.height,
    sourceWidth: plan.displayWidth,
    sourceHeight: plan.displayHeight,
    strategy,
    bitDepth: plan.bitDepth,
    isGrid: plan.isGrid,
    tileCount: plan.tiles.length,
    sourceColor: plan.sourceColor,
    transformsApplied,
    warnings: plan.warnings,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
