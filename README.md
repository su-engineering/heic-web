# @su-engineering/heic

**Decode HEIC photos in the browser with native decoding, WebCodecs, and an optional WebAssembly fallback.**

[![CI](https://github.com/su-engineering/heic-web/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/su-engineering/heic-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

HEIC uploads need not force every visitor to download a software codec. This TypeScript library parses the HEIF container, tries the browser's image decoder, then uses WebCodecs HEVC decoding when available. You choose whether to load the libheif fallback if both paths fail.

- **On-demand fallback:** the core entry point does not import libheif or fetch a codec.
- **Primary-image decoding:** single HEVC items and tiled grids, with container rotation, mirroring, and clean-aperture cropping.
- **Useful diagnostics:** selected strategy, source dimensions, color metadata, and warnings accompany each bitmap.
- **Worker support:** no DOM dependency; compositing uses `OffscreenCanvas`.
- **Typed API:** ESM, TypeScript declarations, and a standalone browser bundle.

The project is at **0.1.0**. Test it with representative files and target devices before production use. The repository is named `heic-web`; the npm package name is `@su-engineering/heic`.

[API reference](docs/api.md) · [Compatibility and limitations](docs/compatibility.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Release process](docs/releasing.md)

## Installation

Install the package:

```sh
npm install @su-engineering/heic
```

For a source checkout, see [local development](CONTRIBUTING.md#local-development). Decoding runs in a browser or browser worker. Node.js can run the container parser, but this package does not provide a Node.js pixel decoder.

## Quick start

This example assumes an `<input id="photo" type="file">` and `<canvas id="preview">` on the page. It uses only browser-provided decoders; unsupported environments receive a typed error.

```ts
import { decodeHeic, isHeic, HeicUnsupportedError } from '@su-engineering/heic';

const input = document.querySelector<HTMLInputElement>('#photo')!;
const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file || !(await isHeic(file)).isHeic) return;

  try {
    const decoded = await decodeHeic(file, { maxDimension: 1024 });
    try {
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      canvas.getContext('2d')!.drawImage(decoded.image, 0, 0);
      console.log(decoded.strategy, decoded.warnings);
    } finally {
      decoded.image.close(); // Release pixels when you no longer need them.
    }
  } catch (error) {
    if (error instanceof HeicUnsupportedError) {
      console.error('No decoder succeeded:', error.attempts);
    } else {
      console.error('Could not decode this photo:', error);
    }
  }
});
```

`isHeic()` inspects file contents, rather than trusting the filename or MIME type. It is a routing hint, not a complete validation step. AVIF is not decoded by this package.

## Add the optional WASM fallback

```sh
npm install libheif-js
```

```ts
import { decodeHeic } from '@su-engineering/heic';

const decoded = await decodeHeic(file, {
  wasmLoader: async () => {
    const { wasmDecoder } = await import('@su-engineering/heic/wasm');
    return wasmDecoder;
  },
});
// Draw or transfer decoded.image, then close it when finished.
```

The separate entry point loads `libheif-js/wasm-bundle.js` on its first decode. A bundler supporting dynamic imports can keep the adapter and codec out of the initial chunk. Check your bundler's output: asset splitting and download sizes depend on your toolchain and the libheif version.

For self-hosted assets, custom builds, or direct browser imports, use [`createWasmAdapter`](docs/api.md#wasm-adapters). The core library is MIT licensed; optional libheif distributions have [their own licenses](docs/compatibility.md#third-party-code).

## Choose by capability

In `auto` mode the cascade is **native → WebCodecs → supplied fallback**. Without a fallback, a file that needs one fails with `HeicUnsupportedError`.

```ts
import { probeSupport } from '@su-engineering/heic';

const support = await probeSupport();
console.log(support.native, support.webcodecs, support.recommended);
```

HEVC support depends on the browser, OS, installed codecs, hardware, and file profile. A capability probe is advisory; decoding a particular file can still fail. Use HTTPS or localhost for WebCodecs. See the [compatibility guide](docs/compatibility.md) for requirements and test coverage.

## API at a glance

| Export | Purpose |
| --- | --- |
| `decodeHeic(input, options?)` | Decode a `Blob`, `File`, `ArrayBuffer`, or `Uint8Array` to an `ImageBitmap` plus metadata. |
| `isHeic(input)` | Inspect up to the first 64 KiB for HEIC identification and coding hints. |
| `probeSupport()` | Probe native HEIC decoding and accepted WebCodecs HEVC configurations. |
| `parseHeif(buffer)` | Inspect container items, properties, references, and locations without decoding pixels. |
| `planDecode(buffer)` | Resolve the primary image, tile layout, transforms, and source metadata. |
| `registerDecoderAdapter(adapter)` | Register a fallback for subsequent calls in the current JavaScript realm. |

Common decode options are `strategy`, `maxDimension`, `colorSpace`, `signal`, and `wasmLoader`. The [API reference](docs/api.md) documents their behavior and the complete exported surface.

## Scope and limits

This library returns pixels for the primary HEVC image. It does not encode HEIC, supply an upload UI, preserve EXIF in the output, or decode AVIF, animation, or Live Photo video. Recognized alpha, depth, and HDR gain-map auxiliary items produce warnings; warning coverage is not exhaustive.

`maxDimension` reduces the returned bitmap size. **It does not cap peak decode memory:** decoding and compositing may still allocate the full-resolution image. Apply file-size limits, bound concurrent decodes, and use workers for large or untrusted uploads.

`display-p3` requests a compositing canvas color space; it is not a guarantee of color fidelity across strategies. See [color and HDR limitations](docs/compatibility.md#color-and-hdr).

## Development

```sh
git clone https://github.com/su-engineering/heic-web.git
cd heic-web
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test:package
pnpm test:unit
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:browser
```

Use Node.js 22.12 or newer for development. The locked pnpm version is declared in `package.json`. Browser installation with `--with-deps` is intended for supported Linux distributions; on other platforms, see [test setup](CONTRIBUTING.md#browser-tests).

Headless Linux tests exercise the parser and fallback. They cannot establish platform HEVC coverage. Committed fixtures also do not cover the full range of Apple camera files. See [test fixtures](https://github.com/su-engineering/heic-web/blob/master/test/fixtures/README.md) and the [release checklist](docs/releasing.md).

## Help and contributions

Report reproducible bugs through [GitHub issues](https://github.com/su-engineering/heic-web/issues). Include browser/OS versions, the selected strategy or error context, and a redistributable sample when possible. Keep personal photographs and exploitable inputs out of public reports.

Small fixes, regression tests, and consented fixture contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), copyright SU Engineering. See [third-party code](docs/compatibility.md#third-party-code) for optional codec licensing.
