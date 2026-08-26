import { readdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export interface FixtureExpectation {
  width: number;
  height: number;
  isGrid: boolean;
  tileCount: number;
  gridColumns: number;
  gridRows: number;
  bitDepth: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: 'none' | 'horizontal' | 'vertical';
}

export interface Fixture {
  name: string;
  /** URL the harness fetches it from. */
  url: string;
  referenceUrl: string | undefined;
  device: string;
  expect: FixtureExpectation;
  features: { alpha?: boolean; depth?: boolean; gainMap?: boolean };
}

/**
 * Fixtures come from three directories:
 *   test/fixtures            committed, hand-placed
 *   test/fixtures/generated  committed, built by tools/make-fixtures.sh
 *   test/fixtures/local      gitignored, a personal photo corpus
 *
 * All are loaded when present, so a local run is as thorough as possible while
 * CI still has real coverage without anyone committing their photo library.
 */
export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const dir of ['test/fixtures', 'test/fixtures/generated', 'test/fixtures/local']) {
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      { device: string; expect: FixtureExpectation; features: Fixture['features']; reference: string }
    >;
    for (const [name, entry] of Object.entries(manifest)) {
      const referencePath = join(dir, entry.reference);
      out.push({
        name,
        url: `/${dir}/${name}`,
        referenceUrl: existsSync(referencePath) ? `/${dir}/${entry.reference}` : undefined,
        device: entry.device,
        expect: entry.expect,
        features: entry.features ?? {},
      });
    }
  }
  return out;
}

export function gridFixtures(): Fixture[] {
  return loadFixtures().filter((f) => f.expect.isGrid);
}

/** Loads the harness page and waits for the built bundle to be importable. */
export async function openHarness(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/test/browser/harness.html');
  await page.waitForFunction(() => (window as { ready?: boolean }).ready === true, undefined, {
    timeout: 15_000,
  });
  if (errors.length > 0) throw new Error(`harness failed to load: ${errors.join('; ')}`);
}

/** Whether this browser can run the WebCodecs strategy at all. */
export async function hasWebCodecsHevc(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const report = await (window as never as { heic: { probeSupport(): Promise<{ webcodecs: boolean }> } }).heic.probeSupport();
    return report.webcodecs;
  });
}

export async function hasNative(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const report = await (window as never as { heic: { probeSupport(): Promise<{ native: boolean }> } }).heic.probeSupport();
    return report.native;
  });
}
