---
"@su-engineering/heic": minor
---

Add EXIF carry-over and embedded-thumbnail decoding.

- `convertHeic` takes `exif: 'none' | 'all' | 'no-location'` (default `'none'`). Copied EXIF has Orientation reset to 1 and the pixel dimensions set to the output size, so viewers do not rotate the upright pixels a second time. `'no-location'` removes the GPS block and zeroes its bytes. `ConvertedImage.exif` reports what was written.
- `decodeHeicThumbnail` decodes the embedded `thmb` thumbnail with WebCodecs, and falls back to a downscaled primary when the file has none or it cannot be decoded.
- `readExif` returns the raw EXIF TIFF block.
- `planItem` and `findThumbnailItemId` are exported for advanced use.
