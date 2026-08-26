import { expect, test } from '@playwright/test';
import { hasNative, openHarness } from './support.ts';

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

/**
 * The cascade's bookkeeping, observed through the public API.
 *
 * When every strategy is exhausted, `HeicUnsupportedError` lists what each one
 * tried and why it did not work. That message is the contract: it is what a user
 * will paste into a bug report, so it has to say something actionable rather
 * than "could not decode".
 */
test('the failure message names every strategy and why each was unavailable', async ({ page }) => {
  const message = await page.evaluate(async () => {
    const blob = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();
    try {
      // No wasmLoader, so on a browser without native or WebCodecs HEVC this
      // exhausts the cascade.
      const decoded = await window.heic.decodeHeic(blob);
      decoded.image.close();
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  });

  if (message === null) {
    // This browser decoded it, which is the other correct outcome.
    return;
  }
  expect(message).toContain('native');
  expect(message).toContain('webcodecs');
  expect(message).toContain('wasm');
  // The wasm line must tell the caller how to enable it, not just that it failed.
  expect(message).toMatch(/wasmLoader|registerDecoderAdapter/);
});

test('a browser with no image decoder is only probed once', async ({ page }) => {
  test.skip(await hasNative(page), 'this browser decodes HEIC natively');

  const reasons = await page.evaluate(async () => {
    const blob = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();
    const attempt = async () => {
      try {
        const decoded = await window.heic.decodeHeic(blob, { strategy: 'native' });
        decoded.image.close();
        return 'decoded';
      } catch (error) {
        return (error as Error).message;
      }
    };
    return [await attempt(), await attempt()];
  });

  // The first call actually asks the browser. The second reports the cached
  // answer, which is how a page decoding twenty files avoids twenty pointless
  // Blob constructions and twenty rejected decodes.
  expect(reasons[0]).toContain('createImageBitmap rejected');
  expect(reasons[1]).toContain('no HEIC image decoder');
});
