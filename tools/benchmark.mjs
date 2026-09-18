/** Local browser benchmark. Photo bytes never leave the loopback server. */
import { build, stop } from 'esbuild';
import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cpus, platform, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

let source = { commit: null, dirty: null };
try {
  source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 };
} catch { /* The harness also works in a source snapshot without .git. */ }

const args = process.argv.slice(2).filter(arg => arg !== '--');
const settings = { browser: 'chromium', iterations: 5, cold: 3, output: 'benchmark-results/latest.json', type: 'image/jpeg', quality: 0.92 };
const files = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    if (!(key in settings) || !args[i + 1]) throw new Error(`Unknown or missing option: ${arg}`);
    settings[key] = typeof settings[key] === 'number' ? Number(args[++i]) : args[++i];
  } else files.push(resolve(arg));
}
if (!files.length) files.push(resolve('test/fixtures/generated/asym-base.heic'), resolve('test/fixtures/generated/asym-irot-90.heic'));
if (!['chromium', 'firefox', 'webkit'].includes(settings.browser) || !['image/jpeg', 'image/png'].includes(settings.type)
  || !Number.isInteger(settings.iterations) || settings.iterations < 1 || !Number.isInteger(settings.cold) || settings.cold < 1
  || !Number.isFinite(settings.quality) || settings.quality < 0 || settings.quality > 1) throw new Error('Invalid benchmark settings');
const fixtureBytes = files.map(file => readFileSync(file));
const outdir = resolve('test/.benchmark');
mkdirSync(outdir, { recursive: true });
for (const [name, contents] of Object.entries({
  ours: `import { convertHeic } from './dist/index.js'; import { wasmDecoder } from './dist/wasm.js';
    export async function convert(blob, options, strategy) { return convertHeic(blob, { ...options, strategy, wasmLoader: async () => wasmDecoder }); }`,
  competitor: `import { heicTo } from 'heic-to';
    export async function convert(blob, options) { return { blob: await heicTo({ blob, ...options }), strategy: 'libheif-js' }; }`,
})) {
  await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: `${name}.js` },
    bundle: true, splitting: true, format: 'esm', platform: 'browser', minify: true,
    outdir: join(outdir, name), entryNames: 'entry' });
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>HEIC benchmark</title>');
  const fixture = /^\/fixture\/(\d+)$/.exec(url.pathname);
  if (fixture && fixtureBytes[Number(fixture[1])]) return res.writeHead(200, { 'content-type': 'image/heic' }).end(fixtureBytes[Number(fixture[1])]);
  if (/^\/assets\/(ours|competitor)\/[a-zA-Z0-9_-]+\.js$/.test(url.pathname)) {
    try { return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(outdir, url.pathname.slice('/assets/'.length)))); }
    catch { /* 404 */ }
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const variants = [{ name: 'ours-auto', entry: 'ours', strategy: 'auto' },
  { name: 'ours-wasm', entry: 'ours', strategy: 'wasm' }, { name: 'heic-to', entry: 'competitor' }];
const rows = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const summarize = samples => {
  const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: percentile(sorted, 0.95), samples };
};
async function prepare(context, fixtureIndex) {
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(origin);
  await page.evaluate(async index => { window.input = await (await fetch(`/fixture/${index}`)).blob(); }, fixtureIndex);
  return page;
}
async function run(page, variant) {
  const timeout = setTimeout(() => { void page.close().catch(() => {}); }, 120000);
  try {
    return await page.evaluate(async ({ variant, options }) => {
      const started = performance.now();
      const api = await import(`/assets/${variant.entry}/entry.js`);
      const result = await api.convert(window.input, options, variant.strategy);
      const ms = performance.now() - started;
      // Validate every output outside the measured region, then release it.
      if (result.blob.type !== options.type || !result.blob.size) throw new Error('Invalid encoded output');
      const bitmap = await createImageBitmap(result.blob);
      const canvas = new OffscreenCanvas(64, 64);
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, 64, 64);
      const pixels = Array.from(ctx.getImageData(0, 0, 64, 64).data);
      const summary = { ms, strategy: result.strategy, width: bitmap.width, height: bitmap.height,
        outputBytes: result.blob.size, pixels,
        loadedJsBytes: performance.getEntriesByType('resource').filter(e => e.name.includes('/assets/')).reduce((sum, e) => sum + e.decodedBodySize, 0) };
      bitmap.close(); canvas.width = 0; canvas.height = 0;
      return summary;
    }, { variant, options: { type: settings.type, quality: settings.quality } });
  } finally { clearTimeout(timeout); }
}
try {
  browser = await ({ chromium, firefox, webkit })[settings.browser].launch({
    ...(settings.browser === 'chromium' && process.env.HEIC_CHROME ? { executablePath: process.env.HEIC_CHROME } : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage(); await page.goto(origin);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await context.close();
  for (let index = 0; index < files.length; index++) {
    const data = new Map(variants.map(v => [v.name, { cold: [], warm: [] }]));
    // Rotate execution order between rounds to reduce systematic order bias.
    for (let round = 0; round < settings.cold; round++) {
      for (let offset = 0; offset < variants.length; offset++) {
        const variant = variants[(round + offset) % variants.length];
        const context = await browser.newContext();
        try { data.get(variant.name).cold.push(await run(await prepare(context, index), variant)); }
        finally { await context.close(); }
      }
    }
    const warmed = new Map();
    try {
      for (const variant of variants) {
        const context = await browser.newContext();
        warmed.set(variant.name, { context, page: await prepare(context, index) });
        await run(warmed.get(variant.name).page, variant); // Untimed warm-up (sample discarded).
      }
      for (let round = 0; round < settings.iterations; round++) {
        for (let offset = 0; offset < variants.length; offset++) {
          const variant = variants[(round + offset) % variants.length];
          data.get(variant.name).warm.push(await run(warmed.get(variant.name).page, variant));
        }
      }
    } finally { for (const { context } of warmed.values()) await context.close(); }
    const reference = data.get('heic-to').warm[0];
    const referencePixels = [...reference.pixels];
    for (const variant of variants) {
      const samples = data.get(variant.name);
      for (const sample of [...samples.cold, ...samples.warm]) {
        if (sample.width !== reference.width || sample.height !== reference.height) throw new Error(`Dimension mismatch: ${variant.name}`);
        let diff = 0;
        for (let p = 0; p < sample.pixels.length; p++) if (p % 4 !== 3) diff += Math.abs(sample.pixels[p] - referencePixels[p]);
        sample.thumbnailRgbMadVsHeicTo = diff / (64 * 64 * 3);
        delete sample.pixels;
      }
      const row = { fixture: `fixture-${index + 1}`, inputBytes: fixtureBytes[index].length, variant: variant.name,
        cold: summarize(samples.cold), warm: summarize(samples.warm) };
      rows.push(row);
      console.log(`${row.fixture} ${variant.name}: cold ${row.cold.medianMs.toFixed(1)} ms; warm ${row.warm.medianMs.toFixed(1)} ms; ${samples.warm[0].strategy}; ${reference.width}x${reference.height}`);
    }
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const dependency = name => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
  const core = readFileSync('dist/heic.global.js');
  const report = { generatedAt: new Date().toISOString(), source, versions: { ours: pkg.version, libheifJs: dependency('libheif-js'), heicTo: dependency('heic-to') },
    environment: { browser: settings.browser, browserVersion: browser.version(), userAgent, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    settings, coreBundle: { rawBytes: core.length, gzipBytes: gzipSync(core).length, sha256: createHash('sha256').update(core).digest('hex') }, rows,
    methodology: 'Full-resolution conversion. Input fetch excluded. Cold: fresh context including module loading and codec initialization on local loopback. Warm: one discarded conversion, then interleaved repeats including cached dynamic import. Output inspection excluded. No network throttling, memory or hardware-HEVC claims. Filenames and photo bytes omitted from report.' };
  mkdirSync(resolve(settings.output, '..'), { recursive: true });
  writeFileSync(settings.output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${settings.output}`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
  stop();
  console.log('Benchmark complete; browser, server, and bundler stopped.');
}
