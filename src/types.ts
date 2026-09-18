/** Decode strategies, in cascade order. */
export type Strategy = 'native' | 'webcodecs' | 'wasm';

export type OutputColorSpace = 'srgb' | 'display-p3';

/** Source colour characteristics, reported so callers can make their own decisions. */
export type SourceColor =
  | {
      type: 'nclx';
      /** CICP colour primaries (ITU-T H.273). 1 = BT.709, 12 = Display P3, 9 = BT.2020. */
      primaries: number;
      transfer: number;
      matrix: number;
      fullRange: boolean;
    }
  | { type: 'icc'; profile: Uint8Array }
  | null;

export interface TransformsApplied {
  /** Counter-clockwise, as stored in `irot`. */
  rotation: 0 | 90 | 180 | 270;
  /**
   * 'horizontal' is a left-right flip (CSS `scaleX(-1)`); 'vertical' is a
   * top-bottom flip. See the note on `imir` semantics in render/transform.ts —
   * the mapping from the container's `axis` field is not the obvious one.
   */
  mirrored: 'none' | 'horizontal' | 'vertical';
  cropped: boolean;
}

/**
 * A feature we detected but do not support. Decoding still succeeds — the
 * primary image comes back, and this says what was left on the table.
 */
export interface HeicWarning {
  code:
    | 'alpha-ignored'
    | 'depth-ignored'
    | 'gain-map-ignored'
    | 'sequence-ignored'
    | 'thumbnail-ignored'
    | 'grid-dimension-mismatch'
    | 'mixed-tile-configs'
    | 'unknown-property';
  message: string;
}

export interface DecodeOptions {
  /** Which strategy to use. 'auto' runs the cascade. Default 'auto'. */
  strategy?: Strategy | 'auto';
  /** Canvas colour space for compositing. Default 'srgb'. */
  colorSpace?: OutputColorSpace;
  /**
   * Downscale the result so its longest side is at most this many pixels.
   *
   * A memory control, not an image-processing feature: a 48 MP photo composited
   * at full resolution is a ~190 MB canvas, and only the decoder can release it
   * early. When set, the bitmap is produced with `resizeQuality: 'high'` and the
   * full-size canvas is dropped immediately.
   */
  maxDimension?: number;
  signal?: AbortSignal;
  /** Supplies the wasm adapter on demand. Without it, the wasm strategy is skipped. */
  wasmLoader?: () => Promise<DecoderAdapter>;
}

export interface DecodedImage {
  image: ImageBitmap;
  /** Dimensions of the returned bitmap, after any `maxDimension` scaling. */
  width: number;
  height: number;
  /**
   * The image's intrinsic dimensions as displayed, i.e. after container
   * transforms but before `maxDimension`. Equal to `width`/`height` unless
   * `maxDimension` scaled the result.
   */
  sourceWidth: number;
  sourceHeight: number;
  strategy: Strategy;
  bitDepth: number;
  isGrid: boolean;
  tileCount: number;
  sourceColor: SourceColor;
  transformsApplied: TransformsApplied;
  /** Unsupported features that were detected and skipped. Usually empty. */
  warnings: HeicWarning[];
}

export interface ConvertOptions extends DecodeOptions {
  /** Output format. Default 'image/jpeg'. */
  type?: 'image/jpeg' | 'image/png';
  /** JPEG encoder quality, from 0 to 1. Default 0.92; ignored for PNG. */
  quality?: number;
}

/** Encoded pixels and decode metadata; no bitmap needs to be closed by the caller. */
export interface ConvertedImage extends Omit<DecodedImage, 'image'> {
  blob: Blob;
}

export interface SupportReport {
  /** `createImageBitmap` decodes HEIC directly (Safari, some Chrome builds). */
  native: boolean;
  /** WebCodecs is present and accepted at least one HEVC config. */
  webcodecs: boolean;
  /** The HEVC codec strings this environment accepted. */
  hevcCodecStrings: string[];
  /** What `strategy: 'auto'` would reach for first. */
  recommended: Strategy | 'none';
}

// ---------------------------------------------------------------------------
// Adapter interface (implemented by the wasm entry point, or by the caller)
// ---------------------------------------------------------------------------

export interface AdapterRequest {
  /** The complete source file. */
  data: Uint8Array;
  /** Output colour space the caller asked for. */
  colorSpace: OutputColorSpace;
  signal?: AbortSignal | undefined;
}

export interface AdapterResult {
  image: ImageBitmap | OffscreenCanvas;
  width: number;
  height: number;
}

export interface DecoderAdapter {
  /** Reported in errors and useful in tests. */
  readonly name: string;
  /**
   * Whether this adapter has already applied `irot` / `imir` / `clap` to the
   * pixels it returns.
   *
   * libheif does by default; our WebCodecs path does not. If both the adapter
   * and our pipeline apply them, the image comes out rotated twice — so the
   * pipeline skips its transform stage exactly when this is true. The
   * cross-strategy consistency tests exist to catch a violation of this contract.
   */
  readonly appliesTransforms: boolean;
  decode(request: AdapterRequest): Promise<AdapterResult>;
}
