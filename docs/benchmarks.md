# Benchmarking against heic-to

Compare full-resolution JPEG/PNG conversion with **heic-to 1.5.2**, using identical input bytes, MIME type, and JPEG quality. Photos are served only on `127.0.0.1`, never uploaded. The competitor is a pinned development dependency and is not shipped in the package.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox
pnpm benchmark

# Use your own consented photos (quote paths containing spaces):
pnpm benchmark -- /path/to/one.heic /path/to/two.heic \
  --iterations 10 --cold 5 --output benchmark-results/photos.json

pnpm benchmark -- /path/to/one.heic --browser firefox
pnpm benchmark -- /path/to/one.heic --type image/png
```

Options: `--browser chromium|firefox|webkit`, `--iterations` (warm samples, default 5), `--cold` (first-use samples, default 3), `--type` (default `image/jpeg`), `--quality` (default `0.92`), and `--output`. With no files, two small committed synthetic fixtures smoke-test the harness; they are not representative phone-photo performance measurements.

For installed Chromium with platform HEVC, set `HEIC_CHROME=/path/to/browser`. This does not install codecs or guarantee hardware decoding. WebKit needs platform dependencies and does not represent released Safari. Close other CPU-intensive tasks and run benchmarks separately from tests.

## Methodology

| Variant | Decode behavior |
| --- | --- |
| `ours-auto` | Native → WebCodecs → lazy libheif WASM fallback. |
| `ours-wasm` | Force the libheif-js 1.23.2 WASM fallback. |
| `heic-to` | Standard `heicTo` API with its bundled libheif build. |

- **Cold:** fresh context for every conversion; time module import, local bundle loading/parsing, codec initialization, decoding, and encoding. The browser process is reused. Loopback delivery is unthrottled and is not a mobile-network simulation.
- **Warm:** separate context per variant, one discarded warm-up, then interleaved sequential conversions with cached modules/codec. Variant order rotates between rounds.
- **Input fetch:** excluded for all variants. Neither side resizes. Output inspection is outside timing.
- **Validation:** every Blob must have the requested MIME type, nonzero size, and decodable pixels. Dimensions must match heic-to. A 64×64 thumbnail RGB mean absolute difference against heic-to is diagnostic, not independent proof of correct pixels or color.
- **Report:** raw samples, median/p95, actual strategy, dimensions, encoded bytes, loaded uncompressed JS bytes, browser/OS/CPU and dependency versions, and raw/gzip standalone core size. Small-sample p95 is usually the maximum, not a reliable population percentile.

Generated bundles/reports are ignored by Git. Reports use anonymous fixture IDs and omit filenames, source paths, and photo bytes. Keep private photos outside committed fixtures.

## Initial local measurements

September 18, 2026 conversion candidate, Linux x64, AMD Ryzen 7 PRO 8840U, Playwright Chromium 153.0.8010.12. Two consented iPhone photos, each 2268×4032 with a 5×8 tile grid, converted at full resolution to JPEG quality 0.92. Five cold samples and ten warm samples per variant; times below are medians. No other test suite ran during these measurements.

| Input | ours-auto cold | heic-to cold | ours-auto warm | heic-to warm |
| --- | ---: | ---: | ---: | ---: |
| Photo 1 | 475 ms | 1,243 ms | 361 ms | 722 ms |
| Photo 2 | 587 ms | 1,503 ms | 471 ms | 848 ms |

Both `ours-auto` runs used **WASM**, not native/WebCodecs. Forced WASM warm medians were 362/475 ms. All outputs matched full-resolution dimensions; their 64×64 RGB thumbnail MAD against heic-to was zero in this browser. This is a narrow local result using private inputs, not an independently reproducible public corpus or a general performance guarantee. The harness is reproducible with the committed fixtures or your own photos.

An isolated Firefox 155 run on the same machine used three cold and five warm samples per variant, with the same photos and JPEG settings:

| Input | ours-auto cold | heic-to cold | ours-auto warm | heic-to warm |
| --- | ---: | ---: | ---: | ---: |
| Photo 1 | 493 ms | 1,076 ms | 402 ms | 894 ms |
| Photo 2 | 607 ms | 1,350 ms | 518 ms | 1,117 ms |

These auto runs also used WASM; output dimensions matched and thumbnail RGB MAD was zero. Raw/gzip core size is reported separately from codec assets. In this bundled harness, our WASM path loaded approximately 2.02 MB of uncompressed JavaScript versus 3.00 MB for heic-to; production transfer sizes depend on bundling and compression.

## Interpretation

Our fallback stays unloaded when native or WebCodecs succeeds. `ours-auto` reports the actual successful strategy so a fallback result cannot be presented as a native/hardware speedup. Without platform HEVC, this compares software WASM against heic-to's bundled software implementation.

[heic-to 1.5.2](https://github.com/hoppergee/heic-to) documents libheif 1.22.2; this candidate tests libheif-js 1.23.2. Results compare complete package versions, including different codec builds and encoders; they do not isolate wrapper overhead.

Do not compare npm unpacked sizes as initial download sizes. `loadedJsBytes` is uncompressed local delivery, not gzip transfer cost. Core size excludes the optional codec. This script does not measure peak memory, UI blocking, constrained-network performance, or establish hardware acceleration. Two photos on one machine do not prove universal performance or compatibility. Test representative tiled, rotated, high-resolution, and color-diverse photos on target devices before making broad claims.
