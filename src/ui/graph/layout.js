// Per-cluster force-directed layout with non-overlapping circle packing.
// Each cluster runs its own sim in local space (no centering force) so the
// internal shape is stable; the cluster's bounding circle is then packed into
// the canvas alongside the others, guaranteeing no inter-cluster overlap.
// Node positions persist across calls so warm starts keep the layout stable
// as new artists arrive.

function stepCluster(nodes, edges, cfg, deg) {
  for (const n of nodes) {
    n.fx = 0;
    n.fy = 0;
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = Math.max(dx * dx + dy * dy, 400);
      const d = Math.sqrt(d2);
      const f = cfg.kRep / d2;
      const ux = dx / d;
      const uy = dy / d;
      a.fx -= ux * f;
      a.fy -= uy * f;
      b.fx += ux * f;
      b.fy += uy * f;
    }
  }
  for (const [ia, ib] of edges) {
    const a = nodes[ia];
    const b = nodes[ib];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = cfg.kSpring * (d - cfg.restLen);
    const ux = dx / d;
    const uy = dy / d;
    a.fx += ux * f;
    a.fy += uy * f;
    b.fx -= ux * f;
    b.fy -= uy * f;
  }
  // Degree-aware pull toward the local origin. An EDGE-LESS node (its connecting
  // edges were suppressed by graph reduction) has no spring holding it to the
  // cluster, so it needs a firm centering pull to stay cohesive. A node WITH
  // edges is already held by its springs; giving it the same pull is what folds
  // tails/legs back over the cluster body and creates edge crossings — so it gets
  // a much weaker pull, letting appendages extend outward instead.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const kc = deg[i] === 0 ? cfg.kCenterFree : cfg.kCenterTied;
    n.fx += -n.x * kc;
    n.fy += -n.y * kc;
  }
  for (const n of nodes) {
    n.vx = (n.vx + n.fx) * cfg.damping;
    n.vy = (n.vy + n.fy) * cfg.damping;
    n.x += n.vx;
    n.y += n.vy;
  }
}

// Count edge-segment crossings in a laid-out cluster. Edges that share an
// endpoint can't "cross" in the sense we care about, so they're skipped. Used to
// pick the least-tangled layout among restart attempts.
function ccw(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}
function segmentsCross(p1, p2, p3, p4) {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}
function countCrossings(nodes, edges) {
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (segmentsCross(nodes[a], nodes[b], nodes[c], nodes[d])) count++;
    }
  }
  return count;
}

// Tiny deterministic PRNG (mulberry32) so restart seedings are reproducible —
// the same lineup always lays out the same way (stable across reloads + tests).
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A stable per-cluster orientation in [0, 2π), hashed from the node names. Every
// cluster is seeded from the same fixed golden-angle ring, so without this every
// 2-node cluster settles along the *same* line and they all render parallel.
// Rotating each cluster by its own hashed angle (a rigid transform — shape,
// distances and crossings are all preserved) spreads the orientations out and
// lets the de-collision pass nestle them together more tightly. Deterministic, so
// the layout stays stable across reloads.
function clusterAngle(names) {
  let h = 2166136261;
  for (const name of names) {
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return mulberry32(h)() * Math.PI * 2;
}

const RESTART_ATTEMPTS = 12;
const RESTART_ITERS = 250;

// Crossing-minimising restarts (mutates `nodes` in place). The warm layout is
// kept untouched when it's already crossing-free — so a settled cluster never
// jumps as new acts stream in. Only a tangled cluster is re-seeded: we try a few
// reproducible random starts, keep the least-crossing one, and never adopt a
// result worse than the warm layout. Skipped for clusters too small to cross
// (need ≥2 edges and ≥4 nodes for two non-adjacent edges to exist).
function relaxCrossings(nodes, edges, cfg, deg, clusterIdx) {
  if (edges.length < 2 || nodes.length < 4) return;
  let bestX = countCrossings(nodes, edges);
  if (bestX === 0) return;
  let best = nodes.map((n) => ({ x: n.x, y: n.y }));
  const rng = mulberry32((clusterIdx + 1) * 0x9e3779b1);
  for (let k = 0; k < RESTART_ATTEMPTS && bestX > 0; k++) {
    for (const n of nodes) {
      const a = rng() * Math.PI * 2;
      const r = 60 * (0.5 + rng());
      n.x = Math.cos(a) * r;
      n.y = Math.sin(a) * r;
      n.vx = 0;
      n.vy = 0;
    }
    for (let it = 0; it < RESTART_ITERS; it++) stepCluster(nodes, edges, cfg, deg);
    const x = countCrossings(nodes, edges);
    if (x < bestX) {
      bestX = x;
      best = nodes.map((n) => ({ x: n.x, y: n.y }));
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = best[i].x;
    nodes[i].y = best[i].y;
    nodes[i].vx = 0;
    nodes[i].vy = 0;
  }
}

// Cluster bounding radius from the dots alone (plus a small pad). Labels are
// deliberately NOT folded in here: doing so over-inflated long-named clusters
// and flung them to the canvas edges. Label spacing is handled by the uniform
// inter-cluster gap + edge-aware label placement in the renderer instead.
function boundingRadius(nodes, pad) {
  let maxDist = 0;
  for (const n of nodes) {
    const r = Math.hypot(n.x, n.y);
    if (r > maxDist) maxDist = r;
  }
  return maxDist + pad;
}

// Estimated rendered label width (13px sans, ~7px/char) plus the dot→label gap.
function estLabelW(name) {
  return 12 + String(name ?? '').length * 7.2;
}

// A node's screen footprint: the dot plus its label, which extends to one side.
function nodeBox(p, name, labelLeft) {
  const w = estLabelW(name);
  const DOT = 7;
  const H = 11;
  return {
    x0: labelLeft ? p.x - w : p.x - DOT,
    x1: labelLeft ? p.x + DOT : p.x + w,
    y0: p.y - H,
    y1: p.y + H,
  };
}

// Label side per node: place the label opposite the average direction of its
// edges (so it sits in the emptier space, off its own lines). Edge directions
// are intra-cluster, hence invariant under the rigid cluster moves the
// de-collision pass makes — so this can be computed once. No-edge nodes fall
// back to "toward canvas centre".
function computeLabelSides(groups, allEdges, pos, width) {
  const dir = new Map();
  for (const e of allEdges) {
    const pa = pos.get(e.a);
    const pb = pos.get(e.b);
    if (!pa || !pb) continue;
    dir.set(e.a, (dir.get(e.a) ?? 0) + (pb.x - pa.x));
    dir.set(e.b, (dir.get(e.b) ?? 0) + (pa.x - pb.x));
  }
  const side = new Map();
  for (const g of groups) {
    for (const name of g.names) {
      const d = dir.get(name);
      side.set(name, d ? d > 0 : pos.get(name).x > width * 0.55);
    }
  }
  return side;
}

// Label-aware cluster bounding box (union of its nodes' footprints + a margin).
function clusterAABB(names, pos, side, margin) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const name of names) {
    const b = nodeBox(pos.get(name), name, side.get(name));
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
}

// Post-layout de-collision: the circle packing only separates DOTS, so labels
// (and whole small clusters) can still overlap. Here we resolve the residual by
// pushing overlapping cluster boxes apart along their shortest axis, moving each
// cluster RIGIDLY so the force-laid shapes/angles are untouched. Converges by
// relaxation; capped iterations keep it cheap and bounded. Runs in UNBOUNDED
// world space — clusters spread as far as they need; the pan/zoom viewport
// (graphScreen + viewport.js) reframes the result, so there is no on-canvas clamp
// to pin clusters together when the lineup grows.
function separateClusters(groups, pos, side) {
  const MARGIN = 8;
  for (let it = 0; it < 30; it++) {
    const boxes = groups.map((g) => clusterAABB(g.names, pos, side, MARGIN));
    const push = groups.map(() => ({ x: 0, y: 0 }));
    let any = false;

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 0 || oy <= 0) continue;
        any = true;
        // Separate along the axis of least penetration.
        if (ox <= oy) {
          const s = ((a.x0 + a.x1) / 2 <= (b.x0 + b.x1) / 2 ? -1 : 1) * (ox / 2);
          push[i].x += s;
          push[j].x -= s;
        } else {
          const s = ((a.y0 + a.y1) / 2 <= (b.y0 + b.y1) / 2 ? -1 : 1) * (oy / 2);
          push[i].y += s;
          push[j].y -= s;
        }
      }
    }
    if (!any) break;

    for (let i = 0; i < groups.length; i++) {
      const dx = push[i].x * 0.5;
      const dy = push[i].y * 0.5;
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) continue;
      for (const name of groups[i].names) {
        const p = pos.get(name);
        p.x += dx;
        p.y += dy;
      }
    }
  }
}

// World-space AABB union across all clusters (label footprints included), used by
// the viewport to fit/centre the whole graph. Empty input yields null.
function contentBounds(groups, pos, side) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const g of groups) {
    const b = clusterAABB(g.names, pos, side, 0);
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

// Greedy circle packing: place the largest cluster at the canvas centre, then
// place each subsequent cluster at the first candidate position that doesn't
// overlap an already-placed circle. Candidates are sampled along rings of
// increasing radius around the centre.
function packClusters(circles, width, height, gap) {
  const placed = [];
  const cx = width / 2;
  const cy = height / 2;
  const sorted = [...circles].sort((a, b) => b.r - a.r);

  for (const c of sorted) {
    let best = null;
    const maxR = Math.hypot(width, height);
    const step = Math.max(20, c.r * 0.4);
    outer: for (let ring = 0; ring <= maxR; ring += step) {
      const samples = ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * ring) / step));
      for (let s = 0; s < samples; s++) {
        const a = (s / samples) * 2 * Math.PI;
        const x = cx + Math.cos(a) * ring;
        const y = cy + Math.sin(a) * ring;
        let ok = true;
        for (const p of placed) {
          const d = Math.hypot(x - p.x, y - p.y);
          if (d < c.r + p.r + gap) {
            ok = false;
            break;
          }
        }
        if (ok) {
          best = { x, y };
          break outer;
        }
      }
    }
    if (!best) best = { x: cx, y: cy };
    placed.push({ ...c, x: best.x, y: best.y });
  }
  const byId = new Map();
  for (const p of placed) byId.set(p.id, p);
  return byId;
}

export function createLayout({ width, height }) {
  // Local positions, stored in cluster-local coords (relative to cluster centre).
  const localPositions = new Map(); // name → { x, y, vx, vy }

  function seedLocal(name, indexInCluster) {
    // Place new nodes on a small ring so they don't stack at the origin.
    const r = 60;
    const a = (indexInCluster * 2.399) % (Math.PI * 2);
    localPositions.set(name, {
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      vx: 0,
      vy: 0,
    });
  }

  function compute({ clusters = [] }, iterations = 200) {
    const cfg = {
      // Repulsion is raised (vs the original 12000) so an appendage — a "leg" of
      // nodes off one triangle vertex — is pushed OUTWARD rather than folded back
      // over the body. Centering is now degree-aware (see stepCluster): edge-less
      // nodes get a firm pull to stay attached, edged nodes a near-zero one so
      // tails extend freely. The residual folding that survives the force sim is
      // mopped up by the crossing-minimising restarts below.
      kRep: 13000,
      kSpring: 0.045,
      restLen: 138,
      kCenterFree: 0.05, // edge-less nodes: hold them to the cluster
      kCenterTied: 0.002, // edged nodes: barely centre, let legs unfold
      damping: 0.82,
    };

    const clusterInfos = [];
    const allEdges = [];
    for (let ci = 0; ci < clusters.length; ci++) {
      const { nodes: names, edges = [] } = clusters[ci];
      for (const e of edges) allEdges.push(e);
      names.forEach((name, i) => {
        if (!localPositions.has(name)) seedLocal(name, i);
      });
      const nodeList = names.map((n) => localPositions.get(n));
      const edgeIdx = edges
        .map(({ a, b }) => [names.indexOf(a), names.indexOf(b)])
        .filter(([i, j]) => i >= 0 && j >= 0);
      const deg = nodeList.map(() => 0);
      for (const [i, j] of edgeIdx) {
        deg[i]++;
        deg[j]++;
      }
      for (let it = 0; it < iterations; it++) stepCluster(nodeList, edgeIdx, cfg, deg);

      // Untangle: the force sim can settle a planar cluster into a folded local
      // minimum with crossing edges (even a simple path can). Warm layouts that
      // are already crossing-free are kept as-is (so streaming stays calm); only
      // a tangled cluster is re-seeded — we try a few reproducible random starts
      // and adopt the least-crossing result, never worse than the warm layout.
      relaxCrossings(nodeList, edgeIdx, cfg, deg, ci);

      // Re-centre cluster on its centroid so packing is symmetric.
      let mx = 0;
      let my = 0;
      for (const n of nodeList) {
        mx += n.x;
        my += n.y;
      }
      mx /= nodeList.length || 1;
      my /= nodeList.length || 1;
      for (const n of nodeList) {
        n.x -= mx;
        n.y -= my;
      }
      clusterInfos.push({
        id: `c${ci}`,
        names,
        r: boundingRadius(nodeList, 44),
      });
    }

    // Uniform breathing gap between clusters — gives labels some room without the
    // per-cluster radius inflation that pushed clusters to the canvas edges.
    const packed = packClusters(clusterInfos, width, height, 72);

    // Convert to absolute WORLD positions from the packed cluster centres. No
    // viewport clamp here — the layout lives in unbounded world space and the
    // pan/zoom viewport (graphScreen + viewport.js) fits it into the pane. The
    // packed centres are seeded around the pane size only as a starting spread.
    const pos = new Map();
    const groups = [];
    for (const info of clusterInfos) {
      const centre = packed.get(info.id);
      // Rotate the cluster by its own hashed angle so orientations vary. Applied
      // to a COPY (localPositions stay un-rotated) so the rotation isn't compounded
      // on the next warm-started recompute.
      const theta = clusterAngle(info.names);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      for (const name of info.names) {
        const p = localPositions.get(name);
        pos.set(name, {
          x: centre.x + p.x * cos - p.y * sin,
          y: centre.y + p.x * sin + p.y * cos,
        });
      }
      groups.push({ id: info.id, names: info.names });
    }

    // Decide label sides once, then nudge any clusters whose labels/dots still
    // overlap apart (the circle packing only separated dots, not labels).
    const side = computeLabelSides(groups, allEdges, pos, width);
    separateClusters(groups, pos, side);

    // Emit world positions + the label side. Label-side choice is final here
    // (no canvas-edge flip): clusters are no longer pinned to the pane, so a
    // label can't clip against a fixed edge — the viewport reframes everything.
    const positions = new Map();
    for (const g of groups) {
      for (const name of g.names) {
        const p = pos.get(name);
        positions.set(name, { x: p.x, y: p.y, labelLeft: side.get(name) });
      }
    }
    return { positions, bounds: contentBounds(groups, pos, side) };
  }

  function resize(dims) {
    if (dims.width) width = dims.width;
    if (dims.height) height = dims.height;
  }

  function drop(name) {
    localPositions.delete(name);
  }

  return { compute, resize, drop };
}
