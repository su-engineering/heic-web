import { HeicParseError } from '../errors.ts';

/**
 * Bounds-checked big-endian byte reader.
 *
 * Every single read validates against the window before touching the buffer.
 * This is the only place in the package that indexes raw bytes, so the security
 * guarantee is enforceable by review: if it isn't going through Reader, it isn't
 * reading the file.
 *
 * A Reader is a *window* onto a shared ArrayBuffer, not a copy. Sub-readers for
 * nested boxes are free.
 */
export class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** Absolute offset of this window's start within the underlying ArrayBuffer. */
  readonly base: number;
  /** Cursor, relative to the window start. */
  private pos = 0;

  constructor(source: ArrayBuffer | Uint8Array, byteOffset = 0, byteLength?: number) {
    const u8 = source instanceof Uint8Array ? source : new Uint8Array(source);
    const start = u8.byteOffset + byteOffset;
    const length = byteLength ?? u8.byteLength - byteOffset;
    if (byteOffset < 0 || length < 0 || byteOffset + length > u8.byteLength) {
      throw new HeicParseError('Reader window is outside the source buffer', {
        offset: byteOffset,
      });
    }
    this.bytes = new Uint8Array(u8.buffer, start, length);
    this.view = new DataView(u8.buffer, start, length);
    this.base = start;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get offset(): number {
    return this.pos;
  }

  /** Absolute offset of the cursor in the underlying buffer, for error reports. */
  get absoluteOffset(): number {
    return this.base + this.pos;
  }

  get remaining(): number {
    return this.length - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.length;
  }

  seek(to: number): void {
    this.require(0, to);
    this.pos = to;
  }

  skip(count: number): void {
    this.require(count);
    this.pos += count;
  }

  /**
   * Throws unless `count` bytes are readable at `at` (default: the cursor).
   * Callers that are about to allocate should call this first with the declared
   * size, so a hostile length field fails here rather than in the allocator.
   */
  require(count: number, at = this.pos): void {
    if (!Number.isFinite(count) || count < 0 || !Number.isFinite(at) || at < 0) {
      throw new HeicParseError('Malformed read request', { offset: this.base + this.pos });
    }
    if (at + count > this.length) {
      throw new HeicParseError(
        `Read of ${count} bytes at ${at} exceeds the ${this.length}-byte window`,
        { offset: this.base + at },
      );
    }
  }

  u8(): number {
    this.require(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.require(2);
    const value = this.view.getUint16(this.pos);
    this.pos += 2;
    return value;
  }

  u24(): number {
    this.require(3);
    const value =
      (this.view.getUint8(this.pos) << 16) |
      (this.view.getUint8(this.pos + 1) << 8) |
      this.view.getUint8(this.pos + 2);
    this.pos += 3;
    return value >>> 0;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.pos);
    this.pos += 4;
    return value >>> 0;
  }

  /**
   * Returns a JS number, not a BigInt. Values above Number.MAX_SAFE_INTEGER are
   * rejected rather than silently losing precision — a 9-petabyte box size is a
   * malformed file, not something to accommodate.
   */
  u64(): number {
    this.require(8);
    const value = this.view.getBigUint64(this.pos);
    this.pos += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HeicParseError('64-bit value exceeds the safe integer range', {
        offset: this.base + this.pos - 8,
      });
    }
    return Number(value);
  }

  /** Reads a big-endian unsigned integer of 0, 1, 2, 4 or 8 bytes. `iloc` needs this. */
  uint(byteCount: number): number {
    switch (byteCount) {
      case 0:
        return 0;
      case 1:
        return this.u8();
      case 2:
        return this.u16();
      case 4:
        return this.u32();
      case 8:
        return this.u64();
      default:
        throw new HeicParseError(`Unsupported integer width: ${byteCount} bytes`, {
          offset: this.base + this.pos,
        });
    }
  }

  /** Four-character box type. Non-printable bytes are escaped so error messages stay readable. */
  fourCC(): string {
    this.require(4);
    let out = '';
    for (let i = 0; i < 4; i++) {
      const byte = this.view.getUint8(this.pos + i);
      out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
    }
    this.pos += 4;
    return out;
  }

  /** NUL-terminated UTF-8 string. Stops at the window end if the NUL is missing. */
  cString(): string {
    const start = this.pos;
    while (this.pos < this.length && this.bytes[this.pos] !== 0) this.pos++;
    const raw = this.bytes.subarray(start, this.pos);
    if (this.pos < this.length) this.pos++; // consume the NUL
    return new TextDecoder().decode(raw);
  }

  /** A view onto the next `count` bytes. No copy — do not retain past the buffer's life. */
  view_(count: number): Uint8Array {
    this.require(count);
    const out = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  /** A copy of the next `count` bytes. Use when the result outlives the source buffer. */
  copy(count: number): Uint8Array {
    return new Uint8Array(this.view_(count));
  }

  /** A sub-reader over `count` bytes, advancing this reader past them. */
  sub(count: number): Reader {
    this.require(count);
    const child = new Reader(this.bytes, this.pos, count);
    this.pos += count;
    return child;
  }

  /** A sub-reader over the rest of the window, without advancing this reader. */
  peekRest(): Reader {
    return new Reader(this.bytes, this.pos, this.remaining);
  }
}

/** FullBox header: 8-bit version, 24-bit flags. */
export interface FullBoxHeader {
  version: number;
  flags: number;
}

export function readFullBoxHeader(reader: Reader): FullBoxHeader {
  const version = reader.u8();
  const flags = reader.u24();
  return { version, flags };
}
