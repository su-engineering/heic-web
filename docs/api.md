# API reference

Import core exports from `@su-engineering/heic`. Import the optional adapter from `@su-engineering/heic/wasm`. The package is ESM; generated declarations are the authoritative TypeScript contract.

## `decodeHeic(input, options?)`

Returns `Promise<DecodedImage>`. Input is a `Blob` (including `File`), `ArrayBuffer`, or `Uint8Array`. The complete input is read and parsed before a decoding strategy is attempted. Do not modify an input buffer during decoding.

| Option | Default | Behavior |
| --- | --- | --- |
| `strategy` | `'auto'` | Try native, then WebCodecs, then a supplied adapter. Set `'native'`, `'webcodecs'`, or `'wasm'` to restrict decoding to that path. |
| `colorSpace` | `'srgb'` | Request `'srgb'` or `'display-p3'` for compositing canvases. Native decoding uses browser defaults. |
| `maxDimension` | Unset | Downscale the final bitmap's longest side to this many pixels; never upscale. Use a positive finite number. Does not constrain peak memory. |
| `signal` | Unset | Cooperatively cancel via `AbortSignal`. Synchronous parsing/codec work and browser operations cannot always be interrupted immediately. |
| `wasmLoader` | Unset | Async function returning a `DecoderAdapter`, called only when the cascade reaches the fallback. A globally registered adapter takes precedence. |

Cancellation example:

```ts
const controller = new AbortController();
const pending = decodeHeic(file, { signal: controller.signal });
// When the user cancels:
controller.abort();
await pending; // Rejects with HeicAbortError at a cancellation checkpoint.
```

### Result and ownership

| Field | Meaning |
| --- | --- |
| `image` | Caller-owned `ImageBitmap`; call `close()` after rendering or otherwise consuming it. |
| `width`, `height` | Returned bitmap size, after optional downscaling. |
| `sourceWidth`, `sourceHeight` | Intrinsic display size after container transforms, before downscaling. |
| `strategy` | Successful path: `'native'`, `'webcodecs'`, or `'wasm'`. |
| `bitDepth` | Source bit depth from container/codec metadata; not a promise of output precision. |
| `isGrid`, `tileCount` | Whether the primary image is tiled, and its planned tile count. |
| `sourceColor` | `null`, ICC bytes (`{ type: 'icc', profile }`), or nclx primaries/transfer/matrix/full-range metadata. |
| `transformsApplied` | Counter-clockwise rotation, mirror direction, and whether clean-aperture cropping was applied. |
| `warnings` | Structured `{ code, message }` diagnostics for recognized unsupported features and unusual layouts. |

The decoder returns pixels, not a new HEIC file. EXIF and other source metadata are not serialized into a new output file. Warnings are advisory and do not enumerate every unsupported feature.

## `isHeic(input)`

Returns `Promise<IsHeicResult>` with `isHeic: boolean` and optional `brand`, `primaryItemType`, and `coding` (`'hevc'`, `'av1'`, or `'unknown'`). Inspects at most the first 64 KiB, including for a `Blob`.

A malformed, ambiguous, or incomplete prefix can yield limited information. A positive identification does not guarantee a valid file or successful decode. AVIF shares HEIF brands; an AV1 result should be routed elsewhere.

## `probeSupport()`

Returns `Promise<SupportReport>`:

```ts
{
  native: boolean,
  webcodecs: boolean,
  hevcCodecStrings: string[],
  recommended: 'native' | 'webcodecs' | 'wasm' | 'none',
}
```

The current implementation recommends `'wasm'` when both browser paths are unavailable, even when no adapter is installed. It does not load libheif. It tests a small inline native image and queries accepted WebCodecs configurations; it does not certify every file, profile, or output color space.

## Errors

`HeicError` extends `Error` and provides `context` (available brand, item ID/type, strategy, codec, offset, or box). Subclasses:

| Error | Meaning |
| --- | --- |
| `HeicParseError` | Malformed/truncated input or a container structure the parser refuses. |
| `HeicUnsupportedError` | Unsupported image features, resource limits, or no successful strategy; includes `attempts`. |
| `HeicDecodeError` | A decoder or rendering operation failed. |
| `HeicAbortError` | Cancellation detected. |

Auto mode collects strategy failures and can end with `HeicUnsupportedError` even when a decoder failed on corrupt data. Forced paths may expose a more direct decode error. Custom adapter/loader and platform errors can also propagate; always handle an unknown error in application code.

## WASM adapters

`wasmDecoder` is a reusable default adapter. `createWasmAdapter(options?)` creates an independent instance, loading and normalizing a libheif module once on first use.

```ts
import { createWasmAdapter } from '@su-engineering/heic/wasm';

const adapter = createWasmAdapter({
  loadLibheif: () => import('/vendor/libheif-bundle.mjs'),
});
await decodeHeic(file, { wasmLoader: async () => adapter });
```

The URL above is an application-provided, self-hosted ESM WASM bundle, not an asset shipped by this package. For direct browser use, serve compatible adapter assets and their relative imports too. The default loader uses `libheif-js/wasm-bundle.js`; bare specifiers require a bundler or suitable import mapping.

A custom `DecoderAdapter` has `name`, `appliesTransforms`, and an async `decode(request)` method. The request contains the complete `Uint8Array` data, requested color space, and optional signal. Return `{ image, width, height }`, where `image` is an `ImageBitmap` or `OffscreenCanvas`. Set `appliesTransforms: true` only if the pixels already include container `irot`, `imir`, and `clap`; otherwise the core applies them. Returned pixel resources are handed to the core; do not reuse them after returning.

`registerDecoderAdapter(adapter)` sets a realm-wide fallback. Pass `undefined` to clear it. `getRegisteredAdapter()` retrieves it. Registration takes precedence over per-call loaders; prefer per-call loading for independent consumers.

## Parser and inspection exports

These functions do not decode pixels and accept `ArrayBuffer`/`Uint8Array` where a buffer is required. Their structures are exposed for diagnostics and advanced integrations; consult generated declarations before depending on them.

| Export | Purpose |
| --- | --- |
| `parseHeif` | Parse the file into `HeifFile`: brands, primary item, items, locations, properties, and references. |
| `propertiesForItem`, `findProperty` | Resolve associated properties and find a typed property. |
| `readItemData` | Extract an item's payload from its extents. |
| `readGrid`, `parseGridPayload` | Read grid references and grid descriptors. |
| `planDecode` | Resolve an `ImagePlan` with tiles, groups, display size, transforms, and warnings. |
| `parseHvcC`, `hvccToCodecString` | Parse HEVC configuration and produce a WebCodecs codec string. |
| `hvccToAnnexBPrologue`, `lengthPrefixedToAnnexB` | Prepare HEVC NAL data for Annex B decoding. |

Exported types include `BinaryInput`, `IsHeicResult`, `DecodeOptions`, `DecodedImage`, `Strategy`, `OutputColorSpace`, `SourceColor`, `TransformsApplied`, `HeicWarning`, `SupportReport`, `HeicErrorContext`, `DecoderAdapter`, `AdapterRequest`, `AdapterResult`, `HeifFile`, `ItemInfo`, `ItemLocation`, `ItemProperty`, `ItemProperties`, `ItemReferences`, `GridDescriptor`, `HvcC`, `ImagePlan`, `PlannedTile`, `TileGroup`, and `TransformOp`. The WASM entry point additionally exports `WasmAdapterOptions`.
