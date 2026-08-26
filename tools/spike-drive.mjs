import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIR = process.argv[2];
const BROWSER = process.argv[3];
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript' };

const server = createServer((req, res) => {
  try {
    const path = join(DIR, decodeURIComponent(req.url.split('?')[0]));
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: BROWSER || undefined, headless: false });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
await page.goto(`http://127.0.0.1:${port}/spike.html`);

for (const fixture of ['grid.json', 'rot270.json']) {
  console.log(`\n=== ${fixture}`);
  try {
    const result = await page.evaluate((f) => window.spike(f), fixture);
    for (const [k, v] of result.steps) console.log(`  ${k}: ${JSON.stringify(v)}`);
    if (result.dataUrl) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(DIR, fixture.replace('.json', '.png')), Buffer.from(result.dataUrl.split(',')[1], 'base64'));
      console.log(`  wrote ${fixture.replace('.json', '.png')}`);
    }
  } catch (e) { console.log('  THREW', String(e)); }
}
await browser.close();
server.close();
