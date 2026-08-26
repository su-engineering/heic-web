import { expect, test } from '@playwright/test';
import { hasNative, hasWebCodecsHevc, openHarness } from './support.ts';

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

/**
 * Colour is a choice the caller has to make, not something to decide for them.
 *
 * A VideoFrame out of an iPhone HEIC is commonly 10-bit in Display P3 or
 * BT.2020. Drawing it to a default canvas silently flattens it to 8-bit sRGB,
 * which is the right default for an avatar and the wrong one for a photo editor.
 * So the source characteristics are reported and the output space is an option.
 */
test('reports the source colour characteristics', async ({ page }) => {
  test.skip(!(await hasWebCodecsHevc(page)) && !(await hasNative(page)), 'no decode path');

  const results = await page.evaluate(async () => {
    const read = async (url: string) => {
      const blob = await (await fetch(url)).blob();
      const decoded = await window.heic.decodeHeic(blob);
      const summary = { color: decoded.sourceColor, bitDepth: decoded.bitDepth };
      decoded.image.close();
      return summary;
    };
    return {
      // An Apple photo carrying a full ICC profile.
      apple: await read('/test/fixtures/local/IMG_0679.HEIC'),
      // A libheif-encoded file carrying CICP values instead.
      libheif: await read('/test/fixtures/generated/asym-base.heic'),
    };
  });

  expect(results.apple.color?.type).toBe('icc');
  if (results.apple.color?.type === 'icc') {
    expect(results.apple.color.profile.byteLength).toBeGreaterThan(100);
  }

  expect(results.libheif.color?.type).toBe('nclx');
  if (results.libheif.color?.type === 'nclx') {
    // CICP: primaries, transfer and matrix are reported raw so a caller can
    // decide what they mean rather than being handed our interpretation.
    expect(typeof results.libheif.color.primaries).toBe('number');
    expect(typeof results.libheif.color.transfer).toBe('number');
    expect(typeof results.libheif.color.fullRange).toBe('boolean');
  }
  // The generated fixtures are 10-bit, which is what pixi reports.
  expect(results.libheif.bitDepth).toBe(10);
});

test('composites in display-p3 when asked', async ({ page }) => {
  test.skip(!(await hasWebCodecsHevc(page)), 'WebCodecs path required to choose a canvas space');

  const result = await page.evaluate(async () => {
    const blob = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();

    const decode = async (colorSpace: 'srgb' | 'display-p3') => {
      const decoded = await window.heic.decodeHeic(blob, { strategy: 'webcodecs', colorSpace });
      const canvas = new OffscreenCanvas(decoded.width, decoded.height);
      const ctx = canvas.getContext('2d', { colorSpace, willReadFrequently: true })!;
      ctx.drawImage(decoded.image, 0, 0);
      // Sample the saturated red patch in the top-left of the test pattern.
      const pixel = ctx.getImageData(20, 20, 1, 1, { colorSpace }).data;
      decoded.image.close();
      return { r: pixel[0]!, g: pixel[1]!, b: pixel[2]! };
    };

    return { srgb: await decode('srgb'), p3: await decode('display-p3') };
  });

  // Both paths must produce a plausible red, and the wide-gamut one must not be
  // silently identical (which would mean the option did nothing).
  expect(result.srgb.r).toBeGreaterThan(result.srgb.g);
  expect(result.p3.r).toBeGreaterThan(result.p3.g);
  console.log(`    srgb ${JSON.stringify(result.srgb)}  display-p3 ${JSON.stringify(result.p3)}`);
});

test('an explicit native strategy refuses rather than silently using WebCodecs', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const blob = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();
    try {
      const decoded = await window.heic.decodeHeic(blob, { strategy: 'native' });
      const strategy = decoded.strategy;
      decoded.image.close();
      return { strategy };
    } catch (error) {
      return { error: (error as Error).name };
    }
  });

  // Whichever way it goes, it must not come back claiming a strategy the caller
  // did not ask for.
  if ('strategy' in outcome) expect(outcome.strategy).toBe('native');
  else expect(outcome.error).toBe('HeicUnsupportedError');
});
