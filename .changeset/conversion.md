---
'@su-engineering/heic': minor
---

Add JPEG/PNG conversion with decode metadata and automatic bitmap cleanup. Require libheif-js 1.23.2 or newer for the optional fallback, release libheif contexts after decoding, and add a reproducible browser benchmark against heic-to.
