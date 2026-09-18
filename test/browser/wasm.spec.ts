import { expect, test } from '@playwright/test';
import { loadFixtures, openHarness } from './support.ts';

/**
 * The wasm fallback, exercised on every browser in the matrix.
 *
 * This is the path a Firefox user, a Linux desktop user, or a Windows user
 * without the HEVC extension actually takes — and it is the only decode path
 * available in headless CI. Everything here runs unconditionally: no capability
 * skips, because there is no capability to miss.
 */
const MAD_TOLERANCE = 6;
const MIN_PERCEPTUAL_PIXELS = 32 * 32;

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test.describe('wasm strategy', () => {
  for (const fixture of loadFixtures()) {
    test(`decodes ${fixture.name}`, async ({ page }) => {
      const result = await page.evaluate(
        async ({ url, referenceUrl }) => {
          const blob = await (await fetch(url)).blob();
          const decoded = await window.heic.decodeHeic(blob, {
            strategy: 'wasm',
            wasmLoader: async () => window.wasmAdapter(),
          });
          const summary = {
            strategy: decoded.strategy,
            width: decoded.width,
            height: decoded.height,
            sourceWidth: decoded.sourceWidth,
            sourceHeight: decoded.sourceHeight,
            bitDepth: decoded.bitDepth,
            isGrid: decoded.isGrid,
            tileCount: decoded.tileCount,
            transformsApplied: decoded.transformsApplied,
            mad: null as number | null,
          };
          if (referenceUrl) {
            summary.mad = await window.meanAbsoluteDifference(decoded.image, referenceUrl);
          }
          decoded.image.close();
          return summary;
        },
        { url: fixture.url, referenceUrl: fixture.referenceUrl ?? null },
      );

      expect(result.strategy).toBe('wasm');
      expect(result.width).toBe(fixture.expect.width);
      expect(result.height).toBe(fixture.expect.height);
      expect(result.sourceWidth).toBe(fixture.expect.width);
      expect(result.sourceHeight).toBe(fixture.expect.height);
      expect(result.isGrid).toBe(fixture.expect.isGrid);
      expect(result.bitDepth).toBe(fixture.expect.bitDepth);

      // Metadata still comes from our parser even though libheif did the
      // decoding, so a parsing bug is visible on this path too.
      expect(result.tileCount).toBe(fixture.expect.tileCount);

      // The adapter declares appliesTransforms, so the pipeline must skip its own
      // transform stage — but the *report* is still derived from the container.
      expect(result.transformsApplied.rotation).toBe(fixture.expect.rotation);
      expect(result.transformsApplied.mirrored).toBe(fixture.expect.mirrored);

      if (result.mad !== null && result.width * result.height >= MIN_PERCEPTUAL_PIXELS) {
        console.log(`    ${fixture.name}: wasm MAD ${result.mad.toFixed(2)}`);
        expect(result.mad).toBeLessThan(MAD_TOLERANCE);
      }
    });
  }

  test('auto falls back to wasm when nothing else can decode', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/generated/asym-irot-90.heic')).blob();
      const decoded = await window.heic.decodeHeic(blob, {
        // No explicit strategy: the cascade chooses.
        wasmLoader: async () => window.wasmAdapter(),
      });
      const summary = { strategy: decoded.strategy, width: decoded.width, height: decoded.height };
      decoded.image.close();
      return summary;
    });

    // On a browser with native or WebCodecs HEVC the cascade stops earlier, which
    // is the correct outcome; the assertion is that it reaches *a* working path
    // and that the result is right either way.
    expect(['native', 'webcodecs', 'wasm']).toContain(result.strategy);
    expect(result.width).toBe(320);
    expect(result.height).toBe(480);
  });

  test('a decode aborted before it starts does not load the codec', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();
      const controller = new AbortController();
      controller.abort();
      let loaderCalled = false;
      try {
        await window.heic.decodeHeic(blob, {
          strategy: 'wasm',
          signal: controller.signal,
          wasmLoader: async () => {
            loaderCalled = true;
            return window.wasmAdapter();
          },
        });
        return { name: 'resolved', loaderCalled };
      } catch (error) {
        return { name: (error as Error).name, loaderCalled };
      }
    });

    expect(outcome.name).toBe('HeicAbortError');
    // Never fetch a megabyte of codec for a decode the caller already cancelled.
    expect(outcome.loaderCalled).toBe(false);
  });
});


test('default WASM adapter decodes through a bundled consumer', async ({ page }) => {
  const result = await page.evaluate(async () => {
    // Built by test:package; this uses the documented default import, rather
    // than the harness's custom ESM loader.
    const url = '/test/.consumer/stdin.js';
    const consumer = await import(/* @vite-ignore */ url);
    const file = await (await fetch('/test/fixtures/generated/asym-irot-90.heic')).blob();
    const decoded = await consumer.decodeHeic(file, {
      strategy: 'wasm',
      wasmLoader: async () => consumer.wasmDecoder,
      maxDimension: 160,
    });
    const summary = {
      width: decoded.width, height: decoded.height,
      sourceWidth: decoded.sourceWidth, sourceHeight: decoded.sourceHeight,
      strategy: decoded.strategy,
    };
    decoded.image.close();
    return summary;
  });
  expect(result).toEqual({ width: 107, height: 160, sourceWidth: 320, sourceHeight: 480, strategy: 'wasm' });
});

test('WASM decoding works in a dedicated worker', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/test/browser/decode-worker.js', { type: 'module' });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ url: '/test/fixtures/generated/asym-irot-270.heic', strategy: 'wasm' });
      });
    } finally {
      worker.terminate();
    }
  });
  expect(result.ok, String(result.error)).toBe(true);
  expect(result.strategy).toBe('wasm');
  expect(result.width).toBe(320);
  expect(result.height).toBe(480);
  expect(result.rotation).toBe(270);
});
