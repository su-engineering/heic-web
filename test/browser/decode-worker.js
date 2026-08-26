/**
 * Worker-side half of the worker compatibility test.
 *
 * A real served module rather than a blob URL, so the bare `/dist/index.js`
 * import resolves against the server origin the way it would in a real app.
 *
 * The core must not touch `document` or `window`. If a stray DOM reference ever
 * creeps in, this file is where it surfaces.
 */
import { decodeHeic, isHeic, probeSupport } from '/dist/index.js';

self.onmessage = async (event) => {
  try {
    const response = await fetch(event.data.url);
    const blob = await response.blob();

    const detection = await isHeic(blob);
    const report = await probeSupport();
    const decoded = await decodeHeic(blob, { strategy: event.data.strategy });

    self.postMessage({
      ok: true,
      isHeic: detection.isHeic,
      webcodecs: report.webcodecs,
      strategy: decoded.strategy,
      width: decoded.width,
      height: decoded.height,
      tileCount: decoded.tileCount,
      rotation: decoded.transformsApplied.rotation,
    });
    decoded.image.close();
  } catch (error) {
    self.postMessage({ ok: false, error: String(error && error.stack ? error.stack : error) });
  }
};
