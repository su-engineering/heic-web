import type { TransformOp } from '../plan.ts';
import type { TransformsApplied } from '../types.ts';
import { createCanvas } from './canvas.ts';

/**
 * Applies container transforms to a composited canvas, in the order given.
 *
 * Order is taken from the file's `ipma` associations rather than hardcoded (see
 * `readTransforms` in plan.ts). Each op produces a new canvas; the input is
 * released as it goes, so a 48 MP image never holds two full-size canvases plus
 * an intermediate at once.
 */
export function applyTransforms(
  source: OffscreenCanvas,
  transforms: readonly TransformOp[],
  colorSpace: PredefinedColorSpace,
): { canvas: OffscreenCanvas; applied: TransformsApplied } {
  let current = source;

  for (const op of transforms) {
    switch (op.kind) {
      case 'crop':
        current = release(current, crop(current, op, colorSpace), source);
        break;
      case 'rotate':
        current = release(current, rotate(current, op.angle, colorSpace), source);
        break;
      case 'mirror':
        current = release(current, mirror(current, op.axis, colorSpace), source);
        break;
    }
  }

  return { canvas: current, applied: summarizeTransforms(transforms) };
}

/**
 * The net effect of a transform list, without rendering anything.
 *
 * Strategies that apply transforms themselves (the browser's native decoder,
 * and any adapter declaring `appliesTransforms`) still have to report what was
 * applied. Deriving it here keeps that report identical to the render path's.
 */
export function summarizeTransforms(transforms: readonly TransformOp[]): TransformsApplied {
  const applied: TransformsApplied = { rotation: 0, mirrored: 'none', cropped: false };
  for (const op of transforms) {
    switch (op.kind) {
      case 'crop':
        applied.cropped = true;
        break;
      case 'rotate':
        applied.rotation = ((applied.rotation + op.angle) % 360) as TransformsApplied['rotation'];
        break;
      case 'mirror': {
        const direction = mirrorDirection(op.axis);
        // Two mirrors on the same axis cancel; on different axes they compose
        // into a 180 degree rotation. Tracking that keeps the report honest.
        if (applied.mirrored === 'none') applied.mirrored = direction;
        else if (applied.mirrored === direction) applied.mirrored = 'none';
        else {
          applied.mirrored = 'none';
          applied.rotation = ((applied.rotation + 180) % 360) as TransformsApplied['rotation'];
        }
        break;
      }
    }
  }
  return applied;
}

/**
 * `imir.axis` semantics, established by measurement rather than by reading.
 *
 *   axis = 0 -> mirror **vertically**: top and bottom are swapped
 *   axis = 1 -> mirror **horizontally**: left and right are swapped
 *
 * This is the single most commonly inverted detail in HEIF implementations, and
 * it is inverted in the obvious reading of the spec text. ISO/IEC 23008-12
 * describes `axis` as selecting "a vertical (axis = 0) or horizontal (axis = 1)
 * axis for the mirroring operation", which reads as naming the *axis of
 * reflection* — and reflecting about a vertical axis swaps left and right, the
 * exact opposite of what decoders actually do. Later wording in the standard
 * instead says the mirroring "is applied vertically" for axis 0, which is the
 * behaviour real decoders implement. Widely-copied blog posts follow the first
 * reading and are wrong.
 *
 * So this was measured instead of argued. `tools/inject-property.ts` forges a
 * fixture carrying each axis value, libheif renders it, and the render is
 * compared against an explicit flip of the untransformed image:
 *
 *   libheif imir=0  vs  top-bottom swap   MAE 0        <- exact match
 *   libheif imir=0  vs  left-right swap   MAE 10015.5
 *   libheif imir=1  vs  left-right swap   MAE 0        <- exact match
 *   libheif imir=1  vs  top-bottom swap   MAE 10015.5
 *
 * The fixtures live in test/fixtures/generated/asym-imir-{0,1}.heic and are
 * covered by the cross-strategy consistency test, so an inversion here fails the
 * suite rather than shipping.
 *
 * The names returned are the ones used in `TransformsApplied.mirrored`, in their
 * ordinary web sense: 'horizontal' is a left-right flip (CSS `scaleX(-1)`),
 * 'vertical' is a top-bottom flip.
 */
function mirrorDirection(axis: 0 | 1): 'horizontal' | 'vertical' {
  return axis === 0 ? 'vertical' : 'horizontal';
}

function crop(
  source: OffscreenCanvas,
  op: Extract<TransformOp, { kind: 'crop' }>,
  colorSpace: PredefinedColorSpace,
): OffscreenCanvas {
  const target = createCanvas(op.width, op.height);
  const ctx = context(target, colorSpace);
  ctx.drawImage(
    source,
    op.offsetX,
    op.offsetY,
    op.width,
    op.height,
    0,
    0,
    op.width,
    op.height,
  );
  return target;
}

/** `angle` is counter-clockwise, as stored in `irot`. */
function rotate(
  source: OffscreenCanvas,
  angle: 90 | 180 | 270,
  colorSpace: PredefinedColorSpace,
): OffscreenCanvas {
  const swap = angle === 90 || angle === 270;
  const target = createCanvas(
    swap ? source.height : source.width,
    swap ? source.width : source.height,
  );
  const ctx = context(target, colorSpace);

  // Canvas rotate() is clockwise for positive angles, so a counter-clockwise
  // irot angle is applied as its negation.
  ctx.translate(target.width / 2, target.height / 2);
  ctx.rotate((-angle * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return target;
}

function mirror(
  source: OffscreenCanvas,
  axis: 0 | 1,
  colorSpace: PredefinedColorSpace,
): OffscreenCanvas {
  const target = createCanvas(source.width, source.height);
  const ctx = context(target, colorSpace);
  if (mirrorDirection(axis) === 'horizontal') {
    ctx.translate(source.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, source.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(source, 0, 0);
  return target;
}

function context(
  canvas: OffscreenCanvas,
  colorSpace: PredefinedColorSpace,
): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { colorSpace, alpha: false });
  if (!ctx) throw new Error('Could not get a 2d context');
  return ctx;
}

/**
 * Frees an intermediate canvas once its successor exists.
 *
 * Setting the dimensions to zero is the portable way to release canvas backing
 * store; the original source canvas is left alone because the caller owns it.
 */
function release(
  previous: OffscreenCanvas,
  next: OffscreenCanvas,
  original: OffscreenCanvas,
): OffscreenCanvas {
  if (previous !== original) {
    previous.width = 0;
    previous.height = 0;
  }
  return next;
}
