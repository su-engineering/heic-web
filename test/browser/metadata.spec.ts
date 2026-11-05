import { expect, test } from '@playwright/test';
import exifr from 'exifr';
import { hasWebCodecsHevc, loadFixtures, openHarness } from './support.ts';

const EXIF_FIXTURE = '/test/fixtures/generated/exif-thumb.heic';
const EXIF_REFERENCE = '/test/fixtures/generated/exif-thumb.ref.png';
const PLAIN_FIXTURE = '/test/fixtures/generated/asym-base.heic';

test.beforeEach(async ({ page }) => { await openHarness(page); });

/** Converts in the page and hands the encoded bytes back for parsing in Node. */
async function convert(
  page: import('@playwright/test').Page,
  url: string,
  options: Record<string, unknown>,
) {
  return page.evaluate(async ({ url, options }) => {
    const source = await (await fetch(url)).blob();
    const converted = await window.heic.convertHeic(source, {
      strategy: 'wasm', wasmLoader: async () => window.wasmAdapter(), ...options,
    });
    // createImageBitmap honours EXIF Orientation by default, exactly like an
    // <img>. If Orientation were left at 6 the decoded bitmap would come out
    // with width and height swapped.
    const bitmap = await createImageBitmap(converted.blob);
    const result = {
      bytes: Array.from(new Uint8Array(await converted.blob.arrayBuffer())),
      exif: converted.exif,
      warnings: converted.warnings.map((w) => w.code),
      width: converted.width,
      height: converted.height,
      shownWidth: bitmap.width,
      shownHeight: bitmap.height,
    };
    bitmap.close();
    return result;
  }, { url, options });
}

test('EXIF is dropped by default', async ({ page }) => {
  const result = await convert(page, EXIF_FIXTURE, {});
  expect(result.exif).toBe('none');
  // WebKit's encoder writes its own ColorSpace/dimension tags; nothing from the
  // source file may appear.
  const tags = (await exifr.parse(new Uint8Array(result.bytes))) ?? {};
  expect(tags.Make).toBeUndefined();
  expect(tags.DateTimeOriginal).toBeUndefined();
  expect(tags.latitude).toBeUndefined();
});

test("exif: 'all' keeps the metadata and makes it match the upright pixels", async ({ page }) => {
  const result = await convert(page, EXIF_FIXTURE, { exif: 'all' });
  expect(result.exif).toBe('all');
  expect(result.warnings).toEqual([]);
  const tags = await exifr.parse(new Uint8Array(result.bytes), { translateValues: false });
  expect(tags.Make).toBe('heic-web');
  expect(tags.Orientation).toBe(1);
  expect(tags.ExifImageWidth).toBe(result.width);
  expect(tags.ExifImageHeight).toBe(result.height);
  expect(tags.latitude).toBeCloseTo(41.3851, 3);
  expect([result.width, result.height]).toEqual([320, 480]);
  expect([result.shownWidth, result.shownHeight]).toEqual([320, 480]);
});

test("exif: 'no-location' removes GPS and keeps the rest", async ({ page }) => {
  const result = await convert(page, EXIF_FIXTURE, { exif: 'no-location', maxDimension: 120 });
  expect(result.exif).toBe('no-location');
  const tags = await exifr.parse(new Uint8Array(result.bytes), { translateValues: false });
  expect(tags.latitude).toBeUndefined();
  expect(tags.GPSLatitude).toBeUndefined();
  expect(tags.Make).toBe('heic-web');
  expect(tags.Orientation).toBe(1);
  expect(tags.ExifImageWidth).toBe(80);
  expect(tags.ExifImageHeight).toBe(120);
  expect(await exifr.gps(new Uint8Array(result.bytes))).toBeUndefined();
});

test('asking for EXIF from a file without any reports it instead of failing', async ({ page }) => {
  const result = await convert(page, PLAIN_FIXTURE, { exif: 'all' });
  expect(result.exif).toBe('none');
  expect(result.warnings).toContain('exif-missing');
});

test('EXIF options are validated before decoding', async ({ page }) => {
  const outcomes = await page.evaluate(async () => {
    const out = [];
    for (const options of [{ exif: 'all', type: 'image/png' }, { exif: 'gps' }]) {
      try {
        await window.heic.convertHeic(new Blob(), options as Parameters<typeof window.heic.convertHeic>[1]);
      } catch (error) { out.push((error as Error).name); }
    }
    return out;
  });
  expect(outcomes).toEqual(['TypeError', 'TypeError']);
});

test('readExif returns the raw TIFF block, or null', async ({ page }) => {
  const result = await page.evaluate(async ({ withExif, without }) => {
    const read = async (url: string) => window.heic.readExif(await (await fetch(url)).blob());
    const tiff = await read(withExif);
    return { head: tiff ? Array.from(tiff.subarray(0, 4)) : null, none: await read(without) };
  }, { withExif: EXIF_FIXTURE, without: PLAIN_FIXTURE });
  expect([[0x4d, 0x4d, 0x00, 0x2a], [0x49, 0x49, 0x2a, 0x00]]).toContainEqual(result.head);
  expect(result.none).toBeNull();
});

test.describe('decodeHeicThumbnail', () => {
  test('decodes the embedded thumbnail upright with WebCodecs', async ({ page }) => {
    test.skip(!(await hasWebCodecsHevc(page, EXIF_FIXTURE)), 'WebCodecs HEVC required');
    const result = await page.evaluate(async ({ url, reference }) => {
      const source = await (await fetch(url)).blob();
      const thumb = await window.heic.decodeHeicThumbnail(source, { fallback: 'none' });
      const out = {
        embedded: thumb.embedded, width: thumb.width, height: thumb.height,
        strategy: thumb.strategy,
        mad: await window.meanAbsoluteDifference(thumb.image, reference),
      };
      thumb.image.close();
      return out;
    }, { url: EXIF_FIXTURE, reference: EXIF_REFERENCE });
    expect(result).toMatchObject({ embedded: true, width: 64, height: 96, strategy: 'webcodecs' });
    // A 64 px frame upscaled against the full reference: loose, but a wrong
    // rotation lands far above this.
    expect(result.mad).toBeLessThan(25);
  });

  test('falls back to a downscaled primary sized like the thumbnail', async ({ page }) => {
    const result = await page.evaluate(async ({ url, reference }) => {
      const source = await (await fetch(url)).blob();
      const thumb = await window.heic.decodeHeicThumbnail(source, {
        strategy: 'wasm', wasmLoader: async () => window.wasmAdapter(),
      });
      const out = {
        embedded: thumb.embedded, width: thumb.width, height: thumb.height,
        mad: await window.meanAbsoluteDifference(thumb.image, reference),
      };
      thumb.image.close();
      return out;
    }, { url: EXIF_FIXTURE, reference: EXIF_REFERENCE });
    expect(result).toMatchObject({ embedded: false, width: 64, height: 96 });
    expect(result.mad).toBeLessThan(25);
  });

  test('without a thumbnail, falls back to 320 px or throws when told to', async ({ page }) => {
    const result = await page.evaluate(async (url) => {
      const source = await (await fetch(url)).blob();
      const thumb = await window.heic.decodeHeicThumbnail(source, {
        strategy: 'wasm', wasmLoader: async () => window.wasmAdapter(),
      });
      const out = { embedded: thumb.embedded, width: thumb.width, height: thumb.height, error: '' };
      thumb.image.close();
      try { await window.heic.decodeHeicThumbnail(source, { fallback: 'none' }); }
      catch (error) { out.error = (error as Error).name; }
      return out;
    }, PLAIN_FIXTURE);
    expect(result).toEqual({ embedded: false, width: 320, height: 213, error: 'HeicUnsupportedError' });
  });

  for (const fixture of loadFixtures().filter((f) => f.name.toLowerCase().endsWith('.heic'))) {
    test(`thumbnail of ${fixture.name} has the primary's orientation`, async ({ page }) => {
      test.skip(!(await hasWebCodecsHevc(page, fixture.url)), 'WebCodecs HEVC required');
      const result = await page.evaluate(async (url) => {
        const thumb = await window.heic.decodeHeicThumbnail(await (await fetch(url)).blob());
        const out = { width: thumb.width, height: thumb.height, embedded: thumb.embedded };
        thumb.image.close();
        return out;
      }, fixture.url);
      const portrait = fixture.expect.height > fixture.expect.width;
      expect(result.height > result.width).toBe(portrait);
      expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(320);
    });
  }
});
