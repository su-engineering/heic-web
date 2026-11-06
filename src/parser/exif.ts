import { readItemData, type HeifFile } from './meta.ts';

/**
 * EXIF handling: find the Exif item, hand out its TIFF bytes, and prepare a copy
 * that is safe to embed in an image whose pixels have already been transformed.
 *
 * Offsets inside a TIFF block are relative to the block itself, so every edit
 * here is done in place on a copy. Nothing is re-serialised, which keeps
 * MakerNote and other opaque blocks byte-identical.
 */

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;

/** Byte size of one value of each TIFF field type. Unknown types are treated as opaque. */
const TYPE_SIZES: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

/** IFDs with more entries than this are malformed; real files have dozens. */
const MAX_IFD_ENTRIES = 1024;

/**
 * Item ID of the Exif block that describes `itemId`.
 *
 * The spec links metadata to images with a `cdsc` reference. Some encoders omit
 * the reference, so a lone Exif item is accepted as a fallback; two unreferenced
 * Exif items are ambiguous and yield nothing.
 */
export function findExifItemId(file: HeifFile, itemId: number): number | undefined {
  const cdsc = file.references.get('cdsc');
  if (cdsc) {
    for (const [fromId, toIds] of cdsc) {
      if (toIds.includes(itemId) && file.items.get(fromId)?.itemType === 'Exif') return fromId;
    }
  }
  const exifItems = [...file.items.values()].filter((item) => item.itemType === 'Exif');
  return exifItems.length === 1 ? exifItems[0]!.itemId : undefined;
}

/**
 * The TIFF block ("II*\0" or "MM\0*" onwards) of the primary image's EXIF, as a
 * fresh copy, or `undefined` when the file has none or it is malformed.
 *
 * The HEIF Exif item starts with a 4-byte offset to the TIFF header; Apple fills
 * the gap with the JPEG-style "Exif\0\0" marker.
 */
export function extractExifTiff(file: HeifFile): Uint8Array | undefined {
  const exifId = findExifItemId(file, file.primaryItemId);
  if (exifId === undefined) return undefined;
  const payload = readItemData(file, exifId);
  if (payload.byteLength < 4) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const start = 4 + view.getUint32(0);
  if (start + 8 > payload.byteLength) return undefined;
  // new Uint8Array(view) always copies; .slice() on a Node Buffer does not.
  const tiff = new Uint8Array(payload.subarray(start));
  return tiffByteOrder(tiff) === undefined ? undefined : tiff;
}

function tiffByteOrder(tiff: Uint8Array): boolean | undefined {
  if (tiff.byteLength < 8) return undefined;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return undefined;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return undefined;
  return little;
}

interface IfdEntry {
  /** Byte offset of the 12-byte entry within the TIFF block. */
  at: number;
  tag: number;
  type: number;
  count: number;
}

/** Thrown internally for anything structurally wrong; callers turn it into "no EXIF". */
class MalformedExif extends Error {}

class Tiff {
  readonly view: DataView;
  readonly little: boolean;

  constructor(readonly bytes: Uint8Array) {
    const little = tiffByteOrder(bytes);
    if (little === undefined) throw new MalformedExif('not a TIFF block');
    this.little = little;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at, this.little);
  }
  u32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at, this.little);
  }
  setU16(at: number, value: number): void {
    this.check(at, 2);
    this.view.setUint16(at, value, this.little);
  }
  setU32(at: number, value: number): void {
    this.check(at, 4);
    this.view.setUint32(at, value, this.little);
  }
  check(at: number, length: number): void {
    if (at < 0 || length < 0 || at + length > this.bytes.byteLength) {
      throw new MalformedExif(`range [${at}, ${at + length}) outside ${this.bytes.byteLength} bytes`);
    }
  }

  get ifd0(): number {
    return this.u32(4);
  }

  entries(ifdOffset: number): IfdEntry[] {
    const count = this.u16(ifdOffset);
    if (count > MAX_IFD_ENTRIES) throw new MalformedExif(`IFD declares ${count} entries`);
    this.check(ifdOffset + 2, count * 12 + 4);
    const out: IfdEntry[] = [];
    for (let i = 0; i < count; i++) {
      const at = ifdOffset + 2 + i * 12;
      out.push({ at, tag: this.u16(at), type: this.u16(at + 2), count: this.u32(at + 4) });
    }
    return out;
  }

  /** Out-of-line value range of an entry, or undefined when the value fits inline. */
  valueRange(entry: IfdEntry): { start: number; length: number } | undefined {
    const size = TYPE_SIZES[entry.type];
    if (size === undefined) throw new MalformedExif(`unknown TIFF type ${entry.type}`);
    const length = size * entry.count;
    if (length <= 4) return undefined;
    const start = this.u32(entry.at + 8);
    this.check(start, length);
    return { start, length };
  }

  /** Writes an inline SHORT or LONG value. Other types are left alone. */
  setInlineNumber(entry: IfdEntry, value: number): void {
    if (entry.count !== 1) return;
    if (entry.type === TYPE_SHORT) {
      if (value > 0xffff) {
        // Widen to LONG; the 4-byte value slot fits either.
        this.setU16(entry.at + 2, TYPE_LONG);
        this.setU32(entry.at + 8, value);
      } else {
        this.setU16(entry.at + 8, value);
        this.setU16(entry.at + 10, 0);
      }
    } else if (entry.type === TYPE_LONG) {
      this.setU32(entry.at + 8, value);
    }
  }
}

export interface PrepareExifOptions {
  /** Dimensions of the encoded output, written to PixelXDimension/PixelYDimension. */
  width: number;
  height: number;
  /** Remove the GPS IFD and overwrite its bytes with zeros. */
  stripLocation: boolean;
}

/**
 * Returns a copy of `tiff` that is correct for an output image whose pixels are
 * already upright: Orientation becomes 1 (otherwise viewers rotate a second
 * time) and the pixel dimensions match the output.
 *
 * With `stripLocation`, the GPS IFD pointer is removed from IFD0 and every byte
 * of the GPS IFD, including out-of-line values, is zeroed so the coordinates are
 * not recoverable from the file.
 *
 * Returns `undefined` when the block is malformed. Failing closed matters most
 * for `stripLocation`: a block we cannot walk is a block we cannot prove clean.
 */
export function prepareExifForOutput(
  tiff: Uint8Array,
  options: PrepareExifOptions,
): Uint8Array | undefined {
  const copy = new Uint8Array(tiff); // a real copy even when handed a Node Buffer
  try {
    const t = new Tiff(copy);
    const ifd0 = t.ifd0;
    const entries = t.entries(ifd0);

    for (const entry of entries) {
      if (entry.tag === TAG_ORIENTATION) t.setInlineNumber(entry, 1);
    }

    const exifPointer = entries.find((e) => e.tag === TAG_EXIF_IFD);
    if (exifPointer) {
      for (const entry of t.entries(t.u32(exifPointer.at + 8))) {
        if (entry.tag === TAG_PIXEL_X) t.setInlineNumber(entry, options.width);
        if (entry.tag === TAG_PIXEL_Y) t.setInlineNumber(entry, options.height);
      }
    }

    if (options.stripLocation) {
      const gpsIndex = entries.findIndex((e) => e.tag === TAG_GPS_IFD);
      if (gpsIndex !== -1) {
        const gpsOffset = t.u32(entries[gpsIndex]!.at + 8);
        const gpsEntries = t.entries(gpsOffset);
        for (const entry of gpsEntries) {
          const range = t.valueRange(entry);
          if (range) copy.fill(0, range.start, range.start + range.length);
        }
        copy.fill(0, gpsOffset, gpsOffset + 2 + gpsEntries.length * 12 + 4);
        removeEntry(t, ifd0, entries.length, gpsIndex);
      }
    }
    return copy;
  } catch (error) {
    if (error instanceof MalformedExif) return undefined;
    throw error;
  }
}

/** Deletes entry `index` from an IFD by shifting the rest down and moving the next-IFD link. */
function removeEntry(t: Tiff, ifdOffset: number, count: number, index: number): void {
  const entriesStart = ifdOffset + 2;
  const nextLinkAt = entriesStart + count * 12;
  const nextLink = t.u32(nextLinkAt);
  t.bytes.copyWithin(entriesStart + index * 12, entriesStart + (index + 1) * 12, nextLinkAt);
  t.setU16(ifdOffset, count - 1);
  t.setU32(nextLinkAt - 12, nextLink);
  t.bytes.fill(0, nextLinkAt - 8, nextLinkAt + 4);
}

/** Largest TIFF block that fits one APP1 segment: 65535 minus length field and "Exif\0\0". */
export const MAX_JPEG_EXIF_BYTES = 65_535 - 2 - 6;

/**
 * Inserts an APP1 Exif segment into a JPEG, after SOI and after a JFIF APP0 if
 * one is present (the placement exiftool and libjpeg use).
 *
 * Any Exif APP1 the encoder already wrote is removed first: WebKit's encoder
 * adds a small one of its own, and two Exif segments leave viewers to pick one.
 *
 * Returns `undefined` if `jpeg` is not a well-formed JPEG header or the block is
 * too big for a single segment.
 */
export function insertJpegExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array | undefined {
  if (tiff.byteLength > MAX_JPEG_EXIF_BYTES) return undefined;
  if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;

  // Walk the header segments up to the first non-APPn marker.
  const kept: Uint8Array[] = [];
  let insertAt = 0; // index into `kept` after which the new segment goes
  let pos = 2;
  while (pos + 4 <= jpeg.byteLength && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1]!;
    if (marker < 0xe0 || marker > 0xef) break;
    const length = (jpeg[pos + 2]! << 8) | jpeg[pos + 3]!;
    const end = pos + 2 + length;
    if (length < 2 || end > jpeg.byteLength) return undefined;
    const segment = jpeg.subarray(pos, end);
    const isExif =
      marker === 0xe1 && length >= 8 &&
      segment[4] === 0x45 && segment[5] === 0x78 && segment[6] === 0x69 &&
      segment[7] === 0x66 && segment[8] === 0x00 && segment[9] === 0x00;
    if (!isExif) {
      kept.push(segment);
      if (marker === 0xe0 && kept.length === 1) insertAt = 1;
    }
    pos = end;
  }

  const segmentLength = 2 + 6 + tiff.byteLength;
  const app1 = new Uint8Array(2 + segmentLength);
  app1.set([0xff, 0xe1, segmentLength >> 8, segmentLength & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  app1.set(tiff, 10);

  const parts = [jpeg.subarray(0, 2), ...kept.slice(0, insertAt), app1, ...kept.slice(insertAt), jpeg.subarray(pos)];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
