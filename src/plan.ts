import { HeicParseError, HeicUnsupportedError } from './errors.ts';
import { readGrid } from './parser/grid.ts';
import { hvccBitDepth, hvccToCodecString, type HvcC } from './parser/hvcc.ts';
import {
  findProperty,
  parseHeif,
  propertiesForItem,
  readItemData,
  type HeifFile,
  type ItemProperty,
} from './parser/meta.ts';
import type { HeicWarning, SourceColor } from './types.ts';

/**
 * Total pixels we are willing to composite. 256 MP is roughly 4x the largest
 * consumer camera output, and caps a single canvas at about a gigabyte of RGBA.
 * Rejecting before allocating is the point.
 */
export const MAX_TOTAL_PIXELS = 256_000_000;

/** A transform to apply, in the order the file associated it. */
export type TransformOp =
  | { kind: 'rotate'; angle: 90 | 180 | 270 }
  | { kind: 'mirror'; axis: 0 | 1 }
  | { kind: 'crop'; width: number; height: number; offsetX: number; offsetY: number };

export interface TileGroup {
  /** ipco property index of the hvcC these tiles share. */
  configIndex: number;
  hvcc: HvcC;
  codec: string;
  /** Indices into `ImagePlan.tiles`, in submission order. */
  tileIndices: number[];
}

export interface PlannedTile {
  itemId: number;
  /** Position in the composited canvas, before any transform. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePlan {
  file: HeifFile;
  primaryItemId: number;
  isGrid: boolean;
  /** Coded dimensions, before transforms. */
  codedWidth: number;
  codedHeight: number;
  /** Dimensions as displayed, after transforms. What the caller sees. */
  displayWidth: number;
  displayHeight: number;
  tiles: PlannedTile[];
  /** Tiles grouped by decoder configuration. Normally exactly one group. */
  tileGroups: TileGroup[];
  /** Transforms in `ipma` association order. */
  transforms: TransformOp[];
  bitDepth: number;
  sourceColor: SourceColor;
  warnings: HeicWarning[];
}

/**
 * Parses the container and works out everything every strategy needs.
 *
 * Always runs, whichever strategy ends up decoding: the native path needs the
 * dimensions to validate its output, the WebCodecs path needs the tiles, and the
 * wasm path needs the metadata we report back.
 */
export function planDecode(input: ArrayBuffer | Uint8Array): ImagePlan {
  const file = parseHeif(input);
  const warnings: HeicWarning[] = [];

  const primaryItemId = file.primaryItemId;
  const info = file.items.get(primaryItemId);
  if (!info) {
    throw new HeicParseError(`Primary item ${primaryItemId} is not described by iinf`, {
      brand: file.majorBrand,
      itemId: primaryItemId,
    });
  }

  const isGrid = info.itemType === 'grid';

  // Checked before reading properties: an AVIF's primary item carries an
  // essential 'av1C', and "primary item type 'av01' is not supported" is a far
  // more useful message than "unsupported essential property 'av1C'".
  if (!isGrid && info.itemType !== 'hvc1' && info.itemType !== 'hev1') {
    throw new HeicUnsupportedError(
      `Primary item type '${info.itemType}' is not a supported image item`,
      [],
      { brand: file.majorBrand, itemType: info.itemType, itemId: primaryItemId },
    );
  }

  const primaryProps = propertiesForItem(file, primaryItemId);

  const tiles: PlannedTile[] = [];
  let codedWidth: number;
  let codedHeight: number;

  if (isGrid) {
    const grid = readGrid(file, primaryItemId, warnings);
    codedWidth = grid.outputWidth;
    codedHeight = grid.outputHeight;

    const firstTileProps = propertiesForItem(file, grid.tileItemIds[0]!);
    const firstIspe = findProperty(firstTileProps, 'ispe');
    if (!firstIspe) {
      throw new HeicParseError(`Grid tile ${grid.tileItemIds[0]} has no ispe`, {
        itemId: grid.tileItemIds[0]!,
      });
    }

    for (const [index, itemId] of grid.tileItemIds.entries()) {
      // Tiles are uniform in every file observed, but read each one's own ispe
      // rather than assuming: a wrong tile size silently shifts the mosaic.
      const ispe = findProperty(propertiesForItem(file, itemId), 'ispe') ?? firstIspe;
      tiles.push({
        itemId,
        x: (index % grid.columns) * firstIspe.width,
        y: Math.floor(index / grid.columns) * firstIspe.height,
        width: ispe.width,
        height: ispe.height,
      });
    }
  } else {
    const ispe = findProperty(primaryProps, 'ispe');
    if (!ispe) {
      throw new HeicParseError(`Primary item ${primaryItemId} has no ispe`, {
        itemId: primaryItemId,
      });
    }
    codedWidth = ispe.width;
    codedHeight = ispe.height;
    tiles.push({ itemId: primaryItemId, x: 0, y: 0, width: ispe.width, height: ispe.height });
  }

  if (codedWidth <= 0 || codedHeight <= 0) {
    throw new HeicParseError(`Implausible image dimensions ${codedWidth}x${codedHeight}`, {
      itemId: primaryItemId,
    });
  }
  if (codedWidth * codedHeight > MAX_TOTAL_PIXELS) {
    throw new HeicUnsupportedError(
      `Image is ${codedWidth}x${codedHeight}, above the ${MAX_TOTAL_PIXELS}-pixel limit`,
      [],
      { itemId: primaryItemId },
    );
  }

  const tileGroups = groupTilesByConfig(file, tiles, warnings);
  const transforms = readTransforms(primaryProps, codedWidth, codedHeight);
  const { displayWidth, displayHeight } = applyTransformsToSize(
    codedWidth,
    codedHeight,
    transforms,
  );

  const pixi = findProperty(primaryProps, 'pixi');
  const bitDepth =
    pixi?.bitsPerChannel[0] ?? hvccBitDepth(tileGroups[0]!.hvcc);

  collectFeatureWarnings(file, primaryItemId, warnings);

  return {
    file,
    primaryItemId,
    isGrid,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    tiles,
    tileGroups,
    transforms,
    bitDepth,
    sourceColor: readSourceColor(primaryProps, propertiesForItem(file, tiles[0]!.itemId)),
    warnings,
  };
}

/**
 * Groups tiles by their `hvcC`, comparing ipco property *indices* rather than
 * parsed records, so identical-but-separate properties still group correctly.
 *
 * Nearly every file yields a single group and a single VideoDecoder. Files that
 * genuinely mix configurations get one reconfigure per group — never one decoder
 * per tile, which exhausts hardware decoder handles.
 */
function groupTilesByConfig(
  file: HeifFile,
  tiles: readonly PlannedTile[],
  warnings: HeicWarning[],
): TileGroup[] {
  const groups = new Map<number, TileGroup>();

  for (const [index, tile] of tiles.entries()) {
    const associations = file.itemProperties.associations.get(tile.itemId) ?? [];
    const association = associations.find(
      (a) => file.itemProperties.properties[a.index - 1]?.type === 'hvcC',
    );
    if (!association) {
      throw new HeicParseError(`Item ${tile.itemId} has no hvcC property`, { itemId: tile.itemId });
    }

    let group = groups.get(association.index);
    if (!group) {
      const property = file.itemProperties.properties[association.index - 1];
      if (property?.type !== 'hvcC') {
        throw new HeicParseError(`Property ${association.index} is not an hvcC`, {
          itemId: tile.itemId,
        });
      }
      group = {
        configIndex: association.index,
        hvcc: property.hvcc,
        codec: hvccToCodecString(property.hvcc),
        tileIndices: [],
      };
      groups.set(association.index, group);
    }
    group.tileIndices.push(index);
  }

  const result = [...groups.values()];
  if (result.length === 0) {
    throw new HeicParseError('No decoder configuration found for any tile', {});
  }
  if (result.length > 1) {
    warnings.push({
      code: 'mixed-tile-configs',
      message: `Tiles use ${result.length} different decoder configurations; decoding in ${result.length} groups`,
    });
  }
  return result;
}

/**
 * Collects transformative properties in association order.
 *
 * HEIF §6.5.1 says these apply in the order they appear in `ipma`, and requires
 * writers to associate them as clap, irot, imir. Reading the order out of the
 * file rather than hardcoding that sequence costs nothing and makes malformed
 * files render the way other software renders them.
 */
function readTransforms(
  properties: readonly ItemProperty[],
  width: number,
  height: number,
): TransformOp[] {
  const ops: TransformOp[] = [];
  let currentWidth = width;
  let currentHeight = height;

  for (const property of properties) {
    switch (property.type) {
      case 'clap': {
        const crop = resolveCleanAperture(property, currentWidth, currentHeight);
        if (crop) {
          ops.push(crop);
          currentWidth = crop.width;
          currentHeight = crop.height;
        }
        break;
      }
      case 'irot':
        if (property.angle !== 0) {
          ops.push({ kind: 'rotate', angle: property.angle });
          if (property.angle === 90 || property.angle === 270) {
            [currentWidth, currentHeight] = [currentHeight, currentWidth];
          }
        }
        break;
      case 'imir':
        ops.push({ kind: 'mirror', axis: property.axis });
        break;
      default:
        break;
    }
  }
  return ops;
}

/**
 * Converts a `clap` box's rational centre-relative description into a pixel rect.
 *
 * The box gives cropped width/height as fractions and the offset of the cropped
 * centre from the *uncropped* centre, which is why this is not a plain rect.
 */
function resolveCleanAperture(
  clap: Extract<ItemProperty, { type: 'clap' }>,
  width: number,
  height: number,
): Extract<TransformOp, { kind: 'crop' }> | undefined {
  if (clap.widthD === 0 || clap.heightD === 0 || clap.horizOffD === 0 || clap.vertOffD === 0) {
    return undefined;
  }
  const cropWidth = Math.round(clap.widthN / clap.widthD);
  const cropHeight = Math.round(clap.heightN / clap.heightD);
  const centreOffsetX = clap.horizOffN / clap.horizOffD;
  const centreOffsetY = clap.vertOffN / clap.vertOffD;

  const offsetX = Math.round((width - cropWidth) / 2 + centreOffsetX);
  const offsetY = Math.round((height - cropHeight) / 2 + centreOffsetY);

  // A clap that is a no-op, or that describes a region outside the image, is
  // ignored rather than trusted; other decoders do the same.
  if (cropWidth <= 0 || cropHeight <= 0) return undefined;
  if (cropWidth === width && cropHeight === height && offsetX === 0 && offsetY === 0) {
    return undefined;
  }
  if (offsetX < 0 || offsetY < 0 || offsetX + cropWidth > width || offsetY + cropHeight > height) {
    return undefined;
  }
  return { kind: 'crop', width: cropWidth, height: cropHeight, offsetX, offsetY };
}

function applyTransformsToSize(
  width: number,
  height: number,
  transforms: readonly TransformOp[],
): { displayWidth: number; displayHeight: number } {
  let w = width;
  let h = height;
  for (const op of transforms) {
    if (op.kind === 'crop') {
      w = op.width;
      h = op.height;
    } else if (op.kind === 'rotate' && (op.angle === 90 || op.angle === 270)) {
      [w, h] = [h, w];
    }
  }
  return { displayWidth: w, displayHeight: h };
}

/** `colr` lives on the primary item, but some encoders put it only on the tiles. */
function readSourceColor(
  primaryProps: readonly ItemProperty[],
  tileProps: readonly ItemProperty[],
): SourceColor {
  const colr = findProperty(primaryProps, 'colr') ?? findProperty(tileProps, 'colr');
  if (!colr) return null;
  return colr.colorType === 'nclx'
    ? {
        type: 'nclx',
        primaries: colr.primaries,
        transfer: colr.transfer,
        matrix: colr.matrix,
        fullRange: colr.fullRange,
      }
    : { type: 'icc', profile: colr.profile };
}

/**
 * Reports features present in the file that v0.1 deliberately does not decode.
 *
 * The primary image still comes back; this is how a caller finds out that the
 * alpha channel or gain map they were counting on was dropped, rather than
 * discovering it from a user's bug report.
 */
function collectFeatureWarnings(
  file: HeifFile,
  primaryItemId: number,
  warnings: HeicWarning[],
): void {
  const seen = new Set<string>();
  const add = (warning: HeicWarning): void => {
    // A gain map is described by both an 'auxl' aux image and a 'tmap' item, so
    // dedupe by code: one ignored feature, one warning.
    if (seen.has(warning.code)) return;
    seen.add(warning.code);
    warnings.push(warning);
  };

  const auxTargets = file.references.get('auxl');
  if (auxTargets) {
    for (const [auxItemId, targets] of auxTargets) {
      if (!targets.includes(primaryItemId)) continue;
      const auxType = findProperty(propertiesForItem(file, auxItemId), 'auxC')?.auxType ?? '';
      if (/alpha/i.test(auxType)) {
        add({ code: 'alpha-ignored', message: `Alpha aux image ${auxItemId} ignored` });
      } else if (/depth|disparity/i.test(auxType)) {
        add({ code: 'depth-ignored', message: `Depth aux image ${auxItemId} ignored` });
      } else if (/hdrgainmap|gainmap/i.test(auxType)) {
        add({
          code: 'gain-map-ignored',
          message: `HDR gain map ${auxItemId} ignored; the image decodes as SDR`,
        });
      }
    }
  }

  // A 'tmap' item is iOS 18's tone-mapped HDR representation; we decode the SDR
  // base image, which is what a browser would show anyway.
  for (const item of file.items.values()) {
    if (item.itemType === 'tmap') {
      add({
        code: 'gain-map-ignored',
        message: `Tone-map item ${item.itemId} ignored; the image decodes as SDR`,
      });
      break;
    }
  }
}

/** Item payload for a planned tile. */
export function tileData(plan: ImagePlan, tile: PlannedTile): Uint8Array {
  return readItemData(plan.file, tile.itemId);
}
