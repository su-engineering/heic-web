# Changelog

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
