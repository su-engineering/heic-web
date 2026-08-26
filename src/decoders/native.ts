import { toHeicBlob } from '../bytes.ts';
import type { ImagePlan } from '../plan.ts';
import { throwIfAborted } from '../render/canvas.ts';

/**
 * Why a native failure is remembered.
 *
 * On a browser with no HEIC support, `createImageBitmap` rejects for every file,
 * every time. Left alone, the cascade would build a Blob and lose a decode
 * attempt on each image — invisible for one avatar, real when a user drops
 * twenty photos at once. A browser does not gain or lose an image decoder
 * mid-session, so the first outright rejection is conclusive.
 *
 * Only an outright rejection sets this. A dimension mismatch does not: that
 * means the decoder returned *something* (usually the embedded thumbnail), which
 * is a property of the file rather than of the browser, and the next file may
 * well decode properly.
 */
let nativeDecoderRejects = false;

export type NativeOutcome =
  | { status: 'ok'; bitmap: ImageBitmap }
  /** The browser has no HEIC decoder at all. */
  | { status: 'unsupported'; reason: string }
  /** It decoded something, but not the primary image. */
  | { status: 'wrong-image'; reason: string };

/**
 * Tries the browser's own image decoder.
 *
 * Free when it works (Safari on every platform, and some Chrome builds), so it
 * leads the cascade. The catch is that browsers fail in unhelpful ways here:
 * some return a bitmap of the embedded *thumbnail* rather than the primary
 * image, and some resolve with something unusable rather than rejecting.
 *
 * So the result is only accepted if its dimensions match the primary item's
 * `ispe` **in either orientation**. Native decoders apply `irot` themselves, so a
 * 90-degree-rotated image legitimately comes back with width and height swapped.
 * A thumbnail (typically 512 px or smaller) matches neither and is rejected,
 * falling through to WebCodecs.
 */
export async function decodeNative(
  blob: Blob,
  plan: ImagePlan,
  signal?: AbortSignal,
): Promise<NativeOutcome> {
  if (typeof createImageBitmap === 'undefined') {
    return { status: 'unsupported', reason: 'createImageBitmap is not available' };
  }
  if (nativeDecoderRejects) {
    return { status: 'unsupported', reason: 'this browser has no HEIC image decoder' };
  }
  throwIfAborted(signal);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // The overwhelmingly common case on Chrome and Firefox: no HEIC decoder.
    nativeDecoderRejects = true;
    return { status: 'unsupported', reason: 'createImageBitmap rejected the file' };
  }

  throwIfAborted(signal);

  if (!dimensionsMatch(bitmap, plan)) {
    const got = `${bitmap.width}x${bitmap.height}`;
    // Very likely the embedded thumbnail. Close it and let WebCodecs try.
    bitmap.close();
    return {
      status: 'wrong-image',
      reason: `returned ${got}, expected ${plan.displayWidth}x${plan.displayHeight}`,
    };
  }

  return { status: 'ok', bitmap };
}

function dimensionsMatch(bitmap: ImageBitmap, plan: ImagePlan): boolean {
  const { displayWidth, displayHeight } = plan;
  const upright = bitmap.width === displayWidth && bitmap.height === displayHeight;
  const swapped = bitmap.width === displayHeight && bitmap.height === displayWidth;
  return upright || swapped;
}

/**
 * Whether this environment decodes HEIC natively.
 *
 * Probed with a minimal real HEIC rather than by sniffing the user agent. The
 * fixture below is a 2x2 single-item HEIC, small enough to inline.
 */
export async function probeNativeSupport(): Promise<boolean> {
  if (typeof createImageBitmap === 'undefined') return false;
  try {
    const bytes = decodeBase64(TINY_HEIC_BASE64);
    const bitmap = await createImageBitmap(toHeicBlob(bytes));
    const ok = bitmap.width === TINY_HEIC_WIDTH && bitmap.height === TINY_HEIC_HEIGHT;
    bitmap.close();
    return ok;
  } catch {
    return false;
  }
}

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * A 2x2 single-item HEIC, produced by libheif's `heif-enc`. 471 bytes.
 *
 * Inlined so that probing native support costs no network request and no
 * fixture plumbing. Regenerate with:
 *   magick -size 2x2 xc:'rgb(200,60,40)' tiny.png && heif-enc -q 90 -o tiny.heic tiny.png
 */
export const TINY_HEIC_WIDTH = 2;
export const TINY_HEIC_HEIGHT = 2;
export const TINY_HEIC_BASE64 =
  'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXxtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAA' +
  'AAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoAABAAAAAAAAADcAAAAjaWluZgAAAAAAAQAAABVpbm' +
  'ZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmNDAQNwAAAAAAAAAAA' +
  'AHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEBA3AAAAMAkAAAAwAAAwAe' +
  'oCCBBZbqrprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAA' +
  'AAAAABAAAAAQAAAAChjbGFwAAAAAgAAAAEAAAACAAAAAf///8IAAAAC////wgAAAAIAAAAQcGl4aQAAAAADCA' +
  'gIAAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAAP21kYXQAAAAzKAGvBjIWhzSJIPC/cov//8tX9l+i9qzWyeu' +
  'EfoBjx+S3kJGe9F97GFLlPHQg9JxTuc2A';
