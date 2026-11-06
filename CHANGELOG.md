# Changelog

## 0.3.0

### Minor Changes

- 70a7ed1: Add EXIF carry-over and embedded-thumbnail decoding.

  - `convertHeic` takes `exif: 'none' | 'all' | 'no-location'` (default `'none'`). Copied EXIF has Orientation reset to 1 and the pixel dimensions set to the output size, so viewers do not rotate the upright pixels a second time. `'no-location'` removes the GPS block and zeroes its bytes. `ConvertedImage.exif` reports what was written.
  - `decodeHeicThumbnail` decodes the embedded `thmb` thumbnail with WebCodecs, and falls back to a downscaled primary when the file has none or it cannot be decoded.
  - `readExif` returns the raw EXIF TIFF block.
  - `planItem` and `findThumbnailItemId` are exported for advanced use.

## 0.2.0

### Minor Changes

- f71e02e: Add JPEG/PNG conversion with decode metadata and automatic bitmap cleanup. Require libheif-js 1.23.2 or newer for the optional fallback, release libheif contexts after decoding, and add a reproducible browser benchmark against heic-to.

## 0.1.1

### Patch Changes

- 395b783: Document the initial public release and the automated Changesets release process with npm trusted publishing.

## 0.1.0

Initial public release.

- Browser-first HEIC decoding with native, WebCodecs HEVC, and optional libheif WASM strategies.
- Single-image and tiled-grid planning with container rotation, mirroring, and clean-aperture cropping.
- Typed errors, source metadata, capability probes, and worker-compatible rendering.
- Reproducible build/test setup, public API documentation, and package-entry validation.

See [compatibility limitations](docs/compatibility.md) before deploying.
