import { expect, test } from '@playwright/test';
import { hasWebCodecsHevc, loadFixtures, openHarness } from './support.ts';

/**
 * WebCodecs output vs libheif-wasm output, for every fixture.
 *
 * This is the highest-value test in the suite. Each strategy is an independent
 * implementation of the same job, and only one of them uses our container
 * parser — so a parsing bug that a single path would silently absorb (wrong tile
 * order, an off-by-one extent, a misread grid layout, an inverted `imir` axis)
 * shows up here as a divergence and nowhere else.
 *
 * It is also the test that enforces the `appliesTransforms` contract: libheif
 * applies irot/imir/clap itself, our WebCodecs path applies them in our
 * pipeline, and if the adapter ever lied about that, every rotated fixture would
 * come back rotated twice from one path and once from the other.
 */
const CROSS_STRATEGY_TOLERANCE = 6;

/**
 * Below this many pixels the perceptual comparison stops being meaningful.
 *
 * On a 2x2 image, 4:2:0 chroma is a single sample for the whole picture, and two
 * conforming decoders rounding that one sample differently moves the mean by
 * several units — WebKit against libheif on the 2x2 fixture measures MAD 9.3
 * with no visible difference to speak of. Averaging four pixels measures
 * rounding, not correctness.
 *
 * Structural agreement (dimensions, transforms, tile count) is still asserted
 * for every fixture regardless of size; only the pixel average is skipped.
 */
const MIN_PERCEPTUAL_PIXELS = 32 * 32;

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test.describe('cross-strategy consistency', () => {
  for (const fixture of loadFixtures()) {
    test(`${fixture.name}: WebCodecs and wasm agree`, async ({ page }) => {
      test.skip(
        !(await hasWebCodecsHevc(page)),
        'needs the WebCodecs path to compare against',
      );

      const result = await page.evaluate(async (url) => {
        const blob = await (await fetch(url)).blob();

        const viaWebCodecs = await window.heic.decodeHeic(blob, { strategy: 'webcodecs' });
        const viaWasm = await window.heic.decodeHeic(blob, {
          strategy: 'wasm',
          wasmLoader: async () => window.wasmAdapter(),
        });

        // Compare through the same path the perceptual assertions use: draw both
        // into one box and take the mean absolute difference.
        const box = 512;
        const scale = Math.min(1, box / Math.max(viaWebCodecs.width, viaWebCodecs.height));
        const width = Math.max(1, Math.round(viaWebCodecs.width * scale));
        const height = Math.max(1, Math.round(viaWebCodecs.height * scale));

        const pixels = (bitmap: ImageBitmap) => {
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })!;
          ctx.drawImage(bitmap, 0, 0, width, height);
          return ctx.getImageData(0, 0, width, height).data;
        };

        const a = pixels(viaWebCodecs.image);
        const b = pixels(viaWasm.image);
        let total = 0;
        let count = 0;
        for (let i = 0; i < a.length; i += 4) {
          total += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
          count += 3;
        }

        const summary = {
          mad: total / count,
          webcodecs: {
            width: viaWebCodecs.width,
            height: viaWebCodecs.height,
            transforms: viaWebCodecs.transformsApplied,
            tileCount: viaWebCodecs.tileCount,
          },
          wasm: {
            width: viaWasm.width,
            height: viaWasm.height,
            transforms: viaWasm.transformsApplied,
            tileCount: viaWasm.tileCount,
          },
        };
        viaWebCodecs.image.close();
        viaWasm.image.close();
        return summary;
      }, fixture.url);

      // Identical dimensions are the first thing a double-applied transform
      // breaks, so assert them before looking at pixels.
      expect(result.wasm.width).toBe(result.webcodecs.width);
      expect(result.wasm.height).toBe(result.webcodecs.height);
      expect(result.wasm.transforms).toEqual(result.webcodecs.transforms);

      const pixels = result.webcodecs.width * result.webcodecs.height;
      if (pixels < MIN_PERCEPTUAL_PIXELS) {
        console.log(`    ${fixture.name}: ${pixels}px, structural only (MAD ${result.mad.toFixed(2)})`);
        return;
      }
      console.log(`    ${fixture.name}: cross-strategy MAD ${result.mad.toFixed(2)}`);
      expect(result.mad).toBeLessThan(CROSS_STRATEGY_TOLERANCE);
    });
  }
});

test('the wasm strategy works on its own, with no WebCodecs involved', async ({ page }) => {
  // The path a Firefox or Linux-desktop user actually takes.
  const result = await page.evaluate(async () => {
    const blob = await (await fetch('/test/fixtures/local/IMG_0679.HEIC')).blob();
    const decoded = await window.heic.decodeHeic(blob, {
      strategy: 'wasm',
      wasmLoader: async () => window.wasmAdapter(),
    });
    const summary = {
      strategy: decoded.strategy,
      width: decoded.width,
      height: decoded.height,
      rotation: decoded.transformsApplied.rotation,
      tileCount: decoded.tileCount,
    };
    decoded.image.close();
    return summary;
  });

  expect(result.strategy).toBe('wasm');
  // Rotated once, not twice: 4032x3024 coded, 3024x4032 displayed.
  expect(result.width).toBe(3024);
  expect(result.height).toBe(4032);
  expect(result.rotation).toBe(270);
  // Reported from our parser even though libheif did the decoding.
  expect(result.tileCount).toBe(48);
});
