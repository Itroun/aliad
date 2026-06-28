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
// Push apart any clusters whose label boxes actually overlap. Calm by virtue of
// being overlap-driven: in the steady state (no overlaps) nothing moves, so a
// settled field stays put — motion only happens to resolve a genuine collision
// (a cluster grew into a neighbour, or a merge landed two bodies close).
//
// `frozen[i]` marks an already-placed cluster. Two frozen clusters that collide
// DO separate (both share the push) — otherwise the overlap would be permanent.
// But a frozen cluster never yields to a brand-NEW neighbour: in a mixed pair the
// newcomer shoulders the whole push and relocates, so existing clusters don't
// twitch every time an act streams in. Returns net per-group displacement so the
// caller can fold it into the stored centre (else a moved cluster jumps back).
function separateClusters(groups, pos, side, frozen) {
  const MARGIN = 8;
  const disp = groups.map(() => ({ x: 0, y: 0 }));
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
        // Share weighting: in a frozen↔new pair the new one takes the full push
        // (wi=1, wj=0); otherwise split it evenly.
        let wi = 0.5;
        let wj = 0.5;
        if (frozen[i] !== frozen[j]) {
          wi = frozen[i] ? 0 : 1;
          wj = frozen[j] ? 0 : 1;
        }
        if (ox <= oy) {
          const dir = (a.x0 + a.x1) / 2 <= (b.x0 + b.x1) / 2 ? -1 : 1;
          push[i].x += dir * ox * wi;
          push[j].x -= dir * ox * wj;
        } else {
          const dir = (a.y0 + a.y1) / 2 <= (b.y0 + b.y1) / 2 ? -1 : 1;
          push[i].y += dir * oy * wi;
          push[j].y -= dir * oy * wj;
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
      disp[i].x += dx;
      disp[i].y += dy;
    }
  }
  return disp;
}

// Shortest distance from point p to segment a–b (and the closest point on it).
function pointSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return { dist: Math.hypot(p.x - cx, p.y - cy), cx, cy };
}

// Finalize-only feature-aware de-collision. Box separation guarantees clusters'
// bounding BOXES don't overlap, but a box is a loose container: a node of one
// cluster can still sit on an EDGE of another that cuts diagonally through the
// gap (the "Man With No Name on the Dado→Federico line" artifact). Here we look at
// the real geometry — every node vs every FOREIGN cluster's edges — and push the
// two clusters apart along the intrusion normal until each node clears foreign
// edges by `clearance`. Deliberately NOT run during streaming (its finer-grained
// triggers would add motion); it's a single settling pass once the walk ends.
// Returns net per-group displacement so callers can persist the moved centres.
function separateClusterFeatures(groups, pos, clearance) {
  const disp = groups.map(() => ({ x: 0, y: 0 }));
  for (let it = 0; it < 24; it++) {
    const push = groups.map(() => ({ x: 0, y: 0 }));
    let any = false;

    for (let i = 0; i < groups.length; i++) {
      for (let j = 0; j < groups.length; j++) {
        if (i === j || groups[j].edges.length === 0) continue;
        for (const name of groups[i].names) {
          const p = pos.get(name);
          for (const e of groups[j].edges) {
            const a = pos.get(e.a);
            const b = pos.get(e.b);
            if (!a || !b) continue;
            const { dist, cx, cy } = pointSegment(p, a, b);
            if (dist >= clearance) continue;
            any = true;
            // Push cluster i away from the edge (and j the opposite way), sharing
            // the shortfall so neither bears the whole move.
            let nx = p.x - cx;
            let ny = p.y - cy;
            const len = Math.hypot(nx, ny) || 1;
            nx /= len;
            ny /= len;
            const shortfall = (clearance - dist) * 0.5;
            push[i].x += nx * shortfall;
            push[i].y += ny * shortfall;
            push[j].x -= nx * shortfall;
            push[j].y -= ny * shortfall;
          }
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
      disp[i].x += dx;
      disp[i].y += dy;
    }
  }
  return disp;
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

// Place ONE cluster of radius `r` into the first free slot — sampled along rings
// of increasing radius around the canvas centre — that doesn't overlap any
// already-placed circle. This is the incremental, append-only replacement for
// the old global repack: existing clusters never move, a new cluster just slots
// into the nearest gap and is then frozen by the caller.
function placeOne(existing, r, width, height, gap) {
  const cx = width / 2;
  const cy = height / 2;
  // Pack into an ELLIPTICAL field whose aspect matches the (landscape) pane, so
  // the overall blob comes out wide rather than circular and the viewport's Fit
  // can use the horizontal space instead of leaving big left/right margins. We
  // stretch the sample ring on x and compress on y by √aspect (area-preserving),
  // so the content bbox aspect ≈ width/height. The overlap test below stays
  // CIRCULAR, so the minimum inter-cluster gap is identical in every direction —
  // only the macro-shape changes, neighbour spacing is untouched. Aspect is
  // clamped so an extreme window can't string clusters into a thin line.
  const aspect = Math.min(Math.max(width / height || 1, 1), 2.2);
  const ax = Math.sqrt(aspect);
  const ay = 1 / ax;
  // Reach well past the pane: layout lives in unbounded world space and the
  // viewport reframes, so a new cluster may legitimately land far out.
  const maxR = Math.hypot(width, height) + r * 6;
  const step = Math.max(20, r * 0.4);
  for (let ring = 0; ring <= maxR; ring += step) {
    const samples = ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * ring) / step));
    for (let s = 0; s < samples; s++) {
      const a = (s / samples) * 2 * Math.PI;
      const x = cx + Math.cos(a) * ring * ax;
      const y = cy + Math.sin(a) * ring * ay;
      let ok = true;
      for (const p of existing) {
        if (Math.hypot(x - p.centre.x, y - p.centre.y) < r + p.radius + gap) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, y };
    }
  }
  return { x: cx, y: cy };
}

export function createLayout({ width, height }) {
  // Local positions, stored in cluster-local coords (relative to cluster centre).
  const localPositions = new Map(); // name → { x, y, vx, vy }

  // Frozen inter-cluster placement, persisted across compute() calls. Each entry:
  // { members: Set<name>, centre: { x, y }, radius, angle }. Current clusters are
  // matched to these by member overlap so a cluster keeps its spot (and rotation)
  // as it grows; only genuinely-new clusters get a fresh slot. See
  // project_layout_incremental_placement memory for the full rationale.
  let placed = [];

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

  function compute({ clusters = [] }, iterations = 200, { settle = false } = {}) {
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
        names,
        edges,
        r: boundingRadius(nodeList, 44),
      });
    }

    // ── Incremental, append-only placement ────────────────────────────
    // Match each current cluster to a previously-placed one by member overlap and
    // reuse its centre + rotation (so it stays put as it grows); only genuinely-new
    // clusters get a fresh slot, which is then frozen. Process largest-first so on
    // a merge the biggest predecessor's spot wins, and on a split the biggest
    // surviving piece keeps the spot while the stranded piece is treated as new.
    const RESERVE = 40; // padding baked into the stored radius to absorb growth
    const GAP = 72; // uniform breathing gap between clusters
    const order = clusterInfos
      .map((_, i) => i)
      .sort((a, b) => clusterInfos[b].names.length - clusterInfos[a].names.length);

    const prev = placed;
    const claimed = new Set();
    const assign = new Array(clusterInfos.length); // idx → { centre, angle, radius, isNew }
    const placedSoFar = []; // { centre, radius } assigned this compute (for placeOne)

    for (const idx of order) {
      const info = clusterInfos[idx];
      // Best (largest-radius) unclaimed predecessor sharing at least one member.
      let best = null;
      let bestK = -1;
      for (let k = 0; k < prev.length; k++) {
        if (claimed.has(k)) continue;
        const p = prev[k];
        if (!info.names.some((n) => p.members.has(n))) continue;
        if (!best || p.radius > best.radius) {
          best = p;
          bestK = k;
        }
      }
      let centre;
      let angle;
      const isNew = !best;
      if (best) {
        claimed.add(bestK);
        centre = best.centre;
        angle = best.angle; // keep the frozen rotation — no per-growth snapping
      } else {
        centre = placeOne(placedSoFar, info.r + RESERVE, width, height, GAP);
        angle = clusterAngle(info.names);
      }
      const radius = Math.max(best?.radius ?? 0, info.r + RESERVE);
      assign[idx] = { centre, angle, radius, isNew };
      placedSoFar.push({ centre, radius });
    }

    // Convert to absolute WORLD positions from the assigned cluster centres. No
    // viewport clamp here — the layout lives in unbounded world space and the
    // pan/zoom viewport (graphScreen + viewport.js) fits it into the pane.
    const pos = new Map();
    const groups = [];
    const frozen = [];
    for (let idx = 0; idx < clusterInfos.length; idx++) {
      const info = clusterInfos[idx];
      const a = assign[idx];
      // Rotate the cluster by its frozen angle. Applied to a COPY (localPositions
      // stay un-rotated) so the rotation isn't compounded on the next recompute.
      const cos = Math.cos(a.angle);
      const sin = Math.sin(a.angle);
      for (const name of info.names) {
        const p = localPositions.get(name);
        pos.set(name, {
          x: a.centre.x + p.x * cos - p.y * sin,
          y: a.centre.y + p.x * sin + p.y * cos,
        });
      }
      groups.push({ names: info.names, edges: info.edges });
      frozen.push(!a.isNew);
    }

    // Decide label sides once, then nudge only NEW clusters whose labels/dots
    // overlap apart (frozen clusters stay put). Fold each nudge back into the
    // stored centre so a just-placed cluster doesn't jump once it freezes.
    const side = computeLabelSides(groups, allEdges, pos, width);
    // New objects (not in-place mutation): a frozen cluster's `centre` is shared
    // with the prior placed entry, so mutating it would clobber shared state.
    const disp = separateClusters(groups, pos, side, frozen);
    for (let idx = 0; idx < clusterInfos.length; idx++) {
      assign[idx].centre = {
        x: assign[idx].centre.x + disp[idx].x,
        y: assign[idx].centre.y + disp[idx].y,
      };
    }

    // Finalize-only: clear node↔foreign-edge intrusions the box pass can't see.
    // Run after box separation so it works from a non-overlapping starting point,
    // and fold its displacement into the centres too (so a later resize keeps the
    // cleaned-up layout).
    if (settle) {
      const fdisp = separateClusterFeatures(groups, pos, 24);
      for (let idx = 0; idx < clusterInfos.length; idx++) {
        assign[idx].centre = {
          x: assign[idx].centre.x + fdisp[idx].x,
          y: assign[idx].centre.y + fdisp[idx].y,
        };
      }
    }

    // Persist the frozen placement for the next compute.
    placed = clusterInfos.map((info, idx) => ({
      members: new Set(info.names),
      centre: assign[idx].centre,
      radius: assign[idx].radius,
      angle: assign[idx].angle,
    }));

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
