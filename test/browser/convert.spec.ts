import { expect, test } from '@playwright/test';
import { openHarness } from './support.ts';

test.beforeEach(async ({ page }) => { await openHarness(page); });

for (const type of ['image/jpeg', 'image/png'] as const) {
  test(`conversion encodes rotated, resized pixels as ${type}`, async ({ page }) => {
    const result = await page.evaluate(async (type) => {
      const consumerUrl = '/test/.consumer/stdin.js';
      const consumer = await import(/* @vite-ignore */ consumerUrl);
      const source = await (await fetch('/test/fixtures/generated/asym-irot-90.heic')).blob();
      const converted = await consumer.convertHeic(source, {
        type, quality: 0.9, maxDimension: 160, strategy: 'wasm',
        wasmLoader: async () => consumer.wasmDecoder,
      });
      const bitmap = await createImageBitmap(converted.blob);
      const result = { type: converted.blob.type, size: converted.blob.size,
        width: converted.width, height: converted.height, encodedWidth: bitmap.width,
        encodedHeight: bitmap.height, sourceWidth: converted.sourceWidth,
        sourceHeight: converted.sourceHeight, rotation: converted.transformsApplied.rotation,
        strategy: converted.strategy, hasImage: 'image' in converted,
        mad: await window.meanAbsoluteDifference(bitmap, '/test/fixtures/generated/asym-irot-90.ref.png') };
      bitmap.close();
      return result;
    }, type);
    expect(result.type).toBe(type);
    expect(result.size).toBeGreaterThan(100);
    expect(result.width).toBe(107);
    expect(result.height).toBe(160);
    expect(result.encodedWidth).toBe(107);
    expect(result.encodedHeight).toBe(160);
    expect(result.sourceWidth).toBe(320);
    expect(result.sourceHeight).toBe(480);
    expect(result.rotation).toBe(90);
    expect(result.strategy).toBe('wasm');
    expect(result.hasImage).toBe(false);
    expect(result.mad).toBeLessThan(10);
  });
}

test('conversion rejects invalid encoding options before loading a codec', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { convertHeic } = window.heic;
    let loaded = false;
    const outcomes = [];
    for (const options of [{ quality: NaN }, { quality: -1 }, { quality: 1.1 }, { type: 'image/webp' }]) {
      try { await convertHeic(new Blob(), { ...options, wasmLoader: async () => { loaded = true; throw new Error('loaded'); } } as Parameters<typeof convertHeic>[1]); }
      catch (error) { outcomes.push((error as Error).name); }
    }
    return { loaded, outcomes };
  });
  expect(result).toEqual({ loaded: false, outcomes: ['RangeError', 'RangeError', 'RangeError', 'TypeError'] });
});

test('conversion supports workers and default JPEG output', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker('/test/browser/convert-worker.js', { type: 'module' });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage(null);
      });
    } finally { worker.terminate(); }
  });
  expect(result).toMatchObject({ type: 'image/jpeg', width: 480, height: 320, strategy: 'wasm' });
  expect(result.size).toBeGreaterThan(100);
});

test('conversion cancellation does not load the codec', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { convertHeic } = window.heic;
    const controller = new AbortController(); controller.abort();
    let loaded = false;
    try { await convertHeic(new Blob(), { signal: controller.signal,
      wasmLoader: async () => { loaded = true; throw new Error('loaded'); } }); }
    catch (error) { return { name: (error as Error).name, loaded }; }
    return null;
  });
  expect(result).toEqual({ name: 'HeicAbortError', loaded: false });
});

test('conversion releases pixels after encoder failure or late cancellation', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const consumerUrl = '/test/.consumer/stdin.js';
    const consumer = await import(/* @vite-ignore */ consumerUrl);
    const source = await (await fetch('/test/fixtures/generated/asym-base.heic')).blob();
    const encode = OffscreenCanvas.prototype.convertToBlob;
    const close = ImageBitmap.prototype.close;
    const outcomes = [];
    for (const failure of ['encode', 'abort']) {
      const controller = new AbortController();
      let closed = 0;
      let canvas: OffscreenCanvas | undefined;
      ImageBitmap.prototype.close = function () { closed++; return close.call(this); };
      OffscreenCanvas.prototype.convertToBlob = async function (options) {
        canvas = this;
        if (failure === 'encode') throw new Error('encoder failed');
        const result = await encode.call(this, options); controller.abort(); return result;
      };
      try {
        await consumer.convertHeic(source, { strategy: 'wasm', signal: controller.signal, wasmLoader: async () => consumer.wasmDecoder });
      } catch (error) { outcomes.push({ name: (error as Error).name, closed, canvasWidth: canvas?.width, canvasHeight: canvas?.height }); }
      finally { ImageBitmap.prototype.close = close; OffscreenCanvas.prototype.convertToBlob = encode; }
    }
    return outcomes;
  });
  expect(results).toEqual([
    { name: 'Error', closed: 1, canvasWidth: 0, canvasHeight: 0 },
    { name: 'HeicAbortError', closed: 1, canvasWidth: 0, canvasHeight: 0 },
  ]);
});
