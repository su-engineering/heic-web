import { describe, expect, it } from 'vitest';
import { HeicParseError } from '../../src/errors.ts';
import { Reader } from '../../src/parser/reader.ts';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('Reader', () => {
  it('reads big-endian integers', () => {
    const r = new Reader(bytes(0x12, 0x34, 0x56, 0x78, 0x9a));
    expect(r.u8()).toBe(0x12);
    expect(r.u16()).toBe(0x3456);
    expect(r.u8()).toBe(0x78);
    expect(r.u8()).toBe(0x9a);
    expect(r.eof).toBe(true);
  });

  it('reads u24 without sign trouble on the high bit', () => {
    expect(new Reader(bytes(0xff, 0xff, 0xff)).u24()).toBe(0xffffff);
    expect(new Reader(bytes(0x80, 0x00, 0x00)).u24()).toBe(0x800000);
  });

  it('reads u32 as unsigned', () => {
    expect(new Reader(bytes(0xff, 0xff, 0xff, 0xff)).u32()).toBe(4_294_967_295);
  });

  // Every one of these is a potential heap overflow in a language without
  // bounds checks, and a silently wrong image in one with them.
  describe('bounds checking', () => {
    it('refuses a read past the end', () => {
      const r = new Reader(bytes(1, 2, 3));
      expect(() => r.u32()).toThrow(HeicParseError);
    });

    it('refuses a seek past the end', () => {
      const r = new Reader(bytes(1, 2, 3));
      expect(() => r.seek(4)).toThrow(HeicParseError);
    });

    it('refuses a negative or non-finite length', () => {
      const r = new Reader(bytes(1, 2, 3));
      expect(() => r.require(-1)).toThrow(HeicParseError);
      expect(() => r.require(Number.NaN)).toThrow(HeicParseError);
      expect(() => r.require(Number.POSITIVE_INFINITY)).toThrow(HeicParseError);
    });

    it('refuses a window outside the source buffer', () => {
      expect(() => new Reader(bytes(1, 2, 3), 0, 4)).toThrow(HeicParseError);
      expect(() => new Reader(bytes(1, 2, 3), 4)).toThrow(HeicParseError);
    });

    it('refuses a 64-bit value above the safe integer range', () => {
      // A declared size of 2^63 must fail here, not in the allocator.
      const huge = bytes(0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
      expect(() => new Reader(huge).u64()).toThrow(HeicParseError);
    });

    it('accepts a 64-bit value inside the safe integer range', () => {
      const ok = bytes(0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00);
      expect(new Reader(ok).u64()).toBe(65_536);
    });

    it('sub() cannot escape its parent window', () => {
      const r = new Reader(bytes(1, 2, 3, 4));
      expect(() => r.sub(5)).toThrow(HeicParseError);
      const child = r.sub(2);
      expect(child.length).toBe(2);
      expect(() => child.u32()).toThrow(HeicParseError);
    });
  });

  it('escapes non-printable bytes in a fourCC so errors stay readable', () => {
    expect(new Reader(bytes(0x00, 0x01, 0x66, 0x74)).fourCC()).toBe('\\x00\\x01ft');
  });

  it('stops a cString at the window end when the NUL is missing', () => {
    const r = new Reader(new TextEncoder().encode('abc'));
    expect(r.cString()).toBe('abc');
    expect(r.eof).toBe(true);
  });

  it('uint() supports only the widths iloc can declare', () => {
    const r = new Reader(bytes(1, 2, 3, 4, 5, 6, 7, 8));
    expect(r.uint(0)).toBe(0);
    expect(() => new Reader(bytes(1, 2, 3)).uint(3)).toThrow(HeicParseError);
    expect(() => new Reader(bytes(1, 2, 3)).uint(16)).toThrow(HeicParseError);
  });
});
