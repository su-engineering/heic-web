import { expect, test } from '@playwright/test';
import { hasWebCodecsHevc, loadFixtures, openHarness } from './support.ts';

/**
 * The decoder's output frame size must match the item's `ispe`.
 *
 * Tiles are composited with `drawImage(frame, x, y, ispeWidth, ispeHeight)`,
 * which *scales* the frame to the item's declared size. That is the right
 * behaviour when they agree, and it silently resamples the whole image when they
 * do not — a failure that a solid-colour fixture cannot reveal, because scaling a
 * uniform patch looks identical.
 *
 * So the agreement is asserted directly rather than assumed.
 */
test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

for (const { url } of loadFixtures()) {
  test(`decoder frame size matches ispe for ${url.split('/').pop()}`, async ({ page }) => {
    test.skip(!(await hasWebCodecsHevc(page, url)), 'WebCodecs path required');

    const result = await page.evaluate(async (fixtureUrl) => {
      const bytes = new Uint8Array(await (await fetch(fixtureUrl)).arrayBuffer());
      const plan = window.heic.planDecode(bytes);
      const group = plan.tileGroups[0]!;
      const tile = plan.tiles[0]!;

      const config: VideoDecoderConfig = {
        codec: group.codec,
        description: new Uint8Array(group.hvcc.raw),
        codedWidth: tile.width,
        codedHeight: tile.height,
      };
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) return null;

      let observed: { coded: string; display: string } | undefined;
      const decoder = new VideoDecoder({
        output: (frame) => {
          observed ??= {
            coded: `${frame.codedWidth}x${frame.codedHeight}`,
            display: `${frame.displayWidth}x${frame.displayHeight}`,
          };
          frame.close();
        },
        error: () => {},
      });
      decoder.configure(config);
      decoder.decode(
        new EncodedVideoChunk({
          type: 'key',
          timestamp: 0,
          data: window.heic.readItemData(plan.file, tile.itemId),
        }),
      );
      await decoder.flush();
      decoder.close();

      return { ispe: `${tile.width}x${tile.height}`, ...observed! };
    }, url);

    if (result === null) test.skip(true, 'config not supported here');
    console.log(`    ${url.split('/').pop()}: ispe ${result!.ispe}, frame display ${result!.display}, coded ${result!.coded}`);
    // The display size is what drawImage uses as the source rectangle.
    expect(result!.display).toBe(result!.ispe);
  });
}
