/**
 * libheif-wasm fallback adapter.
 *
 * A **separate entry point** (`@su-engineering/heic/wasm`) so that bundlers
 * never pull roughly 1.2 MB of codec into the main chunk. Importing this module
 * is still cheap: the wasm itself is only instantiated on the first decode.
 *
 * The core package builds and passes its non-wasm tests with `libheif-js`
 * absent, which is why it is an optional peer dependency rather than a
 * dependency.
 */
import { HeicAbortError, HeicDecodeError } from '../src/errors.ts';
import type { AdapterRequest, AdapterResult, DecoderAdapter } from '../src/types.ts';

/** The slice of libheif-js's API we use. Declared here so the package can be absent. */
interface LibheifImage {
  get_width(): number;
  get_height(): number;
  display(image: ImageData, callback: (result: ImageData | null) => void): void;
  free?(): void;
}
interface LibheifDecoder {
  /** Context allocated by libheif-js's decode method. */
  decoder?: number | null;
  decode(buffer: Uint8Array | ArrayBuffer): LibheifImage[];
}
interface LibheifModule {
  HeifDecoder: new () => LibheifDecoder;
  heif_context_free?: (context: number) => void;
}

export interface WasmAdapterOptions {
  /**
   * Supplies the libheif module. Defaults to `import('libheif-js/wasm-bundle.js')`.
   *
   * Override it to pin a specific build, to serve the wasm from your own origin,
   * or to reuse an instance you already loaded. In a browser without a bundler,
   * this is required, because `libheif-js` is a bare specifier:
   *
   * ```ts
   * createWasmAdapter({
   *   loadLibheif: () => import('/vendor/libheif-bundle.mjs'),
   * });
   * ```
   */
  loadLibheif?: () => Promise<unknown>;
}

/**
 * Builds a libheif-backed adapter.
 *
 * The module is loaded once, on first decode, and reused.
 */
export function createWasmAdapter(options: WasmAdapterOptions = {}): DecoderAdapter {
  const load = options.loadLibheif ?? ((): Promise<unknown> => import('libheif-js/wasm-bundle.js'));

  let modulePromise: Promise<LibheifModule> | undefined;

  return {
    name: 'libheif-wasm',

    // libheif applies irot / imir / clap itself: heif_decode_image honours the
    // transformative properties unless ignore_transformations is set, and
    // libheif-js does not expose that option. Declaring it here is what stops the
    // pipeline applying them a second time and rotating the image twice.
    appliesTransforms: true,

    async decode(request: AdapterRequest): Promise<AdapterResult> {
      if (request.signal?.aborted) throw new HeicAbortError();

      modulePromise ??= Promise.resolve(load()).then(normalizeLibheif);
      const libheif = await modulePromise;
      if (request.signal?.aborted) throw new HeicAbortError();

      const decoder = new libheif.HeifDecoder();
      let images: LibheifImage[] = [];
      try {
        images = decoder.decode(request.data);
        if (!images || images.length === 0) {
          throw new HeicDecodeError('libheif returned no images', { strategy: 'wasm' });
        }

        // Index 0 is the primary image; any others are aux or sequence entries,
        // which v0.1 does not decode.
        const image = images[0]!;
        const width = image.get_width();
        const height = image.get_height();
        if (width <= 0 || height <= 0) {
          throw new HeicDecodeError(`libheif reported ${width}x${height}`, { strategy: 'wasm' });
        }

        if (typeof OffscreenCanvas === 'undefined') {
          throw new HeicDecodeError('OffscreenCanvas is required to receive libheif output', {
            strategy: 'wasm',
          });
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', {
          colorSpace: request.colorSpace,
          alpha: false,
        });
        if (!ctx) {
          throw new HeicDecodeError('Could not get a 2d context for libheif output', {
            strategy: 'wasm',
          });
        }

        const imageData = ctx.createImageData(width, height, { colorSpace: request.colorSpace });
        await new Promise<void>((resolve, reject) => {
          try {
            image.display(imageData, (result) => {
              if (!result) reject(new HeicDecodeError('libheif failed to render', { strategy: 'wasm' }));
              else resolve();
            });
          } catch (error) {
            reject(
              new HeicDecodeError(`libheif threw while rendering: ${String(error)}`, {
                strategy: 'wasm',
              }),
            );
          }
        });

        ctx.putImageData(imageData, 0, 0);

        if (request.signal?.aborted) {
          canvas.width = 0;
          canvas.height = 0;
          throw new HeicAbortError();
        }

        return { image: canvas, width, height };
      } finally {
        // Each decode allocates a context. libheif-js only frees it on the next
        // decode on the same instance; this adapter creates a fresh instance.
        // Release every returned handle before its owning context, even on error.
        for (const image of images ?? []) image.free?.();
        if (decoder.decoder && libheif.heif_context_free) {
          libheif.heif_context_free(decoder.decoder);
          decoder.decoder = null;
        }
      }
    },
  };
}

/**
 * libheif-js is published in three shapes and bundlers add a fourth wrapper:
 * the CommonJS build exposes `HeifDecoder` directly, the wasm builds default-
 * export an emscripten *factory* that must be called, and interop may nest
 * either under `.default`. Normalising here means callers can hand us whatever
 * their toolchain produced without knowing which one it is.
 */
async function normalizeLibheif(imported: unknown): Promise<LibheifModule> {
  let candidate = imported;

  for (let depth = 0; depth < 4; depth++) {
    if (isLibheifModule(candidate)) return candidate;
    if (typeof candidate === 'function') {
      candidate = await (candidate as () => unknown)();
      continue;
    }
    if (candidate && typeof candidate === 'object' && 'default' in candidate) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    break;
  }

  throw new HeicDecodeError(
    'The module supplied to the wasm adapter does not expose a HeifDecoder',
    { strategy: 'wasm' },
  );
}

function isLibheifModule(value: unknown): value is LibheifModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { HeifDecoder?: unknown }).HeifDecoder === 'function'
  );
}

/**
 * A ready-made adapter using the default `libheif-js` build.
 *
 * ```ts
 * import { decodeHeic } from '@su-engineering/heic';
 * import { wasmDecoder } from '@su-engineering/heic/wasm';
 *
 * await decodeHeic(file, { wasmLoader: async () => wasmDecoder });
 * ```
 */
export const wasmDecoder: DecoderAdapter = createWasmAdapter();

export type { DecoderAdapter, AdapterRequest, AdapterResult } from '../src/types.ts';
