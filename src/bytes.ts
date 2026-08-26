/**
 * TypeScript 5.7 models `Uint8Array` as generic over `ArrayBufferLike`, which
 * includes `SharedArrayBuffer`, and `BlobPart` accepts only `ArrayBuffer`-backed
 * views. Every buffer in this package comes from a `Blob`, an `ArrayBuffer`, or
 * an allocation of our own, so none is ever shared-backed.
 *
 * One narrow helper rather than a cast scattered at each call site.
 */
export function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

/** Wraps bytes in a Blob the browser will try to decode as HEIC. */
export function toHeicBlob(bytes: Uint8Array): Blob {
  return new Blob([toBlobPart(bytes)], { type: 'image/heic' });
}
