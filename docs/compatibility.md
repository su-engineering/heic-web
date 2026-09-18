# Compatibility and limitations

## Runtime requirements

Pixel decoding targets modern browsers and dedicated browser workers. It uses `ImageBitmap` and `createImageBitmap`; software and WebCodecs compositing also require `OffscreenCanvas` with a 2D context. WebCodecs requires `VideoDecoder` and `EncodedVideoChunk`, normally in a secure context (HTTPS or localhost).

The Node.js engine field describes package tooling compatibility, not a server pixel-decoding implementation. Parser/inspection functions can be used without browser rendering APIs. Development uses Node.js 22.12+.

## Strategy selection

| Strategy | Requirement | Fallback behavior |
| --- | --- | --- |
| `native` | Browser image decoder accepts the HEIC file and returns plausible primary dimensions. | Auto mode continues if unavailable or rejected. |
| `webcodecs` | Browser exposes WebCodecs and accepts the file's HEVC configuration. | Auto mode continues after decode failure. |
| `wasm` | Caller supplies/registers an adapter; default adapter needs `libheif-js`. | No implicit codec download; absence/failure ends the cascade. |

Do not infer support from a browser name or version alone. Platform codecs, hardware, browser builds, and the input profile can change the outcome. `probeSupport()` is an advisory probe; the successful `decoded.strategy` reports what actually happened.

## File support

Supported primary items are HEVC `hvc1`/`hev1` images and supported HEVC tiled grids. Container `irot`, `imir`, and valid `clap` transforms are planned; native/libheif paths are expected to apply those themselves. Unsupported essential properties cause an error.

The library decodes one primary image. Recognized alpha, depth/disparity, and HDR gain-map auxiliary items can generate warnings but are not composited. It does not decode AVIF/AV1, arbitrary derived-image types, animation, image sequences, Live Photo motion, or all HEIF extensions. Sequence and motion features are not exhaustively detected, so no warning does not establish their absence.

## Color and HDR

`sourceColor` describes parsed ICC or nclx metadata. Reporting metadata does not mean applying the ICC profile. `colorSpace: 'display-p3'` requests a compositing canvas space; native decoding follows browser defaults, and the libheif adapter writes decoded RGBA bytes into the requested canvas. Cross-strategy color equivalence and full wide-gamut/HDR preservation are not guaranteed.

Source bit depth is metadata, not output precision. The default libheif path uses 8-bit RGBA output. Gain-map reconstruction and alpha compositing are outside current scope. Test color-critical workflows against independently rendered references on your target devices.

## Memory and cancellation

The planner caps the primary coded image at 256 million pixels and grid references at 4,096 tiles. These are rejection thresholds, not a memory budget or a guarantee that an accepted file will fit on a device. Tile buffers, decoder state, transforms, and canvases add overhead.

`maxDimension` downsizes the output after decoding/compositing; it does not prevent full-resolution allocations. Enforce input-size and application dimension limits, limit concurrent jobs, and use a worker when blocking the UI is unacceptable.

Cancellation is cooperative. An `AbortSignal` is checked around parts of the pipeline; synchronous work and an in-flight platform/codec operation may finish before cancellation is observed. Terminating an application-owned worker can provide a stronger boundary for expensive tasks.

## What the tests establish

- Unit tests cover parser behavior, bounds checks, HEVC configuration, and deterministic fixture mutations.
- Browser tests exercise the public built package, software decoding, transforms, dimensions, and workers across Playwright engines.
- Native and WebCodecs tests skip when capability probes fail. Headless Linux generally cannot validate platform HEVC decoding.
- The optional `chrome-hevc` project can exercise an installed browser with platform decoding. Released Safari still needs Apple-device testing.
- Committed fixtures include a tiny single-image file and generated asymmetric transform variants. They do not provide a broad real-world Apple grid/device corpus. Private local fixtures improve local coverage but are absent from CI.

A green CI run establishes only the tests that executed. Review skips and the input corpus before making support claims. See [fixture documentation](https://github.com/su-engineering/heic-web/blob/master/test/fixtures/README.md).

## Third-party code

The core library and repository contributions are [MIT licensed](../LICENSE). `libheif-js` is an optional, separately distributed dependency; its package declares LGPL-3.0 and includes upstream codec code with separate notices. The browser's platform decoder is supplied by the browser/OS.

Keep upstream license notices with any redistributed codec assets and review the licenses of the exact build you ship. This repository's MIT license does not relicense libheif or its bundled codecs.
