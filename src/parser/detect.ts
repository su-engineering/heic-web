import { childBoxes, findBox } from './boxes.ts';
import { parseHeif, type HeifFile } from './meta.ts';
import { Reader } from './reader.ts';

/**
 * Brands that indicate an ISOBMFF still-image file we might be able to decode.
 *
 * `mif1` and `msf1` are generic HEIF structural brands used by AVIF as well as
 * HEIC, so a match on those alone is not enough to claim the file is HEIC.
 */
export const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/** Brands that mean HEVC-coded on their own, without consulting the item type. */
const UNAMBIGUOUS_HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
]);

export type DetectedCoding = 'hevc' | 'av1' | 'unknown';

export interface DetectionResult {
  isHeic: boolean;
  /** ftyp major brand, when the file had one. */
  brand?: string | undefined;
  /** item_type of the primary item ('hvc1', 'grid', 'av01', ...). */
  primaryItemType?: string | undefined;
  /** What the primary item is coded with, resolved through any derived item. */
  coding?: DetectedCoding | undefined;
}

/**
 * Bytes `isHeic` needs from the front of a file. `ftyp` is tiny, but `meta`
 * (which carries the item types that disambiguate `mif1`) follows it and runs to
 * a few KB in Apple files. 64 KB covers every file observed and is still a cheap
 * `blob.slice()` against a 5 MB photo.
 */
export const DETECTION_PREFIX_BYTES = 65_536;

/**
 * Identifies a HEIC file from its `ftyp` brands and primary item type.
 *
 * Never consults the filename or the MIME type the browser guessed. Returns a
 * discriminated result rather than a boolean, so a caller holding an AVIF can
 * route it to a decoder that handles AVIF instead of getting a bare `false`.
 *
 * Tolerates a truncated buffer throughout: it is designed to be handed the first
 * `DETECTION_PREFIX_BYTES` of a file, so a failed parse degrades to brand-only
 * detection rather than throwing.
 */
export function detectFromBuffer(input: ArrayBuffer | Uint8Array): DetectionResult {
  const source = input instanceof Uint8Array ? input : new Uint8Array(input);

  let brands: Set<string>;
  let brand: string;
  try {
    const boxes = childBoxes(new Reader(source), { lenient: true });
    const ftyp = findBox(boxes, 'ftyp');
    if (!ftyp) return { isHeic: false };
    brand = ftyp.body.fourCC();
    brands = new Set([brand]);
    ftyp.body.u32(); // minor_version
    while (ftyp.body.remaining >= 4) brands.add(ftyp.body.fourCC());
  } catch {
    return { isHeic: false };
  }

  if (![...brands].some((b) => HEIF_BRANDS.has(b))) return { isHeic: false, brand };

  let file: HeifFile | undefined;
  try {
    file = parseHeif(source, { truncated: true });
  } catch {
    file = undefined;
  }

  const primaryItemType = file?.items.get(file.primaryItemId)?.itemType;
  const coding = file ? codingOf(file, primaryItemType) : 'unknown';

  if (coding === 'av1') return { isHeic: false, brand, primaryItemType, coding };
  if (coding === 'hevc') return { isHeic: true, brand, primaryItemType, coding };

  // No usable item type (truncated prefix, or an encoder that omits iinf).
  // Fall back to the brand, which is decisive for everything but mif1/msf1.
  const result: DetectionResult = {
    isHeic: [...brands].some((b) => UNAMBIGUOUS_HEIC_BRANDS.has(b)),
    brand,
    coding: 'unknown',
  };
  if (primaryItemType !== undefined) result.primaryItemType = primaryItemType;
  return result;
}

/** Resolves a derived item's coding through its first `dimg` reference. */
function codingOf(file: HeifFile, itemType: string | undefined, depth = 0): DetectedCoding {
  if (itemType === 'hvc1' || itemType === 'hev1') return 'hevc';
  if (itemType === 'av01') return 'av1';
  if (depth < 4 && (itemType === 'grid' || itemType === 'iovl' || itemType === 'iden')) {
    const first = file.references.get('dimg')?.get(file.primaryItemId)?.[0];
    if (first !== undefined) return codingOf(file, file.items.get(first)?.itemType, depth + 1);
  }
  return 'unknown';
}
