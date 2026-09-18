# Contributing

Thanks for helping improve HEIC decoding on the web. We welcome bug fixes, documentation improvements, and regression tests for files the parser or decoder mishandles.

## Local development

Use Node.js 22.12+ and pnpm 9.15.9 (declared in `package.json`). If your Node installation does not include Corepack, install pnpm 9.15.9 using your preferred package manager.

```sh
git clone https://github.com/su-engineering/heic-web.git
cd heic-web
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test:package
pnpm test:unit
```

A source checkout can be used by building it and importing `dist/index.js`, or by installing a tarball created with `pnpm pack --pack-destination /tmp/heic-pack`. The WASM entry point is `dist/wasm.js`; its optional peer dependency must be available in the consuming project.

## Repository map

| Directory | Responsibility |
| --- | --- |
| `src/parser/` | Bounds-checked ISOBMFF/HEIF parsing, item extraction, grid descriptors, and HEVC configuration. |
| `src/plan.ts` | Primary-image planning, dimensions, tile groups, transforms, and feature warnings. |
| `src/decoders/` | Native image decoding and WebCodecs HEVC decoding. |
| `src/render/` | Canvas compositing helpers and container transforms. |
| `wasm/` | Optional libheif adapter and its module declarations. |
| `test/unit/` | Parser tests and deterministic mutation fuzzing. |
| `test/browser/` | Public-API browser tests and worker harnesses. |
| `test/fixtures/` | Committed fixtures; private local corpus is ignored by Git. |
| `tools/` | Test server, package validation, fixture generation, and inspection tools. |

## Browser tests

Build and run `pnpm test:package` first; the harness imports `dist/` and the bundled consumer created by that check.

```sh
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

On a supported Linux distribution, add `--with-deps` to install required system libraries. If a browser fails to launch on an unsupported distribution, run the suite in the same Ubuntu environment as CI rather than changing host libraries blindly.

The default projects are `chromium`, `firefox`, and `webkit`. To test a real Chromium installation with platform HEVC:

```sh
HEIC_CHROME="/path/to/chrome" pnpm test:browser --project=chrome-hevc
```

The environment variable adds that project to the matrix. Setting it does not create HEVC support; capability-dependent tests still skip if the installed browser cannot decode HEVC. Playwright WebKit is not a substitute for testing released Safari on an Apple device.

Run `pnpm test:all` after installing browsers for the combined checks. Record skipped tests as well as failures when reporting coverage.

## Reproducing a bug

Include the input's provenance, browser and OS versions, package version, strategy, and error name/message/context. For `HeicUnsupportedError`, include `attempts`. Explain the expected orientation, dimensions, or colors. A minimal redistributable fixture is preferable to a personal photograph.

For container inspection (Node.js 22.6+ with type stripping):

```sh
pnpm dump path/to/photo.heic --boxes
pnpm validate-corpus path/to/corpus
```

See [fixture documentation](https://github.com/su-engineering/heic-web/blob/master/test/fixtures/README.md) for reference-image generation and manifest provenance. Fixture regeneration requires libheif command-line tools, ImageMagick, and ExifTool; normal builds and tests use committed fixtures and do not need those tools.

## Submitting a change

1. Create a focused branch from `master`.
2. Explain the observable problem and add a regression test for behavior changes.
3. Preserve typed parser errors and bounds/count checks. Avoid DOM dependencies in decode paths.
4. Run typecheck, build, package validation, and unit tests; run relevant browser tests for decoding changes.
5. Update documentation when API behavior or requirements change. For package changes, run `pnpm exec changeset` and add a concise release note.
6. Open a pull request explaining the change, validation, and any coverage gaps.

Do not commit `dist/`, browser reports, `node_modules/`, or the private photo corpus. Only contribute fixtures you have permission to redistribute, without sensitive metadata. Contributions are licensed under the repository's MIT license.

## Community expectations

Be respectful, explain disagreements with evidence, and focus reviews on the work. Do not harass contributors or disclose private information. Report conduct concerns privately to hello@su.engineering. Use the [security policy](SECURITY.md) for vulnerabilities.

## Releases

Package changes use Changesets. Once merged into `master`, the release workflow
creates a version/changelog PR. Merging that PR publishes its new version after
validation using npm trusted publishing. See [the release guide](docs/releasing.md).
