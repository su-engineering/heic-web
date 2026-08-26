/**
 * Injects a transformative property (`irot` / `imir`) into an existing HEIC.
 *
 * No encoder available to us writes `imir`, and the spec is explicit that its
 * axis semantics must be verified empirically rather than taken on trust. So we
 * forge fixtures: take a real file, add the property, and let libheif render the
 * result. If our interpretation of the field disagrees with libheif's, the
 * cross-strategy test says so.
 *
 * Only handles the simple single-item case (one iloc entry, index_size 0), which
 * is all the transform fixtures need.
 *
 * Usage:
 *   node --experimental-strip-types tools/inject-property.ts in.heic out.heic irot 90
 *   node --experimental-strip-types tools/inject-property.ts in.heic out.heic imir 0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { childBoxes, walkBoxes, type Box } from '../src/parser/boxes.ts';
import { parseHeif } from '../src/parser/meta.ts';
import { Reader } from '../src/parser/reader.ts';

const [input, output, kind, valueText] = process.argv.slice(2);
if (!input || !output || (kind !== 'irot' && kind !== 'imir')) {
  console.error('usage: inject-property.ts <in.heic> <out.heic> <irot|imir> <value>');
  process.exit(2);
}
const value = Number(valueText);

const source = new Uint8Array(readFileSync(input));
const file = parseHeif(source);
const root = childBoxes(new Reader(source));

const ftyp = mustFind(root, 'ftyp');
const meta = mustFind(root, 'meta');
const metaChildren = childBoxes(sliceReader(source, meta.offset + meta.headerSize + 4, meta.size - meta.headerSize - 4));
const iprp = mustFind(metaChildren, 'iprp');
const iloc = mustFind(metaChildren, 'iloc');

// --- the new property box -------------------------------------------------
const property =
  kind === 'irot'
    ? box('irot', new Uint8Array([(value / 90) & 0x03]))
    : box('imir', new Uint8Array([value & 0x01]));

// --- rebuild ipco with the property appended ------------------------------
const iprpChildren = childBoxes(sliceReader(source, iprp.offset + iprp.headerSize, iprp.size - iprp.headerSize));
const ipco = mustFind(iprpChildren, 'ipco');
const ipma = mustFind(iprpChildren, 'ipma');

const existingPropertyCount = [...walkBoxes(sliceReader(source, ipco.offset + ipco.headerSize, ipco.size - ipco.headerSize))].length;
const newPropertyIndex = existingPropertyCount + 1;

const newIpco = box(
  'ipco',
  concat([source.subarray(ipco.offset + ipco.headerSize, ipco.offset + ipco.size), property]),
);

// --- rebuild ipma with an association for the primary item ----------------
const newIpma = rebuildIpma(source, ipma, file.primaryItemId, newPropertyIndex);
const newIprp = box('iprp', concat([newIpco, newIpma]));

// --- everything shifts by this much ---------------------------------------
const delta = newIprp.byteLength - iprp.size;

// --- rebuild iloc with shifted offsets -------------------------------------
const newIloc = rebuildIloc(source, iloc, delta);
if (newIloc.byteLength !== iloc.size) {
  throw new Error(`iloc changed size (${iloc.size} -> ${newIloc.byteLength}); offsets would be wrong`);
}

// --- reassemble ------------------------------------------------------------
const newMetaBody = concat(
  metaChildren.map((child) => {
    if (child.offset === iprp.offset) return newIprp;
    if (child.offset === iloc.offset) return newIloc;
    return source.subarray(child.offset, child.offset + child.size);
  }),
);
const metaFullBoxHeader = source.subarray(meta.offset + meta.headerSize, meta.offset + meta.headerSize + 4);
const newMeta = box('meta', concat([metaFullBoxHeader, newMetaBody]));

const tail = source.subarray(meta.offset + meta.size);
const head = source.subarray(ftyp.offset, ftyp.offset + ftyp.size);
const result = concat([head, newMeta, tail]);

writeFileSync(output, result);
console.error(
  `${input} -> ${output}: added ${kind}=${value} as property ${newPropertyIndex}, shifted item data by ${delta} bytes`,
);

// ---------------------------------------------------------------------------

function mustFind(boxes: readonly Box[], type: string): Box {
  const found = boxes.find((b) => b.type === type);
  if (!found) throw new Error(`missing '${type}' box`);
  return found;
}

function sliceReader(bytes: Uint8Array, offset: number, length: number): Reader {
  return new Reader(bytes, offset, length);
}

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

/** Re-serialises ipma with one extra association appended to `itemId`. */
function rebuildIpma(bytes: Uint8Array, original: Box, itemId: number, propertyIndex: number): Uint8Array {
  const r = new Reader(bytes, original.offset + original.headerSize, original.size - original.headerSize);
  const version = r.u8();
  const flags = r.u24();
  const wide = (flags & 0x01) === 1;
  const entryCount = r.u32();

  const entries: { id: number; associations: { essential: boolean; index: number }[] }[] = [];
  for (let i = 0; i < entryCount; i++) {
    const id = version === 0 ? r.u16() : r.u32();
    const count = r.u8();
    const associations: { essential: boolean; index: number }[] = [];
    for (let j = 0; j < count; j++) {
      if (wide) {
        const v = r.u16();
        associations.push({ essential: (v & 0x8000) !== 0, index: v & 0x7fff });
      } else {
        const v = r.u8();
        associations.push({ essential: (v & 0x80) !== 0, index: v & 0x7f });
      }
    }
    entries.push({ id, associations });
  }

  const target = entries.find((e) => e.id === itemId);
  if (!target) throw new Error(`ipma has no entry for item ${itemId}`);
  if (!wide && propertyIndex > 0x7f) throw new Error('property index needs the wide ipma form');
  // Transformative properties are marked essential: a reader that does not
  // understand them must refuse rather than render the image untransformed.
  target.associations.push({ essential: true, index: propertyIndex });

  const parts: number[] = [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff];
  push32(parts, entries.length);
  for (const entry of entries) {
    if (version === 0) push16(parts, entry.id);
    else push32(parts, entry.id);
    parts.push(entry.associations.length);
    for (const association of entry.associations) {
      if (wide) push16(parts, (association.essential ? 0x8000 : 0) | association.index);
      else parts.push((association.essential ? 0x80 : 0) | association.index);
    }
  }
  return box('ipma', new Uint8Array(parts));
}

/** Re-serialises iloc with every construction_method 0 offset shifted by `delta`. */
function rebuildIloc(bytes: Uint8Array, original: Box, delta: number): Uint8Array {
  const r = new Reader(bytes, original.offset + original.headerSize, original.size - original.headerSize);
  const version = r.u8();
  const flags = r.u24();
  const sizesByte = r.u8();
  const offsetSize = (sizesByte >> 4) & 0x0f;
  const lengthSize = sizesByte & 0x0f;
  const baseByte = r.u8();
  const baseOffsetSize = (baseByte >> 4) & 0x0f;
  const indexSize = version === 1 || version === 2 ? baseByte & 0x0f : 0;
  if (indexSize !== 0) throw new Error('iloc uses extent indices; not supported by this tool');

  const itemCount = version < 2 ? r.u16() : r.u32();
  const parts: number[] = [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff, sizesByte, baseByte];
  if (version < 2) push16(parts, itemCount);
  else push32(parts, itemCount);

  for (let i = 0; i < itemCount; i++) {
    const itemId = version < 2 ? r.u16() : r.u32();
    let constructionMethod = 0;
    let methodField = 0;
    if (version === 1 || version === 2) {
      methodField = r.u16();
      constructionMethod = methodField & 0x0f;
    }
    const dataReferenceIndex = r.u16();
    const baseOffset = r.uint(baseOffsetSize);
    const extentCount = r.u16();

    // Only file offsets move. idat-relative offsets (method 1) are relative to a
    // box that moves with the rest of meta, so they stay as they are.
    const shift = constructionMethod === 0 ? delta : 0;
    const shiftBase = shift !== 0 && baseOffsetSize > 0 && baseOffset > 0;

    if (version < 2) push16(parts, itemId);
    else push32(parts, itemId);
    if (version === 1 || version === 2) push16(parts, methodField);
    push16(parts, dataReferenceIndex);
    pushUint(parts, shiftBase ? baseOffset + shift : baseOffset, baseOffsetSize);
    push16(parts, extentCount);

    for (let j = 0; j < extentCount; j++) {
      const extentOffset = r.uint(offsetSize);
      const extentLength = r.uint(lengthSize);
      pushUint(parts, shiftBase ? extentOffset : extentOffset + shift, offsetSize);
      pushUint(parts, extentLength, lengthSize);
    }
  }

  return box('iloc', new Uint8Array(parts));
}

function push16(into: number[], value: number): void {
  into.push((value >> 8) & 0xff, value & 0xff);
}
function push32(into: number[], value: number): void {
  into.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}
function pushUint(into: number[], value: number, byteWidth: number): void {
  for (let i = byteWidth - 1; i >= 0; i--) into.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
}
