import { describe, it, expect } from 'vitest';
import {
  computeFitTransform,
  zoomAtPoint,
  MIN_SCALE,
  MAX_SCALE,
} from '../src/ui/graph/viewport.js';

const apply = (vp, x, y) => ({ x: x * vp.k + vp.tx, y: y * vp.k + vp.ty });

describe('computeFitTransform', () => {
  it('centres the content in the pane', () => {
    const bounds = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const vp = computeFitTransform(bounds, 800, 600, { padding: 0, maxScale: 10 });
    const centre = apply(vp, 50, 50);
    expect(centre.x).toBeCloseTo(400);
    expect(centre.y).toBeCloseTo(300);
  });

  it('scales the limiting axis to fit within the padded pane', () => {
    // Wide content: width is the binding constraint.
    const bounds = { x0: 0, y0: 0, x1: 1000, y1: 100 };
    const vp = computeFitTransform(bounds, 500, 500, { padding: 50, maxScale: 10 });
    // avail width 400 / content 1000 = 0.4
    expect(vp.k).toBeCloseTo(0.4);
    const tl = apply(vp, 0, 0);
    const br = apply(vp, 1000, 100);
    expect(br.x - tl.x).toBeCloseTo(400); // fits the available width
  });

  it('does not blow a tiny graph up past maxScale', () => {
    const bounds = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const vp = computeFitTransform(bounds, 800, 600, { padding: 0, maxScale: 1.4 });
    expect(vp.k).toBe(1.4);
  });

  it('returns identity for degenerate input', () => {
    expect(computeFitTransform(null, 800, 600)).toEqual({ k: 1, tx: 0, ty: 0 });
    expect(computeFitTransform({ x0: 0, y0: 0, x1: 1, y1: 1 }, 0, 600)).toEqual({
      k: 1,
      tx: 0,
      ty: 0,
    });
  });
});

describe('zoomAtPoint', () => {
  it('keeps the world point under the cursor fixed', () => {
    const vp = { k: 1, tx: 0, ty: 0 };
    const sx = 300;
    const sy = 200;
    const worldBefore = { x: (sx - vp.tx) / vp.k, y: (sy - vp.ty) / vp.k };
    const zoomed = zoomAtPoint(vp, sx, sy, 1.5);
    const screenAfter = apply(zoomed, worldBefore.x, worldBefore.y);
    expect(screenAfter.x).toBeCloseTo(sx);
    expect(screenAfter.y).toBeCloseTo(sy);
    expect(zoomed.k).toBeCloseTo(1.5);
  });

  it('clamps scale to the allowed range', () => {
    const inHi = zoomAtPoint({ k: MAX_SCALE, tx: 0, ty: 0 }, 0, 0, 4);
    expect(inHi.k).toBe(MAX_SCALE);
    const inLo = zoomAtPoint({ k: MIN_SCALE, tx: 0, ty: 0 }, 0, 0, 0.01);
    expect(inLo.k).toBe(MIN_SCALE);
  });
});
