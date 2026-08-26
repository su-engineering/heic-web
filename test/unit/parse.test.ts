import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeicParseError, HeicUnsupportedError } from '../../src/errors.ts';
import { detectFromBuffer } from '../../src/parser/detect.ts';
import { planDecode } from '../../src/plan.ts';
import { findProperty, parseHeif, propertiesForItem, readItemData } from '../../src/parser/meta.ts';
import { readGrid } from '../../src/parser/grid.ts';

interface ManifestEntry {
  expect: {
    width: number;
    height: number;
    isGrid: boolean;
    tileCount: number;
    gridColumns: number;
    gridRows: number;
    bitDepth: number;
    rotation: 0 | 90 | 180 | 270;
    mirrored: 'none' | 'horizontal' | 'vertical';
  };
}

/** Every fixture directory that exists, so a local run covers the photo corpus too. */
function fixtures(): { path: string; name: string; entry: ManifestEntry }[] {
  const out: { path: string; name: string; entry: ManifestEntry }[] = [];
  for (const dir of ['test/fixtures', 'test/fixtures/generated', 'test/fixtures/local']) {
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestEntry>;
    for (const [name, entry] of Object.entries(manifest)) {
      out.push({ path: join(dir, name), name, entry });
    }
  }
  return out;
}

describe('planDecode against real files', () => {
  const all = fixtures();
  it('has fixtures to test', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const { path, name, entry } of all) {
    it(`plans ${name}`, () => {
      const plan = planDecode(new Uint8Array(readFileSync(path)));

      // Display dimensions must match what libheif reported for the same file.
      expect(plan.displayWidth).toBe(entry.expect.width);
      expect(plan.displayHeight).toBe(entry.expect.height);
      expect(plan.isGrid).toBe(entry.expect.isGrid);
      expect(plan.tiles.length).toBe(entry.expect.tileCount);
      expect(plan.bitDepth).toBe(entry.expect.bitDepth);

      // Tiles are almost always uniform; the whole point of grouping is to use
      // one decoder rather than one per tile.
      expect(plan.tileGroups.length).toBe(1);
      expect(plan.tileGroups[0]!.tileIndices.length).toBe(plan.tiles.length);

      // Every tile's payload must actually be readable.
      for (const tile of plan.tiles) {
        expect(readItemData(plan.file, tile.itemId).byteLength).toBeGreaterThan(0);
      }
    });
  }

  it('lays grid tiles out in raster order', () => {
    const gridFixture = all.find((f) => f.entry.expect.isGrid);
    if (!gridFixture) return;

    const plan = planDecode(new Uint8Array(readFileSync(gridFixture.path)));
    const columns = gridFixture.entry.expect.gridColumns;
    const tileWidth = plan.tiles[0]!.width;
    const tileHeight = plan.tiles[0]!.height;

    plan.tiles.forEach((tile, index) => {
      expect(tile.x).toBe((index % columns) * tileWidth);
      expect(tile.y).toBe(Math.floor(index / columns) * tileHeight);
    });

    // Tiles are allowed to overhang; the canvas is the coded size and clips them.
    const lastTile = plan.tiles[plan.tiles.length - 1]!;
    expect(lastTile.x + lastTile.width).toBeGreaterThanOrEqual(plan.codedWidth);
    expect(lastTile.y + lastTile.height).toBeGreaterThanOrEqual(plan.codedHeight);
  });
});

describe('detection', () => {
  it('identifies HEIC from bytes, not from an extension', () => {
    for (const { path, name } of fixtures()) {
      if (name.endsWith('.avif')) continue;
      const result = detectFromBuffer(new Uint8Array(readFileSync(path)).subarray(0, 65_536));
      expect(result.isHeic, name).toBe(true);
      expect(result.coding, name).toBe('hevc');
    }
  });

  it('declines an AVIF but says it is AV1-coded', () => {
    const path = 'test/fixtures/generated/sample.avif';
    if (!existsSync(path)) return;
    const result = detectFromBuffer(new Uint8Array(readFileSync(path)));
    expect(result.isHeic).toBe(false);
    expect(result.coding).toBe('av1');
    expect(result.primaryItemType).toBe('av01');
  });

  it('declines non-ISOBMFF input without throwing', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectFromBuffer(png).isHeic).toBe(false);
    expect(detectFromBuffer(new Uint8Array(0)).isHeic).toBe(false);
    expect(detectFromBuffer(new Uint8Array(3)).isHeic).toBe(false);
  });

  it('works on a 64 KB prefix, which is all isHeic() reads from a Blob', () => {
    const grid = fixtures().find((f) => f.entry.expect.isGrid);
    if (!grid) return;
    const full = new Uint8Array(readFileSync(grid.path));
    expect(full.byteLength).toBeGreaterThan(65_536);
    expect(detectFromBuffer(full.subarray(0, 65_536)).isHeic).toBe(true);
  });
});

describe('transform properties', () => {
  const cases = [
    ['asym-irot-90.heic', 90],
    ['asym-irot-180.heic', 180],
    ['asym-irot-270.heic', 270],
  ] as const;

  for (const [name, angle] of cases) {
    it(`reads irot ${angle}`, () => {
      const path = join('test/fixtures/generated', name);
      if (!existsSync(path)) return;
      const plan = planDecode(new Uint8Array(readFileSync(path)));
      expect(plan.transforms).toEqual([{ kind: 'rotate', angle }]);
      // 90 and 270 swap the display dimensions relative to the coded image.
      if (angle === 180) {
        expect(plan.displayWidth).toBe(plan.codedWidth);
      } else {
        expect(plan.displayWidth).toBe(plan.codedHeight);
      }
    });
  }

  it('reads imir on both axes', () => {
    for (const [name, axis] of [['asym-imir-0.heic', 0], ['asym-imir-1.heic', 1]] as const) {
      const path = join('test/fixtures/generated', name);
      if (!existsSync(path)) continue;
      const plan = planDecode(new Uint8Array(readFileSync(path)));
      expect(plan.transforms).toEqual([{ kind: 'mirror', axis }]);
      // A mirror never changes the dimensions.
      expect(plan.displayWidth).toBe(plan.codedWidth);
      expect(plan.displayHeight).toBe(plan.codedHeight);
    }
  });

  it('resolves clap from its centre-relative rationals', () => {
    const path = 'test/fixtures/libheif-2x2-single.heic';
    if (!existsSync(path)) return;
    // This file codes a 64x64 frame and crops it to 2x2 via clap.
    const plan = planDecode(new Uint8Array(readFileSync(path)));
    expect(plan.codedWidth).toBe(64);
    expect(plan.codedHeight).toBe(64);
    expect(plan.transforms).toEqual([
      { kind: 'crop', width: 2, height: 2, offsetX: 0, offsetY: 0 },
    ]);
    expect(plan.displayWidth).toBe(2);
    expect(plan.displayHeight).toBe(2);
  });

  it('preserves ipma association order, which is what transform order depends on', () => {
    const path = 'test/fixtures/generated/asym-irot-90.heic';
    if (!existsSync(path)) return;
    const file = parseHeif(new Uint8Array(readFileSync(path)));
    const properties = propertiesForItem(file, file.primaryItemId);
    // The injected irot was appended last, and must come back last.
    expect(properties[properties.length - 1]).toMatchObject({ type: 'irot', angle: 90 });
  });
});

describe('refusals', () => {
  it('rejects an AVIF at plan time with a message naming the item type', () => {
    const path = 'test/fixtures/generated/sample.avif';
    if (!existsSync(path)) return;
    expect(() => planDecode(new Uint8Array(readFileSync(path)))).toThrow(HeicUnsupportedError);
    expect(() => planDecode(new Uint8Array(readFileSync(path)))).toThrow(/av01/);
  });

  it('rejects a file with no ftyp', () => {
    expect(() => parseHeif(new Uint8Array(64))).toThrow(HeicParseError);
  });

  it('rejects a grid whose rows x columns disagrees with its dimg list', () => {
    const grid = fixtures().find((f) => f.entry.expect.isGrid);
    if (!grid) return;
    const file = parseHeif(new Uint8Array(readFileSync(grid.path)));
    const tiles = file.references.get('dimg')!.get(file.primaryItemId)!;
    // Drop a tile: the declared geometry no longer matches, and continuing would
    // silently shift every tile after the gap.
    tiles.pop();
    expect(() => readGrid(file, file.primaryItemId)).toThrow(/tiles but 'dimg' lists/);
  });
});

describe('feature warnings', () => {
  it('reports a gain map rather than failing', () => {
    const withGainMap = fixtures().find((f) => f.name === 'IMG_3031.heic');
    if (!withGainMap) return;
    const plan = planDecode(new Uint8Array(readFileSync(withGainMap.path)));
    expect(plan.warnings.map((w) => w.code)).toContain('gain-map-ignored');
    // Warned about, but still decodable: the primary image is unaffected.
    expect(plan.tiles.length).toBe(48);
  });

  it('does not warn twice about the same ignored feature', () => {
    for (const { path } of fixtures()) {
      const plan = planDecode(new Uint8Array(readFileSync(path)));
      const codes = plan.warnings.map((w) => w.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});
