/**
 * Box-tree inspection tool.
 *
 * Usage:
 *   node --experimental-strip-types tools/dump.ts <file.heic> [--json] [--boxes]
 *
 * Prints what the parser understood about a file. `--boxes` adds the raw box
 * tree, which is the fastest way to see why a file that should work does not.
 */
import { readFileSync } from 'node:fs';
import { childBoxes, walkBoxes } from '../src/parser/boxes.ts';
import { detectFromBuffer } from '../src/parser/detect.ts';
import { hvccBitDepth, hvccToCodecString } from '../src/parser/hvcc.ts';
import { readGrid, type GridWarning } from '../src/parser/grid.ts';
import { findProperty, parseHeif, propertiesForItem, readItemData } from '../src/parser/meta.ts';
import { Reader } from '../src/parser/reader.ts';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const showBoxes = args.includes('--boxes');

if (!path) {
  console.error('usage: dump.ts <file.heic> [--json] [--boxes]');
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
const detection = detectFromBuffer(bytes.subarray(0, 65_536));
const file = parseHeif(bytes);

const primaryProps = propertiesForItem(file, file.primaryItemId);
const primaryInfo = file.items.get(file.primaryItemId);
const ispe = findProperty(primaryProps, 'ispe');
const irot = findProperty(primaryProps, 'irot');
const imir = findProperty(primaryProps, 'imir');
const clap = findProperty(primaryProps, 'clap');
const pixi = findProperty(primaryProps, 'pixi');
const colr = findProperty(primaryProps, 'colr');

const warnings: GridWarning[] = [];
const isGrid = primaryInfo?.itemType === 'grid';
const grid = isGrid ? readGrid(file, file.primaryItemId, warnings) : undefined;

// The hvcC lives on the tiles for a grid, and on the item itself otherwise.
const codedItemId = grid ? grid.tileItemIds[0]! : file.primaryItemId;
const codedProps = propertiesForItem(file, codedItemId);
const hvcc = findProperty(codedProps, 'hvcC')?.hvcc;
const tileIspe = findProperty(codedProps, 'ispe');

// Do the tiles all share one hvcC? Compare property indices, not parsed objects.
const hvccIndexFor = (itemId: number): number | undefined =>
  file.itemProperties.associations
    .get(itemId)
    ?.find((a) => file.itemProperties.properties[a.index - 1]?.type === 'hvcC')?.index;
const distinctTileConfigs = grid
  ? new Set(grid.tileItemIds.map(hvccIndexFor)).size
  : 1;

const summary = {
  file: path,
  bytes: bytes.byteLength,
  detection,
  majorBrand: file.majorBrand,
  compatibleBrands: file.compatibleBrands,
  primaryItemId: file.primaryItemId,
  primaryItemType: primaryInfo?.itemType,
  width: ispe?.width ?? grid?.outputWidth,
  height: ispe?.height ?? grid?.outputHeight,
  isGrid,
  grid: grid && {
    rows: grid.rows,
    columns: grid.columns,
    outputWidth: grid.outputWidth,
    outputHeight: grid.outputHeight,
    tileCount: grid.tileItemIds.length,
    tileWidth: tileIspe?.width,
    tileHeight: tileIspe?.height,
    distinctTileConfigs,
  },
  codec: hvcc ? hvccToCodecString(hvcc) : undefined,
  bitDepth: pixi?.bitsPerChannel[0] ?? (hvcc ? hvccBitDepth(hvcc) : undefined),
  chromaFormat: hvcc?.chromaFormat,
  lengthSize: hvcc ? hvcc.lengthSizeMinusOne + 1 : undefined,
  rotationCcw: irot?.angle ?? 0,
  mirrorAxis: imir?.axis,
  clap: clap && {
    width: `${clap.widthN}/${clap.widthD}`,
    height: `${clap.heightN}/${clap.heightD}`,
  },
  color:
    colr?.colorType === 'nclx'
      ? {
          type: 'nclx',
          primaries: colr.primaries,
          transfer: colr.transfer,
          matrix: colr.matrix,
          fullRange: colr.fullRange,
        }
      : colr?.colorType === 'icc'
        ? { type: 'icc', profileBytes: colr.profile.byteLength }
        : null,
  items: [...file.items.values()].map((item) => ({
    id: item.itemId,
    type: item.itemType,
    name: item.itemName || undefined,
    hidden: item.hidden || undefined,
    bytes: safeItemSize(item.itemId),
    construction: file.locations.get(item.itemId)?.constructionMethod,
  })),
  references: Object.fromEntries(
    [...file.references].map(([type, map]) => [
      type,
      Object.fromEntries([...map].map(([from, to]) => [from, to.length <= 8 ? to : `${to.length} items`])),
    ]),
  ),
  properties: file.itemProperties.properties.map((p, i) => `${i + 1}: ${describeProperty(p)}`),
  warnings,
};

if (asJson) {
  console.log(JSON.stringify(summary, jsonReplacer, 2));
} else {
  printHuman();
}

if (showBoxes) {
  console.log('\nbox tree:');
  printBoxes(new Reader(bytes), 0);
}

function safeItemSize(itemId: number): number | undefined {
  try {
    return readItemData(file, itemId).byteLength;
  } catch {
    return undefined;
  }
}

function describeProperty(p: (typeof file.itemProperties.properties)[number]): string {
  switch (p.type) {
    case 'ispe':
      return `ispe ${p.width}x${p.height}`;
    case 'hvcC':
      return `hvcC ${hvccToCodecString(p.hvcc)} depth=${hvccBitDepth(p.hvcc)} lenSize=${p.hvcc.lengthSizeMinusOne + 1}`;
    case 'irot':
      return `irot ${p.angle}deg ccw`;
    case 'imir':
      return `imir axis=${p.axis}`;
    case 'colr':
      return p.colorType === 'nclx'
        ? `colr nclx ${p.primaries}/${p.transfer}/${p.matrix} full=${p.fullRange}`
        : `colr icc ${p.profile.byteLength}B`;
    case 'pixi':
      return `pixi ${p.bitsPerChannel.join(',')}`;
    case 'clap':
      return `clap ${p.widthN}/${p.widthD} x ${p.heightN}/${p.heightD}`;
    case 'auxC':
      return `auxC ${p.auxType}`;
    default:
      return `${p.boxType} (not interpreted)`;
  }
}

function printHuman(): void {
  const g = summary.grid;
  console.log(`${path}  (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
  console.log(`  brand        ${summary.majorBrand}  [${summary.compatibleBrands.join(' ')}]`);
  console.log(`  detected     isHeic=${detection.isHeic} coding=${detection.coding}`);
  console.log(`  primary      #${summary.primaryItemId} '${summary.primaryItemType}'  ${summary.width}x${summary.height}`);
  if (g) {
    console.log(`  grid         ${g.columns}x${g.rows} = ${g.tileCount} tiles of ${g.tileWidth}x${g.tileHeight}`);
    console.log(`  tile configs ${g.distinctTileConfigs} distinct hvcC`);
  }
  console.log(`  codec        ${summary.codec}  depth=${summary.bitDepth} chroma=${summary.chromaFormat} lenSize=${summary.lengthSize}`);
  console.log(`  transforms   rot=${summary.rotationCcw}ccw mirror=${summary.mirrorAxis ?? 'none'} clap=${summary.clap ? 'yes' : 'no'}`);
  console.log(`  color        ${JSON.stringify(summary.color)}`);
  console.log(`  items        ${summary.items.length}`);
  for (const item of summary.items.slice(0, 12)) {
    console.log(`    #${item.id} ${item.type.padEnd(5)} ${String(item.bytes ?? '?').padStart(8)}B  cm=${item.construction}${item.hidden ? ' hidden' : ''}${item.name ? ` "${item.name}"` : ''}`);
  }
  if (summary.items.length > 12) console.log(`    ... ${summary.items.length - 12} more`);
  console.log(`  refs         ${JSON.stringify(summary.references)}`);
  console.log('  properties');
  for (const p of summary.properties) console.log(`    ${p}`);
  for (const w of warnings) console.log(`  WARNING ${w.code}: ${w.message}`);
}

function printBoxes(reader: Reader, depth: number): void {
  const CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'iinf', 'iref', 'moov', 'trak', 'mdia']);
  for (const box of walkBoxes(reader, depth)) {
    console.log(`${'  '.repeat(depth + 1)}${box.type} ${box.size}B @${box.offset}`);
    if (!CONTAINERS.has(box.type)) continue;
    try {
      const body = box.body;
      if (box.type === 'meta' || box.type === 'iinf' || box.type === 'iref') {
        body.seek(4); // skip the FullBox header
      }
      printBoxes(body.peekRest(), depth + 1);
    } catch {
      console.log(`${'  '.repeat(depth + 2)}<unreadable>`);
    }
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}
