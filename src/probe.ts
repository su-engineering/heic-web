import { probeNativeSupport } from './decoders/native.ts';
import { isWebCodecsAvailable, probeHevcCodecStrings } from './decoders/webcodecs.ts';
import type { SupportReport } from './types.ts';

/**
 * Reports what this environment can decode, before anything is downloaded.
 *
 * The point is to let a caller decide whether to preload the wasm fallback:
 * `recommended === 'wasm'` means the ~1.2 MB codec will be needed, and knowing
 * that at page load is much better than discovering it when a user drops a file.
 *
 * Cheap: `isConfigSupported` is a capability query, not a decoder, and the native
 * probe decodes a 471-byte inline image.
 */
export async function probeSupport(): Promise<SupportReport> {
  const [native, hevcCodecStrings] = await Promise.all([
    probeNativeSupport(),
    probeHevcCodecStrings(),
  ]);

  const webcodecs = isWebCodecsAvailable() && hevcCodecStrings.length > 0;

  const recommended: SupportReport['recommended'] = native
    ? 'native'
    : webcodecs
      ? 'webcodecs'
      : 'wasm';

  return { native, webcodecs, hevcCodecStrings, recommended };
}
