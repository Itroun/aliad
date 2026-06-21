// Per-cluster force-directed layout with non-overlapping circle packing.
// Each cluster runs its own sim in local space (no centering force) so the
// internal shape is stable; the cluster's bounding circle is then packed into
// the canvas alongside the others, guaranteeing no inter-cluster overlap.
// Node positions persist across calls so warm starts keep the layout stable
// as new artists arrive.

function stepCluster(nodes, edges, cfg) {
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
  // Weak pull toward local origin so the cluster stays compact around (0,0).
  for (const n of nodes) {
    n.fx += -n.x * cfg.kCenter;
    n.fy += -n.y * cfg.kCenter;
  }
  for (const n of nodes) {
    n.vx = (n.vx + n.fx) * cfg.damping;
    n.vy = (n.vy + n.fy) * cfg.damping;
    n.x += n.vx;
    n.y += n.vy;
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
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

export function createLayout({ width, height, padding = 80 }) {
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
      // Repulsion is raised (vs the original 12000) and centering lowered (vs
      // 0.02) so an appendage — a "leg" of nodes off one triangle vertex — is
      // pushed OUTWARD rather than folded back over the body by the centering
      // pull. But not too far: an earlier pass (kRep 20000 / kCenter 0.006) left
      // small clusters very flat/spread, so these are dialled back to a middle
      // ground. kCenter stays small-but-nonzero because some edges are suppressed
      // (triangle reduction, redundant bridges), making it the only force keeping
      // an edge-less node cohesive with its cluster.
      kRep: 13000,
      kSpring: 0.045,
      restLen: 138,
      kCenter: 0.013,
      damping: 0.82,
    };

    const clusterInfos = [];
    for (let ci = 0; ci < clusters.length; ci++) {
      const { nodes: names, edges = [] } = clusters[ci];
      names.forEach((name, i) => {
        if (!localPositions.has(name)) seedLocal(name, i);
      });
      const nodeList = names.map((n) => localPositions.get(n));
      const edgeIdx = edges
        .map(({ a, b }) => [names.indexOf(a), names.indexOf(b)])
        .filter(([i, j]) => i >= 0 && j >= 0);
      for (let it = 0; it < iterations; it++) stepCluster(nodeList, edgeIdx, cfg);
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

    // Convert to absolute positions. Clamp the whole cluster by its CENTRE (so it
    // stays on-canvas) rather than clamping each node — per-node clamping pinned
    // both nodes of an edge cluster to the same margin coordinate, flattening it
    // into a straight horizontal/vertical line. Centre-clamping preserves the
    // cluster's shape and angle. The min/max guards keep the range valid when a
    // cluster is larger than the canvas (falls back to the canvas centre).
    const out = new Map();
    for (const info of clusterInfos) {
      const centre = packed.get(info.id);
      const r = info.r;
      const cx = clamp(
        centre.x,
        Math.min(r + padding, width / 2),
        Math.max(width - r - padding, width / 2),
      );
      const cy = clamp(
        centre.y,
        Math.min(r + padding, height / 2),
        Math.max(height - r - padding, height / 2),
      );
      for (const name of info.names) {
        const p = localPositions.get(name);
        out.set(name, { x: cx + p.x, y: cy + p.y });
      }
    }
    return out;
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
