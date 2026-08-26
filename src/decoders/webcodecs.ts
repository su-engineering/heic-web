import { HeicAbortError, HeicDecodeError, HeicUnsupportedError } from '../errors.ts';
import { hvccToAnnexBPrologue, hvccToCodecString, lengthPrefixedToAnnexB } from '../parser/hvcc.ts';
import { tileData, type ImagePlan, type TileGroup } from '../plan.ts';
import type { OutputColorSpace } from '../types.ts';
import { createCanvas, throwIfAborted } from '../render/canvas.ts';

/**
 * How a VideoDecoder was configured for a tile group.
 *
 * `hvc1` passes the raw hvcC as `description` and submits tile payloads
 * untouched, which is what HEIF already stores. `hev1` is the fallback for
 * environments that reject a description: parameter sets and tile data are
 * rewritten to Annex B start codes.
 */
interface ResolvedConfig {
  mode: 'hvc1' | 'hev1';
  config: VideoDecoderConfig;
  /** Annex B parameter sets, prepended to every chunk in 'hev1' mode. */
  prologue?: Uint8Array;
  lengthSize: number;
}

export function isWebCodecsAvailable(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

/**
 * Picks a working VideoDecoder configuration for a tile group, probing both
 * modes before committing to either.
 */
async function resolveConfig(
  group: TileGroup,
  codedWidth: number,
  codedHeight: number,
): Promise<ResolvedConfig> {
  const lengthSize = group.hvcc.lengthSizeMinusOne + 1;
  const failures: { strategy: string; reason: string }[] = [];

  const hvc1: VideoDecoderConfig = {
    codec: group.codec,
    // A fresh copy: VideoDecoderConfig.description is retained by the decoder,
    // and hvcc.raw is a view onto the caller's buffer.
    description: new Uint8Array(group.hvcc.raw),
    codedWidth,
    codedHeight,
    optimizeForLatency: true,
  };
  try {
    const support = await VideoDecoder.isConfigSupported(hvc1);
    if (support.supported) return { mode: 'hvc1', config: support.config ?? hvc1, lengthSize };
    failures.push({ strategy: 'hvc1', reason: 'isConfigSupported returned false' });
  } catch (error) {
    failures.push({ strategy: 'hvc1', reason: String(error) });
  }

  const hev1: VideoDecoderConfig = {
    codec: hvccToCodecString(group.hvcc, 'hev1'),
    codedWidth,
    codedHeight,
    optimizeForLatency: true,
  };
  try {
    const support = await VideoDecoder.isConfigSupported(hev1);
    if (support.supported) {
      return {
        mode: 'hev1',
        config: support.config ?? hev1,
        prologue: hvccToAnnexBPrologue(group.hvcc),
        lengthSize,
      };
    }
    failures.push({ strategy: 'hev1', reason: 'isConfigSupported returned false' });
  } catch (error) {
    failures.push({ strategy: 'hev1', reason: String(error) });
  }

  throw new HeicUnsupportedError(
    'No HEVC decoder configuration was accepted',
    failures,
    { strategy: 'webcodecs', codec: group.codec },
  );
}

/** Builds the chunk bytes to submit for one tile under a resolved configuration. */
function chunkBytes(config: ResolvedConfig, payload: Uint8Array): Uint8Array {
  if (config.mode === 'hvc1') return payload;
  const body = lengthPrefixedToAnnexB(payload, config.lengthSize);
  const prologue = config.prologue!;
  const out = new Uint8Array(prologue.byteLength + body.byteLength);
  out.set(prologue, 0);
  out.set(body, prologue.byteLength);
  return out;
}

/**
 * Decodes every tile and composites them onto a single canvas.
 *
 * ## The frame-pool deadlock
 *
 * Hardware decoders draw output frames from a small fixed pool, often 8 to 10
 * frames. A `VideoFrame` that has not been `close()`d holds a slot. Submitting
 * 48 tiles and *collecting* the frames to composite after `flush()` exhausts the
 * pool: the decoder stops emitting, `flush()` never resolves, and the decode
 * hangs forever with no error. It fails only on grid images, only on some
 * hardware, which makes it miserable to debug.
 *
 * So each frame is drawn at its grid position and closed inside the output
 * callback, before the callback returns. Frames arrive in submission order, so a
 * counter is enough to map frame to tile.
 */
export async function decodeWithWebCodecs(
  plan: ImagePlan,
  colorSpace: OutputColorSpace,
  signal?: AbortSignal,
): Promise<OffscreenCanvas> {
  if (!isWebCodecsAvailable()) {
    throw new HeicUnsupportedError(
      'WebCodecs VideoDecoder is not available in this environment',
      [{ strategy: 'webcodecs', reason: 'VideoDecoder is undefined' }],
      { strategy: 'webcodecs' },
    );
  }
  throwIfAborted(signal);

  // Sized to the coded image: tiles that overhang the right or bottom edge are
  // clipped by the canvas bounds, so no separate crop pass is needed.
  const canvas = createCanvas(plan.codedWidth, plan.codedHeight);
  const ctx = canvas.getContext('2d', { colorSpace, alpha: false, willReadFrequently: false });
  if (!ctx) {
    throw new HeicDecodeError('Could not get a 2d context for compositing', {
      strategy: 'webcodecs',
    });
  }

  for (const group of plan.tileGroups) {
    throwIfAborted(signal);
    await decodeGroup(plan, group, ctx, signal);
  }

  return canvas;
}

async function decodeGroup(
  plan: ImagePlan,
  group: TileGroup,
  ctx: OffscreenCanvasRenderingContext2D,
  signal?: AbortSignal,
): Promise<void> {
  const first = plan.tiles[group.tileIndices[0]!]!;
  const config = await resolveConfig(group, first.width, first.height);
  throwIfAborted(signal);

  let nextTile = 0;
  let drawn = 0;
  let settle: ((error: Error) => void) | undefined;
  // Resolves only on failure; raced against flush() so a decoder error or an
  // abort surfaces immediately instead of waiting for a flush that never comes.
  const failure = new Promise<never>((_, reject) => {
    settle = reject;
  });

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const tile = plan.tiles[group.tileIndices[nextTile++]!];
        if (tile) {
          ctx.drawImage(frame, tile.x, tile.y, tile.width, tile.height);
          drawn++;
        }
      } finally {
        // Always, on every path: a frame left open holds a decoder pool slot.
        frame.close();
      }
    },
    error: (error) => {
      settle?.(
        new HeicDecodeError(`VideoDecoder failed: ${error.message}`, {
          strategy: 'webcodecs',
          codec: config.config.codec,
        }),
      );
    },
  });

  const onAbort = (): void => settle?.(new HeicAbortError());
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // configure() and decode() both throw synchronously when the decoder rejects
    // something, separately from the async error callback. Converting here is
    // what keeps the promise of typed errors: a caller must never see a bare
    // DOMException surface from inside the cascade.
    try {
      decoder.configure(config.config);

      for (const tileIndex of group.tileIndices) {
        const tile = plan.tiles[tileIndex]!;
        const bytes = chunkBytes(config, tileData(plan, tile));
        // Every tile is an independent keyframe. The timestamp is the submission
        // index, which makes ordering observable when debugging.
        decoder.decode(
          new EncodedVideoChunk({ type: 'key', timestamp: tileIndex, duration: 0, data: bytes }),
        );
      }
    } catch (error) {
      if (error instanceof HeicAbortError || error instanceof HeicDecodeError) throw error;
      throw new HeicDecodeError(
        `VideoDecoder rejected the stream: ${error instanceof Error ? error.message : String(error)}`,
        { strategy: 'webcodecs', codec: config.config.codec },
        { cause: error },
      );
    }

    // flush() is required: without it the decoder is free to hold the last
    // frames indefinitely, and the bottom of the image never arrives.
    await Promise.race([decoder.flush(), failure]);

    if (drawn !== group.tileIndices.length) {
      throw new HeicDecodeError(
        `Decoder emitted ${drawn} frames for ${group.tileIndices.length} tiles`,
        { strategy: 'webcodecs', codec: config.config.codec },
      );
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // close() also releases any frame the decoder still holds. Safe to call on
    // an already-closed decoder, so it belongs on the error path too.
    try {
      decoder.close();
    } catch {
      // A decoder that already failed is already closed; nothing to do.
    }
  }
}

/**
 * Codec strings probed by `probeSupport()`. Deliberately small: Main 8-bit and
 * Main10, which between them cover every HEIC a phone produces. Main Still
 * Picture (profile 3) is what Apple actually writes, so it leads.
 */
export const PROBE_CODEC_STRINGS = [
  'hvc1.3.e.L93.B0', // Main Still Picture, 8-bit — what iPhones write
  'hvc1.1.6.L93.B0', // Main, 8-bit
  'hvc1.2.4.L120.B0', // Main10, 10-bit
];

/** Which of the representative HEVC codec strings this environment accepts. */
export async function probeHevcCodecStrings(): Promise<string[]> {
  if (!isWebCodecsAvailable()) return [];
  const supported: string[] = [];
  for (const codec of PROBE_CODEC_STRINGS) {
    try {
      // No description and no decode: isConfigSupported is a cheap capability
      // query, not a decoder instantiation.
      const support = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1920,
        codedHeight: 1080,
      });
      if (support.supported) supported.push(codec);
    } catch {
      // An unparseable codec string throws rather than returning false.
    }
  }
  return supported;
}
