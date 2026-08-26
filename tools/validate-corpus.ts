/**
 * Cross-checks the parser against libheif's `heif-info` over a directory of real
 * files. This is not part of the shipped test suite — it is the tool that says
 * whether the container parsing is right in the first place, run against a corpus
 * far larger than anything we would commit.
 *
 * Usage: node --experimental-strip-types tools/validate-corpus.ts <dir> [...dirs]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { detectFromBuffer } from '../src/parser/detect.ts';
import { readGrid } from '../src/parser/grid.ts';
import { hvccBitDepth, hvccToCodecString } from '../src/parser/hvcc.ts';
import { findProperty, parseHeif, propertiesForItem } from '../src/parser/meta.ts';

interface Truth {
  width: number;
  height: number;
  columns?: number;
  rows?: number;
  tileWidth?: number;
  tileHeight?: number;
  bitDepth: number;
  angle: number;
}

function heifInfo(path: string): Truth | undefined {
  let out: string;
  try {
    out = execFileSync('heif-info', [path], { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const primary = /image: (\d+)x(\d+) \(id=\d+\), primary/.exec(out);
  if (!primary) return undefined;
  const tiles = /tiles: (\d+)x(\d+), tile size: (\d+)x(\d+)/.exec(out);
  const depth = /bit depth: (\d+)/.exec(out);
  const angle = /angle \(ccw\): (\d+)/.exec(out);
  const truth: Truth = {
    width: Number(primary[1]),
    height: Number(primary[2]),
    bitDepth: depth ? Number(depth[1]) : 8,
    angle: angle ? Number(angle[1]) : 0,
  };
  if (tiles) {
    truth.columns = Number(tiles[1]);
    truth.rows = Number(tiles[2]);
    truth.tileWidth = Number(tiles[3]);
    truth.tileHeight = Number(tiles[4]);
  }
  return truth;
}

function check(path: string): { ok: boolean; label: string; notes: string[] } {
  const notes: string[] = [];
  const truth = heifInfo(path);
  if (!truth) return { ok: true, label: 'SKIP', notes: ['heif-info could not read it'] };

  const bytes = new Uint8Array(readFileSync(path));
  const detection = detectFromBuffer(bytes.subarray(0, 65_536));
  if (!detection.isHeic) notes.push(`isHeic=false (brand=${detection.brand})`);

  const file = parseHeif(bytes);
  const props = propertiesForItem(file, file.primaryItemId);
  const info = file.items.get(file.primaryItemId);
  const isGrid = info?.itemType === 'grid';
  const grid = isGrid ? readGrid(file, file.primaryItemId) : undefined;

  const ispe = findProperty(props, 'ispe');
  const irot = findProperty(props, 'irot');
  const angle = irot?.angle ?? 0;

  // heif-info reports dimensions after applying irot; ispe is the coded size.
  let width = ispe?.width ?? grid?.outputWidth ?? 0;
  let height = ispe?.height ?? grid?.outputHeight ?? 0;
  if (angle === 90 || angle === 270) [width, height] = [height, width];

  if (width !== truth.width || height !== truth.height) {
    notes.push(`dims ${width}x${height} != heif-info ${truth.width}x${truth.height}`);
  }
  if (angle !== truth.angle) notes.push(`angle ${angle} != ${truth.angle}`);

  if (truth.columns !== undefined) {
    if (!grid) notes.push('heif-info says grid, we say single-item');
    else {
      // heif-info reports the tile layout in display orientation, so a 90/270
      // rotation swaps its columns and rows relative to the coded grid.
      const rotated = angle === 90 || angle === 270;
      const truthColumns = rotated ? truth.rows! : truth.columns;
      const truthRows = rotated ? truth.columns : truth.rows!;
      if (grid.columns !== truthColumns || grid.rows !== truthRows) {
        notes.push(`grid ${grid.columns}x${grid.rows} != ${truthColumns}x${truthRows}`);
      }
      const tileIspe = findProperty(propertiesForItem(file, grid.tileItemIds[0]!), 'ispe');
      const truthTileW = rotated ? truth.tileHeight : truth.tileWidth;
      const truthTileH = rotated ? truth.tileWidth : truth.tileHeight;
      if (tileIspe && (tileIspe.width !== truthTileW || tileIspe.height !== truthTileH)) {
        notes.push(`tile ${tileIspe.width}x${tileIspe.height} != ${truthTileW}x${truthTileH}`);
      }
      // Every tile must be readable; a bad iloc shows up here and nowhere else.
      let totalTileBytes = 0;
      for (const id of grid.tileItemIds) {
        const props = propertiesForItem(file, id);
        if (!findProperty(props, 'hvcC')) notes.push(`tile ${id} has no hvcC`);
        totalTileBytes += readItemBytes(file, id);
      }
      if (totalTileBytes === 0) notes.push('tiles read as zero bytes');
    }
  } else if (grid) {
    notes.push('we say grid, heif-info says single-item');
  }

  const codedId = grid ? grid.tileItemIds[0]! : file.primaryItemId;
  const hvcc = findProperty(propertiesForItem(file, codedId), 'hvcC')?.hvcc;
  if (!hvcc) notes.push('no hvcC on the coded item');
  else {
    const pixi = findProperty(props, 'pixi');
    const depth = pixi?.bitsPerChannel[0] ?? hvccBitDepth(hvcc);
    if (depth !== truth.bitDepth) notes.push(`bitDepth ${depth} != ${truth.bitDepth}`);
  }

  const label = grid
    ? `${truth.width}x${truth.height} grid ${grid.columns}x${grid.rows} d${truth.bitDepth} r${angle} ${hvcc ? hvccToCodecString(hvcc) : '?'}`
    : `${truth.width}x${truth.height} single d${truth.bitDepth} r${angle} ${hvcc ? hvccToCodecString(hvcc) : '?'}`;

  return { ok: notes.length === 0, label, notes };
}

function readItemBytes(file: ReturnType<typeof parseHeif>, itemId: number): number {
  const { readItemData } = require_meta();
  return readItemData(file, itemId).byteLength;
}
function require_meta(): typeof import('../src/parser/meta.ts') {
  return meta;
}
import * as meta from '../src/parser/meta.ts';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: validate-corpus.ts <dir> [...dirs]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
let skip = 0;
for (const dir of dirs) {
  const entries = statSync(dir).isDirectory()
    ? readdirSync(dir)
        .filter((n) => ['.heic', '.heif'].includes(extname(n).toLowerCase()))
        .map((n) => join(dir, n))
    : [dir];

  for (const path of entries.sort()) {
    let result: ReturnType<typeof check>;
    try {
      result = check(path);
    } catch (error) {
      result = { ok: false, label: 'THREW', notes: [String(error)] };
    }
    const name = path.split('/').pop()!;
    if (result.label === 'SKIP') {
      skip++;
      continue;
    }
    if (result.ok) {
      pass++;
      console.log(`  ok   ${name.padEnd(20)} ${result.label}`);
    } else {
      fail++;
      console.log(`  FAIL ${name.padEnd(20)} ${result.label}`);
      for (const note of result.notes) console.log(`         ${note}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
