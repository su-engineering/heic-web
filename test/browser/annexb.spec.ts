import { expect, test } from '@playwright/test';
import { hasWebCodecsHevc, openHarness } from './support.ts';

/**
 * The `hev1` Annex B fallback.
 *
 * The preferred path passes the raw `hvcC` as `VideoDecoderConfig.description`
 * and submits HEIF tile payloads untouched, because they are already
 * length-prefixed NAL units. Every browser tested so far accepts that, which
 * means the fallback would otherwise never execute — and an untested fallback is
 * worse than no fallback, because it only runs on the machines you cannot
 * reproduce on.
 *
 * So this drives the conversion end to end against a real decoder: parameter
 * sets from the hvcC, tile data rewritten from length prefixes to start codes,
 * no description, `hev1` codec string.
 */
test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test('an Annex B stream built from our helpers decodes in a real VideoDecoder', async ({ page }) => {
  test.skip(!(await hasWebCodecsHevc(page)), 'needs a working HEVC decoder to decode anything');

  const result = await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await (await fetch('/test/fixtures/generated/asym-base.heic')).arrayBuffer(),
    );
    const plan = window.heic.planDecode(bytes);
    const group = plan.tileGroups[0]!;
    const tile = plan.tiles[0]!;

    const payload = window.heic.readItemData(plan.file, tile.itemId);
    const prologue = window.heic.hvccToAnnexBPrologue(group.hvcc);
    const body = window.heic.lengthPrefixedToAnnexB(
      payload,
      group.hvcc.lengthSizeMinusOne + 1,
    );
    const chunk = new Uint8Array(prologue.byteLength + body.byteLength);
    chunk.set(prologue, 0);
    chunk.set(body, prologue.byteLength);

    const codec = window.heic.hvccToCodecString(group.hvcc, 'hev1');
    const config: VideoDecoderConfig = {
      codec,
      codedWidth: tile.width,
      codedHeight: tile.height,
    };

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) return { codec, supported: false, frames: 0, size: '' };

    let frames = 0;
    let size = '';
    let failure: string | undefined;
    const decoder = new VideoDecoder({
      output: (frame) => {
        frames++;
        size = `${frame.displayWidth}x${frame.displayHeight}`;
        frame.close();
      },
      error: (error) => {
        failure = error.message;
      },
    });
    decoder.configure(config);
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: chunk }));
    await decoder.flush();
    decoder.close();

    return { codec, supported: true, frames, size, failure };
  });

  expect(result.supported, `this browser rejected ${result.codec}`).toBe(true);
  expect(result.failure).toBeUndefined();
  expect(result.frames).toBe(1);
  expect(result.size).toBe('480x320');
});
