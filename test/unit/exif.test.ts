import { readFileSync } from 'node:fs';
import exifr from 'exifr';
import { describe, expect, it } from 'vitest';
import {
  extractExifTiff,
  findExifItemId,
  insertJpegExif,
  MAX_JPEG_EXIF_BYTES,
  prepareExifForOutput,
} from '../../src/parser/exif.ts';
import { parseHeif } from '../../src/parser/meta.ts';
import { findThumbnailItemId, planItem } from '../../src/plan.ts';

const FIXTURE = 'test/fixtures/generated/exif-thumb.heic';
const NO_EXIF = 'test/fixtures/generated/asym-base.heic';

function fixture(path: string) {
  return parseHeif(readFileSync(path));
}

/** A minimal JPEG-shaped byte string: SOI, JFIF APP0, then an opaque tail. */
function fakeJpeg(): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
}

async function parseTiff(tiff: Uint8Array) {
  // exifr reads a JPEG; wrap the block so it is parsed the way a viewer would.
  const jpeg = insertJpegExif(fakeJpeg(), tiff);
  if (!jpeg) throw new Error('insert failed');
  return exifr.parse(jpeg, { tiff: true, exif: true, gps: true, translateValues: false });
}

describe('EXIF extraction', () => {
  it('finds the Exif item through its cdsc reference', () => {
    const file = fixture(FIXTURE);
    const id = findExifItemId(file, file.primaryItemId);
    expect(file.items.get(id!)?.itemType).toBe('Exif');
  });

  it('returns the TIFF block starting at the byte-order mark', async () => {
    const tiff = extractExifTiff(fixture(FIXTURE))!;
    expect(String.fromCharCode(tiff[0]!, tiff[1]!)).toMatch(/^(II|MM)$/);
    const tags = await parseTiff(tiff);
    expect(tags.Make).toBe('heic-web');
    expect(tags.Orientation).toBe(6);
    expect(tags.latitude).toBeCloseTo(41.3851, 3);
  });

  it('returns undefined for a file without EXIF', () => {
    expect(extractExifTiff(fixture(NO_EXIF))).toBeUndefined();
  });
});

describe('prepareExifForOutput', () => {
  const source = () => extractExifTiff(fixture(FIXTURE))!;

  it('resets Orientation and writes the output dimensions', async () => {
    const prepared = prepareExifForOutput(source(), { width: 320, height: 480, stripLocation: false })!;
    const tags = await parseTiff(prepared);
    expect(tags.Orientation).toBe(1);
    expect(tags.ExifImageWidth).toBe(320);
    expect(tags.ExifImageHeight).toBe(480);
    expect(tags.latitude).toBeCloseTo(41.3851, 3);
    expect(tags.DateTimeOriginal).toBeInstanceOf(Date);
  });

  it('does not modify its input, including a Node Buffer', () => {
    for (const tiff of [source(), Buffer.from(source())]) {
      const before = Array.from(tiff);
      prepareExifForOutput(tiff, { width: 1, height: 1, stripLocation: true });
      expect(Array.from(tiff)).toEqual(before);
    }
  });

  it('widens a SHORT dimension to LONG when the value needs it', async () => {
    const prepared = prepareExifForOutput(source(), {
      width: 70_000,
      height: 480,
      stripLocation: false,
    })!;
    const tags = await parseTiff(prepared);
    expect(tags.ExifImageWidth).toBe(70_000);
  });

  it('removes GPS and leaves no trace of the coordinates', async () => {
    const original = source();
    const prepared = prepareExifForOutput(original, {
      width: 320,
      height: 480,
      stripLocation: true,
    })!;
    const tags = await parseTiff(prepared);
    expect(tags.latitude).toBeUndefined();
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.Make).toBe('heic-web');
    expect(tags.Orientation).toBe(1);
    expect(tags.DateTimeOriginal).toBeInstanceOf(Date);

    // The latitude is stored as three RATIONALs; 41/1 must not survive anywhere.
    expect((await parseTiff(original)).latitude).toBeCloseTo(41.3851, 3);
    const little = prepared[0] === 0x49;
    const needle = new Uint8Array(8);
    const view = new DataView(needle.buffer);
    view.setUint32(0, 41, little);
    view.setUint32(4, 1, little);
    expect(indexOf(prepared, needle)).toBe(-1);
    expect(indexOf(original, needle)).not.toBe(-1);
  });

  it('fails closed on a malformed block', () => {
    const tiff = source();
    // Point IFD0 past the end of the block.
    const little = tiff[0] === 0x49;
    new DataView(tiff.buffer, tiff.byteOffset).setUint32(4, tiff.byteLength + 10, little);
    expect(prepareExifForOutput(tiff, { width: 1, height: 1, stripLocation: true })).toBeUndefined();
    expect(prepareExifForOutput(new Uint8Array([1, 2, 3]), { width: 1, height: 1, stripLocation: false }))
      .toBeUndefined();
  });
});

describe('insertJpegExif', () => {
  it('places APP1 after the JFIF APP0 and keeps the rest intact', () => {
    const jpeg = fakeJpeg();
    const tiff = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
    const out = insertJpegExif(jpeg, tiff)!;
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.subarray(2, 4)]).toEqual([0xff, 0xe0]);
    expect([...out.subarray(20, 22)]).toEqual([0xff, 0xe1]);
    expect((out[22]! << 8) | out[23]!).toBe(2 + 6 + tiff.length);
    expect(new TextDecoder().decode(out.subarray(24, 28))).toBe('Exif');
    expect([...out.subarray(out.length - 6)]).toEqual([...jpeg.subarray(jpeg.length - 6)]);
  });

  it('places APP1 straight after SOI when there is no APP0', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
    const out = insertJpegExif(jpeg, new Uint8Array(8))!;
    expect([...out.subarray(2, 4)]).toEqual([0xff, 0xe1]);
  });

  it('replaces an Exif segment the encoder already wrote', () => {
    const encoderExif = [0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8];
    const jpeg = new Uint8Array([0xff, 0xd8, ...encoderExif, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
    const out = insertJpegExif(jpeg, tiff)!;
    expect(out.length).toBe(jpeg.length - encoderExif.length + 10 + tiff.length);
    expect([...out.subarray(12, 16)]).toEqual([0x49, 0x49, 0x2a, 0x00]);
    expect([...out.subarray(out.length - 6)]).toEqual([0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
  });

  it('refuses a block that does not fit one segment, and non-JPEG input', () => {
    expect(insertJpegExif(fakeJpeg(), new Uint8Array(MAX_JPEG_EXIF_BYTES + 1))).toBeUndefined();
    expect(insertJpegExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), new Uint8Array(8))).toBeUndefined();
  });
});

describe('thumbnails', () => {
  it('finds the thmb item and plans it with its own transforms', () => {
    const file = fixture(FIXTURE);
    const id = findThumbnailItemId(file, file.primaryItemId)!;
    expect(id).not.toBe(file.primaryItemId);
    const plan = planItem(file, id);
    expect(Math.max(plan.displayWidth, plan.displayHeight)).toBe(96);
    // Portrait like the primary: the thumbnail carries the same irot.
    expect(plan.displayHeight).toBeGreaterThan(plan.displayWidth);
    expect(plan.warnings).toEqual([]);
  });

  it('returns undefined when there is no thumbnail', () => {
    const file = fixture(NO_EXIF);
    expect(findThumbnailItemId(file, file.primaryItemId)).toBeUndefined();
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
