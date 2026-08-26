import { describe, expect, it } from 'vitest';
import { HeicParseError } from '../../src/errors.ts';
import { childBoxes, MAX_BOX_DEPTH, walkBoxes } from '../../src/parser/boxes.ts';
import { Reader } from '../../src/parser/reader.ts';

/** Builds a box: 32-bit size, four-character type, payload. */
function box(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

describe('walkBoxes', () => {
  it('walks siblings in order', () => {
    const data = concat(box('ftyp', new Uint8Array([1, 2])), box('meta'), box('mdat'));
    expect(childBoxes(new Reader(data)).map((b) => b.type)).toEqual(['ftyp', 'meta', 'mdat']);
  });

  it('handles a 64-bit largesize header', () => {
    const payload = new Uint8Array([9, 9, 9, 9]);
    const out = new Uint8Array(16 + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, 1); // size == 1 means "read a 64-bit largesize"
    for (let i = 0; i < 4; i++) out[4 + i] = 'mdat'.charCodeAt(i);
    view.setBigUint64(8, BigInt(out.byteLength));
    out.set(payload, 16);

    const [parsed] = childBoxes(new Reader(out));
    expect(parsed!.type).toBe('mdat');
    expect(parsed!.headerSize).toBe(16);
    expect(parsed!.body.length).toBe(4);
  });

  it('treats size 0 as "extends to the end of the container"', () => {
    const out = new Uint8Array(8 + 6);
    for (let i = 0; i < 4; i++) out[4 + i] = 'mdat'.charCodeAt(i);
    // size stays 0
    const [parsed] = childBoxes(new Reader(out));
    expect(parsed!.size).toBe(14);
    expect(parsed!.body.length).toBe(6);
  });

  it('rejects a box smaller than its own header', () => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setUint32(0, 4); // impossible: header alone is 8
    expect(() => childBoxes(new Reader(out))).toThrow(HeicParseError);
  });

  it('rejects a box that runs past its container', () => {
    const out = box('mdat', new Uint8Array(4));
    new DataView(out.buffer).setUint32(0, 9999);
    expect(() => childBoxes(new Reader(out))).toThrow(/past its container/);
  });

  it('stops cleanly at a truncated box in lenient mode', () => {
    const truncated = concat(box('ftyp'), box('meta', new Uint8Array(4)).subarray(0, 6));
    expect(() => childBoxes(new Reader(truncated))).not.toThrow();
    expect(childBoxes(new Reader(truncated), { lenient: true }).map((b) => b.type)).toEqual(['ftyp']);
  });

  it('caps nesting depth', () => {
    // A container nested past the limit must fail rather than recurse.
    let nested = box('leaf');
    for (let i = 0; i < MAX_BOX_DEPTH + 2; i++) nested = box('cont', nested);

    const walk = (reader: Reader, depth: number): void => {
      for (const child of walkBoxes(reader, depth)) {
        if (child.type === 'cont') walk(child.body, depth + 1);
      }
    };
    expect(() => walk(new Reader(nested), 0)).toThrow(/nesting deeper than/);
  });

  it('a partially-read box body cannot desynchronise the walk', () => {
    const data = concat(box('aaaa', new Uint8Array([1, 2, 3, 4])), box('bbbb'));
    const types: string[] = [];
    for (const child of walkBoxes(new Reader(data))) {
      types.push(child.type);
      // Consume only some of the payload, as a real parser routinely does.
      if (child.type === 'aaaa') child.body.u8();
    }
    expect(types).toEqual(['aaaa', 'bbbb']);
  });

  it('refuses an unbounded run of empty sibling boxes', () => {
    // 8-byte payload-free boxes are the cheapest way to make a walker spin.
    const many = concat(...Array.from({ length: 70_000 }, () => box('free')));
    expect(() => childBoxes(new Reader(many))).toThrow(/sibling boxes/);
  });
});
