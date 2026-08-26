import { HeicParseError } from '../errors.ts';
import { findProperty, propertiesForItem, readItemData, type HeifFile } from './meta.ts';
import { Reader } from './reader.ts';

/** A grid of more than this many tiles is rejected rather than allocated for. */
export const MAX_TILES = 4096;

export interface GridDescriptor {
  rows: number;
  columns: number;
  /** Output dimensions the grid declares in its payload. */
  outputWidth: number;
  outputHeight: number;
  /** Tile item IDs in raster order (left to right, top to bottom). */
  tileItemIds: number[];
}

/**
 * Parses an ImageGrid payload (HEIF §6.6.2.3.1).
 *
 * ```
 * u8 version (0)
 * u8 flags            bit 0 = field_length_size: 0 -> u16 dims, 1 -> u32 dims
 * u8 rows_minus_one
 * u8 columns_minus_one
 * output_width        u16 or u32
 * output_height       u16 or u32
 * ```
 */
export function parseGridPayload(payload: Uint8Array): Omit<GridDescriptor, 'tileItemIds'> {
  const r = new Reader(payload);
  const version = r.u8();
  if (version !== 0) {
    throw new HeicParseError(`Unsupported grid version ${version}`, { itemType: 'grid' });
  }
  const flags = r.u8();
  const wideFields = (flags & 0x01) === 1;
  const rows = r.u8() + 1;
  const columns = r.u8() + 1;
  const outputWidth = wideFields ? r.u32() : r.u16();
  const outputHeight = wideFields ? r.u32() : r.u16();
  return { rows, columns, outputWidth, outputHeight };
}

export interface GridWarning {
  code: string;
  message: string;
}

/**
 * Reads the full grid description for an item, cross-checking the declared
 * dimensions against `ispe` and the declared tile count against `dimg`.
 */
export function readGrid(
  file: HeifFile,
  itemId: number,
  warnings: GridWarning[] = [],
): GridDescriptor {
  const payload = readItemData(file, itemId);
  const { rows, columns, outputWidth, outputHeight } = parseGridPayload(payload);

  const tileItemIds = file.references.get('dimg')?.get(itemId) ?? [];
  if (tileItemIds.length === 0) {
    throw new HeicParseError(`Grid item ${itemId} has no 'dimg' tile references`, {
      itemId,
      itemType: 'grid',
    });
  }

  // rows x columns is file-supplied and drives both the tile loop and the canvas
  // layout, so it must agree with the reference list before we allocate.
  const expected = rows * columns;
  if (expected !== tileItemIds.length) {
    throw new HeicParseError(
      `Grid item ${itemId} declares ${rows}x${columns} = ${expected} tiles but 'dimg' lists ${tileItemIds.length}`,
      { itemId, itemType: 'grid' },
    );
  }
  if (expected > MAX_TILES) {
    throw new HeicParseError(`Grid item ${itemId} declares ${expected} tiles (max ${MAX_TILES})`, {
      itemId,
      itemType: 'grid',
    });
  }

  // The grid item's own ispe is the authority when the two disagree; libheif and
  // Preview both render from ispe, so matching them keeps output consistent.
  let width = outputWidth;
  let height = outputHeight;
  const ispe = findProperty(propertiesForItem(file, itemId), 'ispe');
  if (ispe && (ispe.width !== outputWidth || ispe.height !== outputHeight)) {
    warnings.push({
      code: 'grid-dimension-mismatch',
      message: `Grid payload declares ${outputWidth}x${outputHeight} but ispe declares ${ispe.width}x${ispe.height}; using ispe`,
    });
    width = ispe.width;
    height = ispe.height;
  }

  return { rows, columns, outputWidth: width, outputHeight: height, tileItemIds };
}
