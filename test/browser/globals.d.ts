import type * as HeicApi from '../../src/index.ts';
import type { createWasmAdapter as CreateWasmAdapter } from '../../wasm/index.ts';

declare global {
  interface Window {
    heic: typeof HeicApi;
    createWasmAdapter: typeof CreateWasmAdapter;
    /** An adapter wired to the ESM libheif build served from node_modules. */
    wasmAdapter(): import('../../src/types.ts').DecoderAdapter;
    /** See harness.html. Compares a decoded bitmap to a reference PNG. */
    meanAbsoluteDifference(bitmap: ImageBitmap, referenceUrl: string): Promise<number>;
    ready: boolean;
  }
}
