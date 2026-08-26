import { HeicParseError } from '../errors.ts';
import { childBoxes, findBox, findBoxes, walkBoxes, type Box } from './boxes.ts';
import { parseHvcC, type HvcC } from './hvcc.ts';
import { Reader, readFullBoxHeader } from './reader.ts';

/** Sanity caps. Every one of these is far past any real file. */
const MAX_ITEMS = 65_536;
const MAX_EXTENTS_PER_ITEM = 4096;
const MAX_PROPERTIES = 4096;
const MAX_ASSOCIATIONS_PER_ITEM = 256;
const MAX_REFERENCES_PER_ITEM = 8192;

// ---------------------------------------------------------------------------
// Item info (iinf / infe)
// ---------------------------------------------------------------------------

export interface ItemInfo {
  itemId: number;
  protectionIndex: number;
  /** 'hvc1', 'grid', 'Exif', 'mime', ... Empty for version 0/1 infe boxes. */
  itemType: string;
  itemName: string;
  contentType?: string;
  /** Set when the infe declares the item hidden. */
  hidden: boolean;
}

function parseInfe(box: Box): ItemInfo {
  const r = box.body;
  const { version, flags } = readFullBoxHeader(r);
  const hidden = (flags & 0x01) === 1;

  if (version >= 2) {
    const itemId = version === 2 ? r.u16() : r.u32();
    const protectionIndex = r.u16();
    const itemType = r.fourCC();
    const itemName = r.cString();
    const info: ItemInfo = { itemId, protectionIndex, itemType, itemName, hidden };
    if (itemType === 'mime') info.contentType = r.cString();
    return info;
  }

  // Version 0/1 predate item_type; only 'mime'-ish metadata items use these and
  // we never need to decode them, but they must not break the walk.
  const itemId = r.u16();
  const protectionIndex = r.u16();
  const itemName = r.cString();
  const contentType = r.cString();
  return { itemId, protectionIndex, itemType: '', itemName, contentType, hidden };
}

function parseIinf(box: Box): Map<number, ItemInfo> {
  const r = box.body;
  const { version } = readFullBoxHeader(r);
  const entryCount = version === 0 ? r.u16() : r.u32();
  if (entryCount > MAX_ITEMS) {
    throw new HeicParseError(`iinf declares ${entryCount} items`, { box: 'iinf' });
  }

  const items = new Map<number, ItemInfo>();
  // Trust the box structure over the declared count: walk the actual children
  // and stop at the container end. A wrong entry_count is then harmless.
  let seen = 0;
  for (const child of walkBoxes(r.peekRest())) {
    if (child.type !== 'infe') continue;
    if (++seen > MAX_ITEMS) break;
    const info = parseInfe(child);
    items.set(info.itemId, info);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Item locations (iloc)
// ---------------------------------------------------------------------------

export interface ItemExtent {
  /** Offset, relative to whatever `constructionMethod` selects. */
  offset: number;
  length: number;
}

export interface ItemLocation {
  itemId: number;
  /** 0 = offset into the file, 1 = offset into idat, 2 = offset into another item. */
  constructionMethod: number;
  baseOffset: number;
  extents: ItemExtent[];
}

function parseIloc(box: Box): Map<number, ItemLocation> {
  const r = box.body;
  const { version } = readFullBoxHeader(r);

  const sizesByte = r.u8();
  const offsetSize = (sizesByte >> 4) & 0x0f;
  const lengthSize = sizesByte & 0x0f;
  const baseByte = r.u8();
  const baseOffsetSize = (baseByte >> 4) & 0x0f;
  // index_size occupies the low nibble in versions 1 and 2; reserved in version 0.
  const indexSize = version === 1 || version === 2 ? baseByte & 0x0f : 0;

  const itemCount = version < 2 ? r.u16() : r.u32();
  if (itemCount > MAX_ITEMS) {
    throw new HeicParseError(`iloc declares ${itemCount} items`, { box: 'iloc' });
  }

  const locations = new Map<number, ItemLocation>();
  for (let i = 0; i < itemCount; i++) {
    const itemId = version < 2 ? r.u16() : r.u32();

    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = r.u16() & 0x0f; // 12 reserved bits, then 4 bits of method
    }

    r.u16(); // data_reference_index — external references are not supported
    const baseOffset = r.uint(baseOffsetSize);

    const extentCount = r.u16();
    if (extentCount > MAX_EXTENTS_PER_ITEM) {
      throw new HeicParseError(`Item ${itemId} declares ${extentCount} extents`, {
        box: 'iloc',
        itemId,
      });
    }

    const extents: ItemExtent[] = [];
    for (let j = 0; j < extentCount; j++) {
      if ((version === 1 || version === 2) && indexSize > 0) r.uint(indexSize); // extent_index
      const offset = r.uint(offsetSize);
      const length = r.uint(lengthSize);
      extents.push({ offset, length });
    }

    locations.set(itemId, { itemId, constructionMethod, baseOffset, extents });
  }
  return locations;
}

// ---------------------------------------------------------------------------
// Item properties (iprp → ipco / ipma)
// ---------------------------------------------------------------------------

export interface IspeProperty {
  type: 'ispe';
  width: number;
  height: number;
}
export interface HvccProperty {
  type: 'hvcC';
  hvcc: HvcC;
}
export interface IrotProperty {
  type: 'irot';
  /** Counter-clockwise rotation in degrees. */
  angle: 0 | 90 | 180 | 270;
}
export interface ImirProperty {
  type: 'imir';
  /** Raw `axis` field. See render/transform.ts for the semantics, which are verified empirically. */
  axis: 0 | 1;
}
export interface ColrNclxProperty {
  type: 'colr';
  colorType: 'nclx';
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}
export interface ColrIccProperty {
  type: 'colr';
  colorType: 'icc';
  profile: Uint8Array;
}
export interface PixiProperty {
  type: 'pixi';
  bitsPerChannel: number[];
}
export interface ClapProperty {
  type: 'clap';
  widthN: number;
  widthD: number;
  heightN: number;
  heightD: number;
  horizOffN: number;
  horizOffD: number;
  vertOffN: number;
  vertOffD: number;
}
export interface AuxCProperty {
  type: 'auxC';
  auxType: string;
}
export interface UnknownProperty {
  type: 'unknown';
  boxType: string;
}

export type ItemProperty =
  | IspeProperty
  | HvccProperty
  | IrotProperty
  | ImirProperty
  | ColrNclxProperty
  | ColrIccProperty
  | PixiProperty
  | ClapProperty
  | AuxCProperty
  | UnknownProperty;

/** Properties we know how to honour. An *essential* association to anything else is fatal. */
const UNDERSTOOD_PROPERTY_TYPES = new Set([
  'ispe',
  'hvcC',
  'irot',
  'imir',
  'colr',
  'pixi',
  'clap',
  'auxC',
  // Understood in the sense of "safe to ignore": these carry display hints and
  // metadata that do not change the decoded pixels.
  'pasp',
  'clli',
  'mdcv',
  'rloc',
  'cclv',
  'amve',
]);

function parseProperty(box: Box): ItemProperty {
  const r = box.body;
  switch (box.type) {
    case 'ispe': {
      readFullBoxHeader(r);
      return { type: 'ispe', width: r.u32(), height: r.u32() };
    }
    case 'hvcC':
      return { type: 'hvcC', hvcc: parseHvcC(r) };
    case 'irot': {
      const angle = ((r.u8() & 0x03) * 90) as 0 | 90 | 180 | 270;
      return { type: 'irot', angle };
    }
    case 'imir': {
      const axis = (r.u8() & 0x01) as 0 | 1;
      return { type: 'imir', axis };
    }
    case 'colr': {
      const colorType = r.fourCC();
      if (colorType === 'nclx') {
        const primaries = r.u16();
        const transfer = r.u16();
        const matrix = r.u16();
        const fullRange = (r.u8() & 0x80) !== 0;
        return { type: 'colr', colorType: 'nclx', primaries, transfer, matrix, fullRange };
      }
      if (colorType === 'rICC' || colorType === 'prof') {
        return { type: 'colr', colorType: 'icc', profile: r.copy(r.remaining) };
      }
      return { type: 'unknown', boxType: `colr:${colorType}` };
    }
    case 'pixi': {
      readFullBoxHeader(r);
      const numChannels = r.u8();
      const bitsPerChannel: number[] = [];
      for (let i = 0; i < numChannels; i++) bitsPerChannel.push(r.u8());
      return { type: 'pixi', bitsPerChannel };
    }
    case 'clap':
      return {
        type: 'clap',
        widthN: r.u32(),
        widthD: r.u32(),
        heightN: r.u32(),
        heightD: r.u32(),
        horizOffN: r.u32() | 0, // stored as a signed 32-bit numerator
        horizOffD: r.u32(),
        vertOffN: r.u32() | 0,
        vertOffD: r.u32(),
      };
    case 'auxC': {
      readFullBoxHeader(r);
      return { type: 'auxC', auxType: r.cString() };
    }
    default:
      return { type: 'unknown', boxType: box.type };
  }
}

export interface PropertyAssociation {
  /** 1-based index into the ipco child list. */
  index: number;
  essential: boolean;
}

function parseIpma(box: Box, into: Map<number, PropertyAssociation[]>): void {
  const r = box.body;
  const { version, flags } = readFullBoxHeader(r);
  const wideIndex = (flags & 0x01) === 1;

  const entryCount = r.u32();
  if (entryCount > MAX_ITEMS) {
    throw new HeicParseError(`ipma declares ${entryCount} entries`, { box: 'ipma' });
  }

  for (let i = 0; i < entryCount; i++) {
    const itemId = version === 0 ? r.u16() : r.u32();
    const associationCount = r.u8();
    if (associationCount > MAX_ASSOCIATIONS_PER_ITEM) {
      throw new HeicParseError(`Item ${itemId} declares ${associationCount} properties`, {
        box: 'ipma',
        itemId,
      });
    }

    // Association *order* is load-bearing: transformative properties apply in the
    // order they appear here (HEIF §6.5.1), so this list must never be sorted.
    const associations: PropertyAssociation[] = [];
    for (let j = 0; j < associationCount; j++) {
      if (wideIndex) {
        const value = r.u16();
        associations.push({ essential: (value & 0x8000) !== 0, index: value & 0x7fff });
      } else {
        const value = r.u8();
        associations.push({ essential: (value & 0x80) !== 0, index: value & 0x7f });
      }
    }

    // A file may carry several ipma boxes; later entries append to the item.
    const existing = into.get(itemId);
    if (existing) existing.push(...associations);
    else into.set(itemId, associations);
  }
}

export interface ItemProperties {
  /** 1-indexed in the file; index 0 is "no property" and is never present here. */
  properties: ItemProperty[];
  associations: Map<number, PropertyAssociation[]>;
}

function parseIprp(box: Box): ItemProperties {
  const children = childBoxes(box.body);
  const ipco = findBox(children, 'ipco');

  const properties: ItemProperty[] = [];
  if (ipco) {
    for (const child of walkBoxes(ipco.body)) {
      if (properties.length >= MAX_PROPERTIES) {
        throw new HeicParseError(`ipco holds more than ${MAX_PROPERTIES} properties`, {
          box: 'ipco',
        });
      }
      properties.push(parseProperty(child));
    }
  }

  const associations = new Map<number, PropertyAssociation[]>();
  for (const ipma of findBoxes(children, 'ipma')) parseIpma(ipma, associations);

  return { properties, associations };
}

// ---------------------------------------------------------------------------
// Item references (iref)
// ---------------------------------------------------------------------------

/** referenceType → fromItemId → toItemIds, in file order. */
export type ItemReferences = Map<string, Map<number, number[]>>;

function parseIref(box: Box): ItemReferences {
  const r = box.body;
  const { version } = readFullBoxHeader(r);
  const refs: ItemReferences = new Map();

  for (const child of walkBoxes(r.peekRest())) {
    const cr = child.body;
    const fromItemId = version === 0 ? cr.u16() : cr.u32();
    const referenceCount = cr.u16();
    if (referenceCount > MAX_REFERENCES_PER_ITEM) {
      throw new HeicParseError(`Item ${fromItemId} declares ${referenceCount} references`, {
        box: child.type,
        itemId: fromItemId,
      });
    }
    const toItemIds: number[] = [];
    for (let i = 0; i < referenceCount; i++) {
      toItemIds.push(version === 0 ? cr.u16() : cr.u32());
    }

    let byType = refs.get(child.type);
    if (!byType) refs.set(child.type, (byType = new Map()));
    byType.set(fromItemId, toItemIds);
  }

  return refs;
}

// ---------------------------------------------------------------------------
// The parsed file
// ---------------------------------------------------------------------------

export interface HeifFile {
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: string[];
  /** Item ID named by `pitm`. */
  primaryItemId: number;
  handlerType: string;
  items: Map<number, ItemInfo>;
  locations: Map<number, ItemLocation>;
  itemProperties: ItemProperties;
  references: ItemReferences;
  /** Payload of the `idat` box, for construction_method 1. */
  itemData: Uint8Array | undefined;
  /** The whole source buffer, for construction_method 0 offsets. */
  source: Uint8Array;
}

export interface ParseOptions {
  /**
   * Tolerate a top-level box that runs past the end of the buffer, stopping the
   * walk there instead of throwing. Only for detection, which is deliberately
   * handed a truncated prefix; a full-file parse stays strict so that genuine
   * truncation is reported rather than silently half-decoded.
   */
  truncated?: boolean;
}

export function parseHeif(input: ArrayBuffer | Uint8Array, options: ParseOptions = {}): HeifFile {
  const source = input instanceof Uint8Array ? input : new Uint8Array(input);
  const root = new Reader(source);
  const boxes = childBoxes(root, { lenient: options.truncated === true });

  const ftyp = findBox(boxes, 'ftyp');
  if (!ftyp) throw new HeicParseError("No 'ftyp' box: this is not an ISOBMFF file", { offset: 0 });
  const majorBrand = ftyp.body.fourCC();
  const minorVersion = ftyp.body.u32();
  const compatibleBrands: string[] = [];
  while (ftyp.body.remaining >= 4) compatibleBrands.push(ftyp.body.fourCC());

  const meta = findBox(boxes, 'meta');
  if (!meta) {
    throw new HeicParseError("No 'meta' box: not a HEIF image file", { brand: majorBrand });
  }
  readFullBoxHeader(meta.body); // meta is a FullBox
  const metaChildren = childBoxes(meta.body, 1);

  const hdlr = findBox(metaChildren, 'hdlr');
  let handlerType = '';
  if (hdlr) {
    readFullBoxHeader(hdlr.body);
    hdlr.body.u32(); // pre_defined
    handlerType = hdlr.body.fourCC();
  }
  if (handlerType && handlerType !== 'pict') {
    throw new HeicParseError(`meta handler is '${handlerType}', expected 'pict'`, {
      brand: majorBrand,
    });
  }

  let primaryItemId = 0;
  const pitm = findBox(metaChildren, 'pitm');
  if (pitm) {
    const { version } = readFullBoxHeader(pitm.body);
    primaryItemId = version === 0 ? pitm.body.u16() : pitm.body.u32();
  }

  const iinf = findBox(metaChildren, 'iinf');
  const items = iinf ? parseIinf(iinf) : new Map<number, ItemInfo>();

  const iloc = findBox(metaChildren, 'iloc');
  const locations = iloc ? parseIloc(iloc) : new Map<number, ItemLocation>();

  const iprp = findBox(metaChildren, 'iprp');
  const itemProperties = iprp ? parseIprp(iprp) : { properties: [], associations: new Map() };

  const iref = findBox(metaChildren, 'iref');
  const references = iref ? parseIref(iref) : (new Map() as ItemReferences);

  const idat = findBox(metaChildren, 'idat');
  const itemData = idat ? idat.body.copy(idat.body.remaining) : undefined;

  // With no pitm, fall back to the first image item rather than failing: some
  // non-Apple encoders omit it for single-image files.
  if (primaryItemId === 0) {
    for (const [id, info] of items) {
      if (info.itemType === 'hvc1' || info.itemType === 'hev1' || info.itemType === 'grid') {
        primaryItemId = id;
        break;
      }
    }
  }

  return {
    majorBrand,
    minorVersion,
    compatibleBrands,
    primaryItemId,
    handlerType,
    items,
    locations,
    itemProperties,
    references,
    itemData,
    source,
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Properties associated with an item, in `ipma` order. Order matters for transforms. */
export function propertiesForItem(file: HeifFile, itemId: number): ItemProperty[] {
  const associations = file.itemProperties.associations.get(itemId) ?? [];
  const out: ItemProperty[] = [];

  for (const association of associations) {
    if (association.index === 0) continue; // 0 means "no property"
    const property = file.itemProperties.properties[association.index - 1];
    if (!property) {
      throw new HeicParseError(
        `Item ${itemId} references property ${association.index}, but ipco holds ${file.itemProperties.properties.length}`,
        { itemId, box: 'ipma' },
      );
    }
    // "Essential" means the file is asserting we cannot render correctly without
    // honouring this. Producing a confidently wrong image is worse than failing.
    if (association.essential && property.type === 'unknown') {
      throw new HeicParseError(
        `Item ${itemId} requires unsupported essential property '${property.boxType}'`,
        { itemId, box: property.boxType },
      );
    }
    out.push(property);
  }
  return out;
}

/** First property of the given kind for an item, or undefined. */
export function findProperty<T extends ItemProperty['type']>(
  properties: readonly ItemProperty[],
  type: T,
): Extract<ItemProperty, { type: T }> | undefined {
  return properties.find((p) => p.type === type) as Extract<ItemProperty, { type: T }> | undefined;
}

/**
 * Assembles an item's payload from its extents.
 *
 * Extents are concatenated in order. Every offset and length is validated
 * against the actual buffer before a single byte is allocated, so a malformed
 * `extent_length` fails here rather than in the allocator.
 */
export function readItemData(file: HeifFile, itemId: number): Uint8Array {
  const location = file.locations.get(itemId);
  if (!location) {
    throw new HeicParseError(`No iloc entry for item ${itemId}`, { itemId, box: 'iloc' });
  }

  const info = file.items.get(itemId);
  const context = { itemId, itemType: info?.itemType, box: 'iloc' };

  let container: Uint8Array;
  switch (location.constructionMethod) {
    case 0:
      container = file.source;
      break;
    case 1:
      if (!file.itemData) {
        throw new HeicParseError(
          `Item ${itemId} points into 'idat', but the file has no idat box`,
          context,
        );
      }
      container = file.itemData;
      break;
    case 2:
      throw new HeicParseError(
        `Item ${itemId} uses construction_method 2 (item offset), which is not supported`,
        context,
      );
    default:
      throw new HeicParseError(
        `Item ${itemId} uses unknown construction_method ${location.constructionMethod}`,
        context,
      );
  }

  // Validate every extent before allocating anything.
  let total = 0;
  for (const extent of location.extents) {
    const start = location.baseOffset + extent.offset;
    // An extent_length of 0 means "to the end of the container" (ISO 14496-12).
    const length = extent.length === 0 ? container.byteLength - start : extent.length;
    if (start < 0 || length < 0 || start + length > container.byteLength) {
      throw new HeicParseError(
        `Item ${itemId} extent [${start}, ${start + length}) is outside its ${container.byteLength}-byte container`,
        context,
      );
    }
    total += length;
  }

  if (location.extents.length === 1) {
    const extent = location.extents[0]!;
    const start = location.baseOffset + extent.offset;
    return container.subarray(start, start + total);
  }

  const out = new Uint8Array(total);
  let pos = 0;
  for (const extent of location.extents) {
    const start = location.baseOffset + extent.offset;
    const length = extent.length === 0 ? container.byteLength - start : extent.length;
    out.set(container.subarray(start, start + length), pos);
    pos += length;
  }
  return out;
}
