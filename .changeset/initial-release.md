---
'@su-engineering/heic': minor
---

Initial release.

Browser-first HEIC/HEIF decoder. Parses the ISOBMFF container in JavaScript and
hands the HEVC bitstream to WebCodecs `VideoDecoder`, so HEIC decodes with
hardware acceleration and no WebAssembly on most devices. The libheif wasm
fallback is a separate entry point that is never fetched unless the caller opts
in.

- Three-strategy cascade: `createImageBitmap`, WebCodecs, wasm adapter
- Grid images (the common iPhone case) composited inside the decoder output
  callback, which is what avoids the hardware frame-pool deadlock
- `irot` / `imir` / `clap` applied in `ipma` association order
- 8-bit and 10-bit, sRGB and Display P3 output
- `isHeic()` reads bytes rather than filenames, and distinguishes AVIF
- `probeSupport()` reports capability before anything is downloaded
- Bounds-checked, fuzzed parser with typed errors
- Runs in a Web Worker
