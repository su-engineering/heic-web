import { HeicAbortError, HeicDecodeError } from '../errors.ts';

/**
 * Creates an OffscreenCanvas.
 *
 * Deliberately never touches `document`: the whole package must run inside a Web
 * Worker, and a single `document.createElement('canvas')` anywhere would make
 * that impossible. This is the only place a canvas is created, so that guarantee
 * is enforceable by review.
 */
export function createCanvas(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new HeicDecodeError(
      'OffscreenCanvas is not available; this environment cannot composite',
      {},
    );
  }
  return new OffscreenCanvas(width, height);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HeicAbortError();
}
