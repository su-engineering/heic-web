/** Validate every declared package target and the standalone browser build. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const targets = new Set([pkg.main, pkg.types, pkg.unpkg, pkg.jsdelivr]);
function collect(value) {
  if (typeof value === 'string') targets.add(value);
  else for (const child of Object.values(value)) collect(child);
}
collect(pkg.exports);
for (const target of targets) {
  assert.ok(existsSync(target), `Missing declared package target: ${target}`);
}
const context = vm.createContext({});
vm.runInContext(readFileSync(pkg.unpkg, 'utf8'), context);
assert.equal(typeof context.HeicDecoder.decodeHeic, 'function');
assert.equal(typeof context.HeicDecoder.probeSupport, 'function');
const core = await import('../dist/index.js');
const fallback = await import('../dist/wasm.js');
assert.equal(typeof core.decodeHeic, 'function');
assert.equal(typeof core.convertHeic, 'function');
assert.equal(typeof context.HeicDecoder.convertHeic, 'function');
assert.equal(typeof fallback.createWasmAdapter, 'function');
console.log(`Verified ${targets.size} package targets, ESM entry points, and browser global.`);

// Exercise package self-reference and the default optional codec import as a
// real browser bundler sees them, without shipping test assets in dist/.
await build({
  stdin: {
    contents: "export { decodeHeic, convertHeic } from '@su-engineering/heic'; export { wasmDecoder } from '@su-engineering/heic/wasm';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  splitting: true,
  outdir: 'test/.consumer',
});
console.log('Built browser consumer with the default lazy WASM adapter.');
