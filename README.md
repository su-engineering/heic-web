# @su-engineering/heic

Decode iPhone HEIC photos in the browser, without shipping a WebAssembly codec to
everyone.

Chrome and Firefox cannot display HEIC. Google never licensed HEVC, so there is
no native image decode path and no plan to add one. Every iPhone still produces
HEIC by default, so any site that accepts profile picture uploads silently fails
for a large share of its users.

The usual answer is to ship libheif compiled to WebAssembly, roughly 1.2 MB, to
every visitor. That is the only reason most sites do not bother.

This package takes a different route. HEIC is an HEVC-coded image inside an
ISOBMFF container, and Chrome's WebCodecs `VideoDecoder` has supported HEVC since
Chrome 107, backed by platform hardware decode. Parse the container in JavaScript,
hand the raw bitstream to `VideoDecoder`, and you get hardware-accelerated HEIC
decode with no wasm at all, on the large majority of devices.

**10.5 KB gzipped.** wasm becomes a last-resort fallback that you opt into, not
the default.

## Usage

```ts
import { decodeHeic, isHeic } from '@su-engineering/heic';

const file = input.files[0];
if ((await isHeic(file)).isHeic) {
  const { image, width, height } = await decodeHeic(file);
  canvas.getContext('2d').drawImage(image, 0, 0);
}
```

## Support matrix

Measured, not assumed — these are the numbers `probeSupport()` returns in each
browser, on macOS:

| Browser | Native | WebCodecs HEVC | Strategy used | Cost |
|---|---|---|---|---|
| Safari / WebKit | yes | yes | `native` | free |
| Chrome, Edge, Brave (macOS, most Android, Windows with the HEVC extension) | no | yes | `webcodecs` | ~10 KB |
| Chrome on Linux, Windows without the HEVC extension | no | no | `wasm` | ~1.2 MB, opt-in |
| Firefox | no | no | `wasm` | ~1.2 MB, opt-in |

Ask before you download anything:

```ts
import { probeSupport } from '@su-engineering/heic';

const report = await probeSupport();
// { native: false, webcodecs: true,
//   hevcCodecStrings: ['hvc1.3.e.L93.B0', ...], recommended: 'webcodecs' }

if (report.recommended === 'wasm') {
  // Only now is it worth preloading the fallback.
}
```

## The wasm fallback

Nothing is fetched behind your back. If strategies 1 and 2 both fail and you have
not supplied an adapter, `decodeHeic` throws `HeicUnsupportedError` naming what
was missing.

```ts
import { decodeHeic } from '@su-engineering/heic';
import { wasmDecoder } from '@su-engineering/heic/wasm';

await decodeHeic(file, { wasmLoader: async () => wasmDecoder });
```

`@su-engineering/heic/wasm` is a separate entry point, so bundlers never pull the
codec into your main chunk. It needs `libheif-js`, an optional peer dependency —
the core package builds and passes its tests without it installed.

## API

### `decodeHeic(input, options?): Promise<DecodedImage>`

`input` is a `Blob`, `File`, `ArrayBuffer` or `Uint8Array`.

| Option | Default | Meaning |
|---|---|---|
| `strategy` | `'auto'` | `'native'`, `'webcodecs'`, `'wasm'`, or `'auto'` for the cascade |
| `colorSpace` | `'srgb'` | Canvas colour space. `'display-p3'` preserves wide-gamut source colour |
| `maxDimension` | — | Downscale the result so its longest side is at most this. A memory control, see below |
| `signal` | — | `AbortSignal`, honoured at every await including mid-way through a multi-tile decode |
| `wasmLoader` | — | Supplies the fallback adapter on demand |

The result reports what happened, not just pixels:

```ts
{
  image: ImageBitmap,
  width, height,              // of the returned bitmap
  sourceWidth, sourceHeight,  // intrinsic size, before any maxDimension scaling
  strategy: 'webcodecs',
  bitDepth: 8,
  isGrid: true,
  tileCount: 48,
  sourceColor: { type: 'icc', profile: Uint8Array } | { type: 'nclx', ... } | null,
  transformsApplied: { rotation: 270, mirrored: 'none', cropped: false },
  warnings: [{ code: 'gain-map-ignored', message: '...' }],
}
```

### `isHeic(input): Promise<{ isHeic, brand?, primaryItemType?, coding? }>`

Reads the `ftyp` brands and the primary item type — never the filename or the
MIME type the browser guessed, both of which are routinely wrong for photos
copied off a phone. Given a `Blob`, it reads only the first 64 KB, because you
will want to call it on every file a user drops.

AVIF shares the `mif1` brand with HEIC, so the result is discriminated rather
than boolean. A `{ isHeic: false, coding: 'av1' }` tells you to route the file to
an AVIF decoder instead of treating it as unreadable.

### `probeSupport(): Promise<SupportReport>`

Cheap capability report. `isConfigSupported` is a query, not a decoder, and the
native probe decodes a 471-byte inline image.

### `parseHeif(buffer): HeifFile`

The container parser on its own, for inspection tooling and tests. There is also
a box-tree dumper:

```
node --experimental-strip-types tools/dump.ts photo.heic --boxes
```

### `maxDimension` is a memory control

Not an image processing feature. A 48 MP iPhone photo composited at full
resolution is a ~190 MB canvas, and if you are building a 512 px avatar you
should not have to hold that. When set, the bitmap is produced with
`resizeQuality: 'high'` and the full-size canvas is released immediately. Only
the decoder can free it that early, which is the whole reason this one flag lives
here rather than in a wrapper.

## Works in a Web Worker

The core never touches `document` or `window` — `OffscreenCanvas` only, and
`VideoDecoder` is available in workers. This is a tested requirement, not an
aspiration: the suite runs a full decode inside a worker on every browser.

## What this does not do

Deliberately narrow. It decodes. It does not resize, re-encode, strip EXIF, or
provide UI.

Not supported in 0.1, and detected rather than ignored — when one of these is
present the primary image still decodes and a structured warning says what was
skipped:

- Alpha aux images
- Depth maps
- HDR gain maps (iOS 17+)
- Live Photo motion tracks
- Multi-image bursts and image sequences
- Animated HEIF
- HEIC **encoding**
- `VideoFrame` output — for grid images there is no single decoder frame, and
  offering it would work for single-item files and be a lie for the common case
- Any re-encoding, format conversion or metadata stripping

## Security

This parses hostile input in your users' browsers. Every read is bounds-checked,
nesting is capped, and no allocation is made on a declared size without first
validating it against the actual buffer. The parser is fuzzed with mutated real
files: every crash is a bug, every hang is a worse one.

**This is a client-side decoder. Your server must still validate uploads
independently.** Nothing here is a substitute for that.

See [SECURITY.md](./SECURITY.md).

## Errors

A typed hierarchy, never a bare `Error`. Each carries enough context to file a
useful bug report — brand, item type, strategy attempted, codec string.

`HeicParseError`, `HeicUnsupportedError`, `HeicDecodeError`, `HeicAbortError`,
all extending `HeicError`.

## Licence

MIT
