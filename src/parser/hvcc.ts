import { HeicParseError } from '../errors.ts';
import { Reader } from './reader.ts';

/** NAL unit types that appear in an hvcC parameter-set array. */
export const NAL_VPS = 32;
export const NAL_SPS = 33;
export const NAL_PPS = 34;

export interface HvccNalArray {
  arrayCompleteness: boolean;
  nalUnitType: number;
  /** Views into the source buffer, not copies. */
  nalus: Uint8Array[];
}

/** Parsed HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1). */
export interface HvcC {
  configurationVersion: number;
  generalProfileSpace: number;
  generalTierFlag: number;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  /** Six bytes, big-endian order as stored. */
  generalConstraintIndicatorFlags: Uint8Array;
  generalLevelIdc: number;
  minSpatialSegmentationIdc: number;
  parallelismType: number;
  chromaFormat: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  avgFrameRate: number;
  constantFrameRate: number;
  numTemporalLayers: number;
  temporalIdNested: number;
  /** Byte width of the length prefix on each NAL unit in the item payload. */
  lengthSizeMinusOne: number;
  arrays: HvccNalArray[];
  /** The raw record, which is what VideoDecoderConfig.description wants. */
  raw: Uint8Array;
}

/** Sanity cap: no real hvcC has more than a handful of arrays or NAL units. */
const MAX_HVCC_ARRAYS = 32;
const MAX_NALUS_PER_ARRAY = 256;

export function parseHvcC(reader: Reader): HvcC {
  const raw = reader.peekRest().bytes;

  const configurationVersion = reader.u8();
  if (configurationVersion !== 1) {
    // The spec reserves other values; libheif and Chromium both only accept 1.
    throw new HeicParseError(
      `Unsupported HEVCDecoderConfigurationRecord version ${configurationVersion}`,
      { box: 'hvcC' },
    );
  }

  const profileByte = reader.u8();
  const generalProfileSpace = (profileByte >> 6) & 0x03;
  const generalTierFlag = (profileByte >> 5) & 0x01;
  const generalProfileIdc = profileByte & 0x1f;

  const generalProfileCompatibilityFlags = reader.u32();
  const generalConstraintIndicatorFlags = reader.copy(6);
  const generalLevelIdc = reader.u8();

  const minSpatialSegmentationIdc = reader.u16() & 0x0fff;
  const parallelismType = reader.u8() & 0x03;
  const chromaFormat = reader.u8() & 0x03;
  const bitDepthLumaMinus8 = reader.u8() & 0x07;
  const bitDepthChromaMinus8 = reader.u8() & 0x07;

  const avgFrameRate = reader.u16();
  const rateByte = reader.u8();
  const constantFrameRate = (rateByte >> 6) & 0x03;
  const numTemporalLayers = (rateByte >> 3) & 0x07;
  const temporalIdNested = (rateByte >> 2) & 0x01;
  const lengthSizeMinusOne = rateByte & 0x03;

  const numOfArrays = reader.u8();
  if (numOfArrays > MAX_HVCC_ARRAYS) {
    throw new HeicParseError(`hvcC declares ${numOfArrays} NAL arrays`, { box: 'hvcC' });
  }

  const arrays: HvccNalArray[] = [];
  for (let i = 0; i < numOfArrays; i++) {
    const head = reader.u8();
    const arrayCompleteness = ((head >> 7) & 0x01) === 1;
    const nalUnitType = head & 0x3f;
    const numNalus = reader.u16();
    if (numNalus > MAX_NALUS_PER_ARRAY) {
      throw new HeicParseError(`hvcC array declares ${numNalus} NAL units`, { box: 'hvcC' });
    }
    const nalus: Uint8Array[] = [];
    for (let j = 0; j < numNalus; j++) {
      const nalUnitLength = reader.u16();
      nalus.push(reader.view_(nalUnitLength));
    }
    arrays.push({ arrayCompleteness, nalUnitType, nalus });
  }

  return {
    configurationVersion,
    generalProfileSpace,
    generalTierFlag,
    generalProfileIdc,
    generalProfileCompatibilityFlags,
    generalConstraintIndicatorFlags,
    generalLevelIdc,
    minSpatialSegmentationIdc,
    parallelismType,
    chromaFormat,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    avgFrameRate,
    constantFrameRate,
    numTemporalLayers,
    temporalIdNested,
    lengthSizeMinusOne,
    arrays,
    raw,
  };
}

const PROFILE_SPACE_PREFIX = ['', 'A', 'B', 'C'] as const;

/**
 * Builds the RFC 6381 codec string for a VideoDecoderConfig.
 *
 * Format: `{fourcc}.{space}{profile_idc}.{compat}.{tier}{level}.{constraints}`
 * A typical iPhone Main-profile record produces `hvc1.1.6.L93.B0`.
 */
export function hvccToCodecString(hvcc: HvcC, fourCC: 'hvc1' | 'hev1' = 'hvc1'): string {
  const space = PROFILE_SPACE_PREFIX[hvcc.generalProfileSpace] ?? '';
  const profile = `${space}${hvcc.generalProfileIdc}`;

  // The compatibility flags are printed bit-reversed. This is not a quirk of any
  // one implementation: RFC 6381 specifies the value "in reverse bit order",
  // which is why Main profile's 0x60000000 prints as "6" and not "60000000".
  const compat = reverseBits32(hvcc.generalProfileCompatibilityFlags).toString(16);

  const tier = hvcc.generalTierFlag === 1 ? 'H' : 'L';
  const level = `${tier}${hvcc.generalLevelIdc}`;

  // Trailing zero constraint bytes are omitted; a record with no constraint bits
  // set contributes no trailing component at all.
  const constraintBytes = [...hvcc.generalConstraintIndicatorFlags];
  while (constraintBytes.length > 0 && constraintBytes[constraintBytes.length - 1] === 0) {
    constraintBytes.pop();
  }
  const constraints = constraintBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase());

  return [fourCC, profile, compat, level, ...constraints].join('.');
}

/** Reverses the bit order of a 32-bit unsigned integer. */
export function reverseBits32(value: number): number {
  let v = value >>> 0;
  v = ((v & 0x55555555) << 1) | ((v >>> 1) & 0x55555555);
  v = ((v & 0x33333333) << 2) | ((v >>> 2) & 0x33333333);
  v = ((v & 0x0f0f0f0f) << 4) | ((v >>> 4) & 0x0f0f0f0f);
  v = ((v & 0x00ff00ff) << 8) | ((v >>> 8) & 0x00ff00ff);
  v = (v >>> 16) | (v << 16);
  return v >>> 0;
}

/** Bit depth reported by the decoder configuration record. */
export function hvccBitDepth(hvcc: HvcC): number {
  return hvcc.bitDepthLumaMinus8 + 8;
}

/**
 * Builds an Annex B parameter-set prologue (VPS/SPS/PPS, each start-code
 * prefixed) for the `hev1` fallback configuration mode.
 */
export function hvccToAnnexBPrologue(hvcc: HvcC): Uint8Array {
  const wanted = [NAL_VPS, NAL_SPS, NAL_PPS];
  const selected = wanted
    .flatMap((type) => hvcc.arrays.filter((a) => a.nalUnitType === type))
    .flatMap((a) => a.nalus);

  let total = 0;
  for (const nalu of selected) total += 4 + nalu.byteLength;

  const out = new Uint8Array(total);
  let pos = 0;
  for (const nalu of selected) {
    out.set([0x00, 0x00, 0x00, 0x01], pos);
    pos += 4;
    out.set(nalu, pos);
    pos += nalu.byteLength;
  }
  return out;
}

/**
 * Rewrites a length-prefixed NAL unit stream to Annex B start codes.
 * `lengthSize` is `lengthSizeMinusOne + 1` from the hvcC.
 */
export function lengthPrefixedToAnnexB(data: Uint8Array, lengthSize: number): Uint8Array {
  if (lengthSize < 1 || lengthSize > 4) {
    throw new HeicParseError(`Invalid NAL length size ${lengthSize}`, { box: 'hvcC' });
  }
  // Start codes are 4 bytes, so the output is at most (4 - lengthSize) bytes
  // larger per NAL unit. Counting first avoids growing a buffer in a loop.
  const out = new Uint8Array(data.byteLength + countNalUnits(data, lengthSize) * (4 - lengthSize));
  let read = 0;
  let write = 0;
  while (read + lengthSize <= data.byteLength) {
    let naluLength = 0;
    for (let i = 0; i < lengthSize; i++) naluLength = (naluLength << 8) | data[read + i]!;
    read += lengthSize;
    if (naluLength < 0 || read + naluLength > data.byteLength) {
      throw new HeicParseError('NAL unit length runs past the end of the item payload', {
        offset: read,
      });
    }
    out.set([0x00, 0x00, 0x00, 0x01], write);
    write += 4;
    out.set(data.subarray(read, read + naluLength), write);
    write += naluLength;
    read += naluLength;
  }
  return out.subarray(0, write);
}

function countNalUnits(data: Uint8Array, lengthSize: number): number {
  let read = 0;
  let count = 0;
  while (read + lengthSize <= data.byteLength) {
    let naluLength = 0;
    for (let i = 0; i < lengthSize; i++) naluLength = (naluLength << 8) | data[read + i]!;
    read += lengthSize + naluLength;
    if (naluLength < 0 || read > data.byteLength) break;
    count++;
  }
  return count;
}
