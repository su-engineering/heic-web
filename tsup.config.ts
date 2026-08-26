import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', wasm: 'wasm/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    treeshake: true,
    sourcemap: true,
    target: 'es2022',
    // libheif is loaded by the wasm entry point only, and only on demand.
    external: ['libheif-js'],
  },
  {
    // CDN build: <script src="https://unpkg.com/@su-engineering/heic"></script>
    entry: { 'heic.global': 'src/index.ts' },
    format: ['iife'],
    globalName: 'HeicDecoder',
    dts: false,
    clean: false,
    minify: true,
    sourcemap: true,
    target: 'es2022',
  },
]);
