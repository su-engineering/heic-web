import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWasmAdapter } from '../../wasm/index.ts';

afterEach(() => { vi.unstubAllGlobals(); });
describe('libheif resource ownership', () => {
  for (const outcome of ['success', 'render-error', 'invalid-size', 'empty'] as const) {
    it(`releases image handles and context on ${outcome}`, async () => {
      const released: string[] = [];
      const image = { get_width: () => outcome === 'invalid-size' ? 0 : 2, get_height: () => 2,
        display: (_data: unknown, callback: (data: unknown) => void) => callback(outcome === 'render-error' ? null : {}),
        free: () => released.push('primary') };
      const aux = { ...image, free: () => released.push('aux') };
      const module = { HeifDecoder: class { decoder: number | null = 42; decode() { return outcome === 'empty' ? [] : [image, aux]; } },
        heif_context_free: (context: number) => { expect(context).toBe(42); released.push('context'); } };
      vi.stubGlobal('OffscreenCanvas', class { getContext() { return { createImageData: () => ({}), putImageData: () => {} }; } });
      const adapter = createWasmAdapter({ loadLibheif: async () => module });
      const promise = adapter.decode({ data: new Uint8Array(), colorSpace: 'srgb' });
      if (outcome === 'success') await promise;
      else await expect(promise).rejects.toThrow();
      expect(released).toEqual(outcome === 'empty' ? ['context'] : ['primary', 'aux', 'context']);
    });
  }
});
