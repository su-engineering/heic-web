/**
 * Extracts the raw material a VideoDecoder needs from a HEIC, as JSON.
 *
 * This exists for the spike and for debugging: it lets a browser page exercise
 * the decode path without shipping the parser to it, so a failure is
 * unambiguously the decoder's and not ours.
 *
 * Usage: node --experimental-strip-types tools/spike-extract.ts <file.heic> > out.json
 */
import { readFileSync } from 'node:fs';
import { readGrid } from '../src/parser/grid.ts';
import { hvccBitDepth, hvccToCodecString } from '../src/parser/hvcc.ts';
import { findProperty, parseHeif, propertiesForItem, readItemData } from '../src/parser/meta.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: spike-extract.ts <file.heic>');
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
const file = parseHeif(bytes);
const info = file.items.get(file.primaryItemId);
const primaryProps = propertiesForItem(file, file.primaryItemId);
const isGrid = info?.itemType === 'grid';
const grid = isGrid ? readGrid(file, file.primaryItemId) : undefined;

const tileIds = grid ? grid.tileItemIds : [file.primaryItemId];
const codedProps = propertiesForItem(file, tileIds[0]!);
const hvcc = findProperty(codedProps, 'hvcC')?.hvcc;
if (!hvcc) throw new Error('no hvcC on the coded item');
const tileIspe = findProperty(codedProps, 'ispe');
const ispe = findProperty(primaryProps, 'ispe');
const irot = findProperty(primaryProps, 'irot');

const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');

process.stdout.write(
  JSON.stringify({
    file: path.split('/').pop(),
    codec: hvccToCodecString(hvcc),
    codecHev1: hvccToCodecString(hvcc, 'hev1'),
    bitDepth: hvccBitDepth(hvcc),
    lengthSize: hvcc.lengthSizeMinusOne + 1,
    description: b64(hvcc.raw),
    codedWidth: tileIspe?.width ?? ispe?.width,
    codedHeight: tileIspe?.height ?? ispe?.height,
    displayWidth: ispe?.width ?? grid?.outputWidth,
    displayHeight: ispe?.height ?? grid?.outputHeight,
    rotationCcw: irot?.angle ?? 0,
    isGrid,
    columns: grid?.columns ?? 1,
    rows: grid?.rows ?? 1,
    tiles: tileIds.map((id) => b64(readItemData(file, id))),
  }),
);
