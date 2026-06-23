// Pure viewport transform math for the graph pane. A viewport is a screen-space
// affine map (uniform scale + translation): screen = world * k + (tx, ty).
// Kept DOM-free so it's unit-testable, mirroring src/core/tokenBucket.js.

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2.5;

function clampScale(k, min = MIN_SCALE, max = MAX_SCALE) {
  return Math.max(min, Math.min(max, k));
}

// Fit a world-space AABB into a pane, centred, scaled up to `maxScale` (so a
// tiny graph isn't blown up past 1:1-ish). Returns { k, tx, ty }. Degenerate
// bounds (no content) fall back to identity centred on the pane.
export function computeFitTransform(bounds, paneW, paneH, { padding = 48, maxScale = 1.4 } = {}) {
  if (!bounds || !(paneW > 0) || !(paneH > 0)) return { k: 1, tx: 0, ty: 0 };
  const contentW = Math.max(bounds.x1 - bounds.x0, 1);
  const contentH = Math.max(bounds.y1 - bounds.y0, 1);
  const availW = Math.max(paneW - padding * 2, 1);
  const availH = Math.max(paneH - padding * 2, 1);
  const k = clampScale(Math.min(availW / contentW, availH / contentH), MIN_SCALE, maxScale);
  // Map the content centre to the pane centre: tx = paneCx - worldCx * k.
  const worldCx = (bounds.x0 + bounds.x1) / 2;
  const worldCy = (bounds.y0 + bounds.y1) / 2;
  return { k, tx: paneW / 2 - worldCx * k, ty: paneH / 2 - worldCy * k };
}

// Zoom by `factor` while keeping the world point currently under screen (sx, sy)
// pinned there. Solving s = w*k + t for w (invariant) gives t' = s - (s - t)*(k'/k).
export function zoomAtPoint(vp, sx, sy, factor, { min = MIN_SCALE, max = MAX_SCALE } = {}) {
  const k2 = clampScale(vp.k * factor, min, max);
  const ratio = k2 / vp.k;
  return {
    k: k2,
    tx: sx - (sx - vp.tx) * ratio,
    ty: sy - (sy - vp.ty) * ratio,
  };
}
