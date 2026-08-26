import { describe, expect, it } from 'vitest';
import {
  hvccToAnnexBPrologue,
  hvccToCodecString,
  lengthPrefixedToAnnexB,
  parseHvcC,
  reverseBits32,
} from '../../src/parser/hvcc.ts';
import { Reader } from '../../src/parser/reader.ts';

/** Minimal but structurally valid HEVCDecoderConfigurationRecord. */
function buildHvcC(options: {
  profileSpace?: number;
  tier?: number;
  profileIdc?: number;
  compatibility?: number;
  constraints?: number[];
  levelIdc?: number;
  bitDepthLumaMinus8?: number;
  lengthSizeMinusOne?: number;
  arrays?: { nalUnitType: number; nalus: number[][] }[];
}): Uint8Array {
  const {
    profileSpace = 0,
    tier = 0,
    profileIdc = 1,
    compatibility = 0x60000000,
    constraints = [0xb0, 0, 0, 0, 0, 0],
    levelIdc = 93,
    bitDepthLumaMinus8 = 0,
    lengthSizeMinusOne = 3,
    arrays = [],
  } = options;

  const bytes: number[] = [];
  bytes.push(1); // configurationVersion
  bytes.push(((profileSpace & 3) << 6) | ((tier & 1) << 5) | (profileIdc & 0x1f));
  bytes.push(
    (compatibility >>> 24) & 0xff,
    (compatibility >>> 16) & 0xff,
    (compatibility >>> 8) & 0xff,
    compatibility & 0xff,
  );
  bytes.push(...constraints);
  bytes.push(levelIdc);
  bytes.push(0xf0, 0x00); // min_spatial_segmentation_idc
  bytes.push(0xfc); // parallelismType
  bytes.push(0xfc | 1); // chromaFormat 4:2:0
  bytes.push(0xf8 | bitDepthLumaMinus8);
  bytes.push(0xf8 | bitDepthLumaMinus8);
  bytes.push(0, 0); // avgFrameRate
  bytes.push((0 << 6) | (1 << 3) | (1 << 2) | (lengthSizeMinusOne & 3));
  bytes.push(arrays.length);
  for (const array of arrays) {
    bytes.push(0x80 | (array.nalUnitType & 0x3f));
    bytes.push((array.nalus.length >> 8) & 0xff, array.nalus.length & 0xff);
    for (const nalu of array.nalus) {
      bytes.push((nalu.length >> 8) & 0xff, nalu.length & 0xff, ...nalu);
    }
  }
  return new Uint8Array(bytes);
}

describe('reverseBits32', () => {
  it('reverses bit order', () => {
    expect(reverseBits32(0x60000000)).toBe(0x00000006);
    expect(reverseBits32(0x70000000)).toBe(0x0000000e);
    expect(reverseBits32(0x00000001)).toBe(0x80000000);
    expect(reverseBits32(0)).toBe(0);
    expect(reverseBits32(0xffffffff)).toBe(0xffffffff);
  });
});

describe('hvccToCodecString', () => {
  it('produces the canonical Main profile string', () => {
    const hvcc = parseHvcC(new Reader(buildHvcC({})));
    expect(hvccToCodecString(hvcc)).toBe('hvc1.1.6.L93.B0');
  });

  it('produces the Main Still Picture string Apple actually writes', () => {
    // Verified against a real iPhone file: profile_idc 3, compatibility
    // 0x70000000 (compatible with profiles 1, 2 and 3), level 93.
    const hvcc = parseHvcC(new Reader(buildHvcC({ profileIdc: 3, compatibility: 0x70000000 })));
    expect(hvccToCodecString(hvcc)).toBe('hvc1.3.e.L93.B0');
  });

  it('marks the high tier with H', () => {
    const hvcc = parseHvcC(new Reader(buildHvcC({ tier: 1, levelIdc: 120 })));
    expect(hvccToCodecString(hvcc)).toContain('.H120.');
  });

  it('prefixes a non-zero profile space', () => {
    for (const [space, prefix] of [[1, 'A'], [2, 'B'], [3, 'C']] as const) {
      const hvcc = parseHvcC(new Reader(buildHvcC({ profileSpace: space })));
      expect(hvccToCodecString(hvcc)).toBe(`hvc1.${prefix}1.6.L93.B0`);
    }
  });

  it('omits trailing zero constraint bytes but keeps interior ones', () => {
    const all = parseHvcC(new Reader(buildHvcC({ constraints: [0, 0, 0, 0, 0, 0] })));
    expect(hvccToCodecString(all)).toBe('hvc1.1.6.L93');

    const interior = parseHvcC(new Reader(buildHvcC({ constraints: [0xbf, 0, 0xc8, 0, 0, 0] })));
    expect(hvccToCodecString(interior)).toBe('hvc1.1.6.L93.BF.00.C8');
  });

  it('can emit the hev1 fourcc for the Annex B fallback', () => {
    const hvcc = parseHvcC(new Reader(buildHvcC({})));
    expect(hvccToCodecString(hvcc, 'hev1')).toBe('hev1.1.6.L93.B0');
  });
});

describe('parseHvcC', () => {
  it('rejects an unknown configuration version', () => {
    const bytes = buildHvcC({});
    bytes[0] = 2;
    expect(() => parseHvcC(new Reader(bytes))).toThrow(/version 2/);
  });

  it('reads the NAL length size and bit depth', () => {
    const hvcc = parseHvcC(new Reader(buildHvcC({ lengthSizeMinusOne: 1, bitDepthLumaMinus8: 2 })));
    expect(hvcc.lengthSizeMinusOne + 1).toBe(2);
    expect(hvcc.bitDepthLumaMinus8 + 8).toBe(10);
  });

  it('reads parameter set arrays', () => {
    const hvcc = parseHvcC(
      new Reader(
        buildHvcC({
          arrays: [
            { nalUnitType: 32, nalus: [[0x40, 0x01]] },
            { nalUnitType: 33, nalus: [[0x42, 0x01, 0x02]] },
            { nalUnitType: 34, nalus: [[0x44, 0x01]] },
          ],
        }),
      ),
    );
    expect(hvcc.arrays.map((a) => a.nalUnitType)).toEqual([32, 33, 34]);
    expect([...hvcc.arrays[1]!.nalus[0]!]).toEqual([0x42, 0x01, 0x02]);
  });
});

describe('Annex B conversion', () => {
  it('prefixes VPS, SPS and PPS with start codes, in that order', () => {
    const hvcc = parseHvcC(
      new Reader(
        buildHvcC({
          // Deliberately out of order in the record: the prologue must still be
          // VPS, SPS, PPS, which is what decoders expect.
          arrays: [
            { nalUnitType: 34, nalus: [[0xaa]] },
            { nalUnitType: 32, nalus: [[0xbb]] },
            { nalUnitType: 33, nalus: [[0xcc]] },
          ],
        }),
      ),
    );
    expect([...hvccToAnnexBPrologue(hvcc)]).toEqual([
      0, 0, 0, 1, 0xbb, // VPS
      0, 0, 0, 1, 0xcc, // SPS
      0, 0, 0, 1, 0xaa, // PPS
    ]);
  });

  it('rewrites length prefixes to start codes', () => {
    // Two NAL units, 4-byte length prefixes.
    const data = new Uint8Array([0, 0, 0, 2, 0x11, 0x22, 0, 0, 0, 3, 0x33, 0x44, 0x55]);
    expect([...lengthPrefixedToAnnexB(data, 4)]).toEqual([
      0, 0, 0, 1, 0x11, 0x22, 0, 0, 0, 1, 0x33, 0x44, 0x55,
    ]);
  });

  it('grows the buffer correctly for short length prefixes', () => {
    // 2-byte prefixes become 4-byte start codes, so the output is larger.
    const data = new Uint8Array([0, 2, 0x11, 0x22, 0, 1, 0x33]);
    expect([...lengthPrefixedToAnnexB(data, 2)]).toEqual([
      0, 0, 0, 1, 0x11, 0x22, 0, 0, 0, 1, 0x33,
    ]);
  });

  it('refuses a NAL length that runs past the payload', () => {
    const data = new Uint8Array([0, 0, 0, 99, 0x11]);
    expect(() => lengthPrefixedToAnnexB(data, 4)).toThrow(/past the end/);
  });

  it('refuses an impossible length size', () => {
    expect(() => lengthPrefixedToAnnexB(new Uint8Array(4), 0)).toThrow(/length size/);
    expect(() => lengthPrefixedToAnnexB(new Uint8Array(4), 5)).toThrow(/length size/);
  });
});
