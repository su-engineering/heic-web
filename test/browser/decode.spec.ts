import { expect, test } from '@playwright/test';
import { gridFixtures, hasNative, hasWebCodecsHevc, loadFixtures, openHarness } from './support.ts';

/**
 * Assertions are structural (exact) plus perceptual (tolerant).
 *
 * Exact pixel hashes are deliberately avoided: GPU decode paths differ subtly
 * between devices, and a hash comparison would fail on a different machine for
 * reasons that have nothing to do with correctness. Mean absolute difference
 * against libheif's own output is tight enough to catch a wrong tile order or a
 * missed rotation and loose enough to survive a different GPU.
 */
const MAD_TOLERANCE = 6;

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test('probeSupport reports a coherent picture of the environment', async ({ page }) => {
  const report = await page.evaluate(() => window.heic.probeSupport());
  expect(typeof report.native).toBe('boolean');
  expect(typeof report.webcodecs).toBe('boolean');
  expect(Array.isArray(report.hevcCodecStrings)).toBe(true);
  if (report.webcodecs) expect(report.hevcCodecStrings.length).toBeGreaterThan(0);
  // recommended must be reachable given what was reported.
  if (report.recommended === 'native') expect(report.native).toBe(true);
  if (report.recommended === 'webcodecs') expect(report.webcodecs).toBe(true);
  console.log(`    ${test.info().project.name}: ${JSON.stringify(report)}`);
});

test.describe('isHeic', () => {
  for (const fixture of loadFixtures()) {
    test(`identifies ${fixture.name} from its contents`, async ({ page }) => {
      const result = await page.evaluate(async (url) => {
        const blob = await (await fetch(url)).blob();
        // A Blob with a deliberately wrong MIME type: detection must read the
        // bytes, never what the browser guessed.
        const mislabelled = new Blob([await blob.arrayBuffer()], { type: 'application/octet-stream' });
        return window.heic.isHeic(mislabelled);
      }, fixture.url);
      expect(result.isHeic).toBe(true);
      expect(result.coding).toBe('hevc');
    });
  }

  test('rejects a PNG', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      return window.heic.isHeic(bytes);
    });
    expect(result.isHeic).toBe(false);
  });

  test('routes an AVIF away rather than returning a bare false', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/generated/sample.avif')).blob();
      return window.heic.isHeic(blob);
    });
    expect(result.isHeic).toBe(false);
    // The point of the discriminated result: a caller can send this to an AVIF
    // decoder instead of treating it as an unreadable file.
    expect(result.coding).toBe('av1');
  });

  test('reads only the first 64 KB of a Blob', async ({ page }) => {
    const sliced = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/local/IMG_3031.heic')).blob();
      const ranges: { start: number; end: number }[] = [];
      // Wrap slice() to observe what the detector actually asks for.
      const original = blob.slice.bind(blob);
      const spy = new Proxy(blob, {
        get(target, property) {
          if (property === 'slice') {
            return (start: number, end: number) => {
              ranges.push({ start, end });
              return original(start, end);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await window.heic.isHeic(spy as Blob);
      return { ranges, size: blob.size };
    });
    expect(sliced.size).toBeGreaterThan(1_000_000);
    expect(sliced.ranges).toEqual([{ start: 0, end: 65_536 }]);
  });
});

test.describe('decode', () => {
  for (const fixture of loadFixtures()) {
    test(`decodes ${fixture.name} (${fixture.device})`, async ({ page }) => {
      const supported = (await hasWebCodecsHevc(page)) || (await hasNative(page));
      test.skip(
        !supported,
        'no native or WebCodecs HEVC decode in this browser; the wasm path is covered separately',
      );

      const result = await page.evaluate(async ({ url, referenceUrl }) => {
        const blob = await (await fetch(url)).blob();
        const decoded = await window.heic.decodeHeic(blob);
        const summary = {
          width: decoded.width,
          height: decoded.height,
          sourceWidth: decoded.sourceWidth,
          sourceHeight: decoded.sourceHeight,
          strategy: decoded.strategy,
          bitDepth: decoded.bitDepth,
          isGrid: decoded.isGrid,
          tileCount: decoded.tileCount,
          transformsApplied: decoded.transformsApplied,
          warnings: decoded.warnings.map((w) => w.code),
          mad: null as number | null,
        };
        if (referenceUrl) summary.mad = await window.meanAbsoluteDifference(decoded.image, referenceUrl);
        decoded.image.close();
        return summary;
      }, { url: fixture.url, referenceUrl: fixture.referenceUrl ?? null });

      // Structural: exact, always.
      expect(result.width).toBe(fixture.expect.width);
      expect(result.height).toBe(fixture.expect.height);
      expect(result.sourceWidth).toBe(fixture.expect.width);
      expect(result.sourceHeight).toBe(fixture.expect.height);
      expect(result.isGrid).toBe(fixture.expect.isGrid);
      expect(result.tileCount).toBe(fixture.expect.tileCount);
      expect(result.bitDepth).toBe(fixture.expect.bitDepth);
      expect(result.transformsApplied.rotation).toBe(fixture.expect.rotation);
      expect(result.transformsApplied.mirrored).toBe(fixture.expect.mirrored);

      if (fixture.features.gainMap) expect(result.warnings).toContain('gain-map-ignored');

      // Perceptual: tolerant, against libheif's own render of the same file.
      if (result.mad !== null) {
        console.log(`    ${fixture.name} via ${result.strategy}: MAD ${result.mad.toFixed(2)}`);
        expect(result.mad).toBeLessThan(MAD_TOLERANCE);
      }
    });
  }

  test('maxDimension scales the result and leaves sourceWidth intact', async ({ page }) => {
    test.skip(!(await hasWebCodecsHevc(page)) && !(await hasNative(page)), 'no decode path');
    const result = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/local/IMG_3031.heic')).blob();
      const decoded = await window.heic.decodeHeic(blob, { maxDimension: 512 });
      const summary = {
        width: decoded.width,
        height: decoded.height,
        sourceWidth: decoded.sourceWidth,
        sourceHeight: decoded.sourceHeight,
      };
      decoded.image.close();
      return summary;
    });
    expect(Math.max(result.width, result.height)).toBe(512);
    // Aspect ratio preserved, and the intrinsic size still reported.
    expect(result.sourceWidth).toBe(3888);
    expect(result.sourceHeight).toBe(6912);
    expect(result.width / result.height).toBeCloseTo(3888 / 6912, 2);
  });

  test('honours an AbortSignal mid-decode', async ({ page }) => {
    test.skip(!(await hasWebCodecsHevc(page)), 'WebCodecs path required to abort mid-tile');
    const outcome = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/local/IMG_3031.heic')).blob();
      const controller = new AbortController();
      const promise = window.heic.decodeHeic(blob, {
        strategy: 'webcodecs',
        signal: controller.signal,
      });
      controller.abort();
      try {
        const decoded = await promise;
        decoded.image.close();
        return 'resolved';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(outcome).toBe('HeicAbortError');
  });

  test('an explicit unavailable strategy throws a typed, informative error', async ({ page }) => {
    const error = await page.evaluate(async () => {
      const blob = await (await fetch('/test/fixtures/libheif-2x2-single.heic')).blob();
      try {
        // No adapter registered and no wasmLoader: this must refuse rather than
        // silently fetching a megabyte of codec.
        await window.heic.decodeHeic(blob, { strategy: 'wasm' });
        return { name: 'resolved', message: '' };
      } catch (e) {
        return { name: (e as Error).name, message: (e as Error).message };
      }
    });
    expect(error.name).toBe('HeicUnsupportedError');
    expect(error.message).toMatch(/wasmLoader|registerDecoderAdapter/);
  });
});

test.describe('resource leaks', () => {
  test('decodes 20+ grid images sequentially in one page', async ({ page }) => {
    test.skip(!(await hasWebCodecsHevc(page)), 'WebCodecs path required: this covers the frame pool');

    const fixtures = gridFixtures();
    test.skip(fixtures.length === 0, 'no grid fixtures available');

    // A leaked VideoFrame or unclosed decoder passes every single-image test and
    // fails only here, typically as a silent hang rather than an error — so the
    // per-decode timeout is the real assertion.
    const urls: string[] = [];
    for (let i = 0; urls.length < 24; i++) urls.push(fixtures[i % fixtures.length]!.url);

    const completed = await page.evaluate(async (list) => {
      let count = 0;
      for (const url of list) {
        const blob = await (await fetch(url)).blob();
        const decoded = await Promise.race([
          window.heic.decodeHeic(blob, { strategy: 'webcodecs', maxDimension: 256 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`decode ${count} hung`)), 30_000),
          ),
        ]);
        decoded.image.close();
        count++;
      }
      return count;
    }, urls);

    expect(completed).toBe(urls.length);
  });

  test('runs a full decode inside a Web Worker', async ({ page }) => {
    test.skip(!(await hasWebCodecsHevc(page)), 'WebCodecs path required');

    // The core must never touch document or window: the wrapper SDK will want to
    // put this whole package in a worker, and a stray DOM reference would make
    // that impossible. The worker is a real served module, not a blob URL, so
    // the bare '/dist/index.js' import resolves the way it would in an app.
    const result = await page.evaluate(async () => {
      const worker = new Worker('/test/browser/decode-worker.js', { type: 'module' });
      const outcome = await new Promise<Record<string, unknown>>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => resolve({ ok: false, error: `worker error: ${event.message}` });
        worker.postMessage({ url: '/test/fixtures/local/IMG_0679.HEIC', strategy: 'webcodecs' });
      });
      worker.terminate();
      return outcome;
    });

    expect(result.ok, String(result.error)).toBe(true);
    expect(result.isHeic).toBe(true);
    expect(result.strategy).toBe('webcodecs');
    expect(result.width).toBe(3024);
    expect(result.height).toBe(4032);
    expect(result.tileCount).toBe(48);
    // The rotation is applied inside the worker too, via OffscreenCanvas only.
    expect(result.rotation).toBe(270);
  });
});
