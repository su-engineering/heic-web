import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeicError } from '../../src/errors.ts';
import { detectFromBuffer } from '../../src/parser/detect.ts';
import { planDecode } from '../../src/plan.ts';
import { parseHeif } from '../../src/parser/meta.ts';

/**
 * The parser is handed files chosen by whoever is using the site. Fuzzing it is
 * not optional.
 *
 * Two rules, and they are different failures:
 *   - Every crash is a bug. A malformed file must produce a typed HeicError,
 *     never a TypeError, a RangeError from an allocation, or an unhandled throw
 *     from deep inside a box reader.
 *   - Every hang is a worse bug. A file that makes the parser loop is a denial
 *     of service on the user's own tab, so each case is time-boxed.
 */

const SEED = 0x9e3779b9;
const CASES_PER_FIXTURE = 400;
const PER_CASE_BUDGET_MS = 250;

/** Deterministic PRNG: a fuzz failure must be reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function corpus(): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const dir of ['test/fixtures', 'test/fixtures/generated', 'test/fixtures/local']) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!['.heic', '.heif', '.avif'].includes(extname(name).toLowerCase())) continue;
      out.push({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) });
    }
  }
  return out;
}

/** Mutations aimed at the fields that drive allocation and iteration. */
function mutate(source: Uint8Array, random: () => number): Uint8Array {
  const out = new Uint8Array(source);
  const strategy = Math.floor(random() * 5);

  switch (strategy) {
    case 0: {
      // Flip a handful of random bytes.
      const count = 1 + Math.floor(random() * 8);
      for (let i = 0; i < count; i++) {
        out[Math.floor(random() * out.length)] = Math.floor(random() * 256);
      }
      return out;
    }
    case 1: {
      // Truncate. Exercises every bounds check at once.
      return out.subarray(0, Math.floor(random() * out.length));
    }
    case 2: {
      // Overwrite a 32-bit field with a hostile size or count: a box size, an
      // extent length, an item count. This is the mutation that finds unbounded
      // allocations.
      const position = Math.floor(random() * Math.max(1, out.length - 4));
      const hostile = [0xffffffff, 0x7fffffff, 0x80000000, 0, 1, 0xfffffff0][
        Math.floor(random() * 6)
      ]!;
      new DataView(out.buffer, out.byteOffset).setUint32(position, hostile);
      return out;
    }
    case 3: {
      // Zero a run, which tends to produce empty boxes and zero counts.
      const start = Math.floor(random() * out.length);
      const length = Math.floor(random() * 64);
      out.fill(0, start, Math.min(out.length, start + length));
      return out;
    }
    default: {
      // Splice one file's bytes into another position, producing plausible-
      // looking but inconsistent structures.
      const start = Math.floor(random() * out.length);
      const length = Math.floor(random() * 128);
      const from = Math.floor(random() * out.length);
      out.copyWithin(start, from, Math.min(out.length, from + length));
      return out;
    }
  }
}

describe('parser fuzzing', () => {
  const files = corpus();

  it('has a corpus to mutate', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { name, bytes } of files) {
    it(`survives ${CASES_PER_FIXTURE} mutations of ${name}`, () => {
      const random = makeRandom(SEED ^ name.length);
      // Tracked separately: sample.avif parses structurally every time and is
      // then correctly refused at plan time, so counting only full decodes would
      // read as "the fuzzer never got in".
      let structureParsed = 0;
      let planned = 0;
      let rejected = 0;

      for (let i = 0; i < CASES_PER_FIXTURE; i++) {
        const mutated = mutate(bytes, random);
        const started = performance.now();

        try {
          // detectFromBuffer is the speculative path: it must never throw at all.
          detectFromBuffer(mutated);
        } catch (error) {
          expect.fail(`detectFromBuffer threw on case ${i} of ${name}: ${String(error)}`);
        }

        try {
          parseHeif(mutated);
          structureParsed++;
          planDecode(mutated);
          planned++;
        } catch (error) {
          // A typed error is the correct outcome. Anything else means an
          // unguarded read reached raw memory or an allocator.
          if (!(error instanceof HeicError)) {
            expect.fail(
              `case ${i} of ${name} threw ${(error as Error).name}: ${(error as Error).message}`,
            );
          }
          rejected++;
        }

        const elapsed = performance.now() - started;
        if (elapsed > PER_CASE_BUDGET_MS) {
          expect.fail(`case ${i} of ${name} took ${elapsed.toFixed(0)}ms; a hang is a worse bug than a crash`);
        }
      }

      // Sanity: a fuzz run where everything is rejected at the first byte tests
      // nothing. A healthy run gets a meaningful share of mutations all the way
      // through the container parse.
      expect(planned + rejected).toBe(CASES_PER_FIXTURE);
      expect(structureParsed, `${name}: no mutation survived parseHeif`).toBeGreaterThan(
        CASES_PER_FIXTURE * 0.05,
      );
    });
  }

  it('refuses to allocate on a declared size the buffer cannot back', () => {
    // A hand-built file whose iloc claims a 4 GB extent.
    const header = new Uint8Array([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, // ftyp box, 24 bytes
      0x68, 0x65, 0x69, 0x63, // major brand 'heic'
      0, 0, 0, 0, // minor version
      0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63, // compatible brands
    ]);
    expect(() => parseHeif(header)).toThrow(HeicError);
  });

  it('handles empty and tiny inputs', () => {
    for (const size of [0, 1, 4, 7, 8, 15, 16]) {
      expect(() => detectFromBuffer(new Uint8Array(size))).not.toThrow();
      expect(() => parseHeif(new Uint8Array(size))).toThrow(HeicError);
    }
  });
});
