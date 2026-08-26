import { HeicParseError } from '../errors.ts';
import { Reader } from './reader.ts';

/** Hard cap on box nesting. A legitimate HEIF tree is ~4 deep; 32 is generous. */
export const MAX_BOX_DEPTH = 32;

/**
 * A cap on how many sibling boxes we will walk at one level. Without it, a file
 * full of zero-payload 8-byte boxes turns into an unbounded loop over the whole
 * buffer. 64k siblings is far past any real file.
 */
export const MAX_SIBLING_BOXES = 65_536;

export interface Box {
  type: string;
  /** Absolute offset of the box header in the source buffer. */
  offset: number;
  /** Total box size including its header. */
  size: number;
  /** Size of the header (8, 16 for largesize). */
  headerSize: number;
  /** A reader positioned at the start of the box payload, windowed to its end. */
  body: Reader;
}

/**
 * Walks the boxes in `reader`'s window, yielding each in turn.
 *
 * Each yielded box carries its own body reader, so a consumer that only cares
 * about `meta` costs nothing for the megabytes of `mdat` next to it.
 */
export interface WalkOptions {
  depth?: number;
  /**
   * Stop cleanly at the first box that runs past the end of the window instead
   * of throwing. Detection is handed only the first few KB of a file, where a
   * truncated trailing box is expected rather than a sign of corruption.
   */
  lenient?: boolean;
}

export function* walkBoxes(reader: Reader, options: WalkOptions | number = {}): Generator<Box> {
  const { depth = 0, lenient = false } =
    typeof options === 'number' ? { depth: options, lenient: false } : options;
  if (depth > MAX_BOX_DEPTH) {
    throw new HeicParseError(`Box nesting deeper than ${MAX_BOX_DEPTH}`, {
      offset: reader.absoluteOffset,
    });
  }

  let count = 0;
  while (reader.remaining >= 8) {
    if (++count > MAX_SIBLING_BOXES) {
      throw new HeicParseError(`More than ${MAX_SIBLING_BOXES} sibling boxes at one level`, {
        offset: reader.absoluteOffset,
      });
    }

    const offset = reader.absoluteOffset;
    const start = reader.offset;
    let size = reader.u32();
    const type = reader.fourCC();
    let headerSize = 8;

    if (size === 1) {
      size = reader.u64();
      headerSize = 16;
    } else if (size === 0) {
      // "extends to the end of the enclosing container"
      size = reader.length - start;
    }

    if (size < headerSize) {
      if (lenient) return;
      throw new HeicParseError(`Box size ${size} is smaller than its ${headerSize}-byte header`, {
        offset,
        box: type,
      });
    }
    if (start + size > reader.length) {
      if (lenient) return;
      throw new HeicParseError(
        `Box extends ${start + size - reader.length} bytes past its container`,
        { offset, box: type },
      );
    }

    const payloadSize = size - headerSize;
    const body = reader.sub(payloadSize);
    yield { type, offset, size, headerSize, body };

    // Boxes are consumed via `body`, whose cursor the caller may have moved.
    // Reposition absolutely so a partially-read box cannot desynchronise the walk.
    reader.seek(start + size);
  }
}

/** Collects the child boxes of a container into an array. */
export function childBoxes(reader: Reader, options: WalkOptions | number = {}): Box[] {
  return [...walkBoxes(reader, options)];
}

/** Returns the first child box of the given type, or undefined. */
export function findBox(boxes: readonly Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

/** Returns every child box of the given type. */
export function findBoxes(boxes: readonly Box[], type: string): Box[] {
  return boxes.filter((box) => box.type === type);
}
