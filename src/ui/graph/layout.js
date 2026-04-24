// Small home-grown force-directed layout.
// Repulsion between every pair + edge springs + weak centering + velocity damping.
// Positions persist across calls so the sim can be warm-started when nodes/edges
// arrive incrementally — just call compute() again with the new names/edges.

function stepForces(nodes, edges, cfg) {
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
  for (const n of nodes) {
    n.fx += (cfg.cx - n.x) * cfg.kCenter;
    n.fy += (cfg.cy - n.y) * cfg.kCenter;
  }
  for (const n of nodes) {
    n.vx = (n.vx + n.fx) * cfg.damping;
    n.vy = (n.vy + n.fy) * cfg.damping;
    n.x += n.vx;
    n.y += n.vy;
    if (n.x < cfg.padding) n.x = cfg.padding;
    if (n.y < cfg.padding) n.y = cfg.padding;
    if (n.x > cfg.width - cfg.padding) n.x = cfg.width - cfg.padding;
    if (n.y > cfg.height - cfg.padding) n.y = cfg.height - cfg.padding;
  }
}

export function createLayout({ width, height, padding = 80 }) {
  const positions = new Map();

  function seed(name) {
    // Place new nodes in a ring around the centre so they aren't stacked.
    const i = positions.size;
    const r = Math.min(width, height) * 0.28;
    const a = (i * 2.399) % (Math.PI * 2); // golden-angle jitter
    positions.set(name, {
      x: width / 2 + Math.cos(a) * r,
      y: height / 2 + Math.sin(a) * r,
      vx: 0,
      vy: 0,
    });
  }

  function compute({ names, edges = [] }, iterations = 200) {
    for (const name of names) {
      if (!positions.has(name)) seed(name);
    }
    const nodeList = names.map((n) => positions.get(n));
    const edgeIdx = edges
      .map(({ a, b }) => [names.indexOf(a), names.indexOf(b)])
      .filter(([i, j]) => i >= 0 && j >= 0);
    const cfg = {
      kRep: 12000,
      kSpring: 0.04,
      restLen: 140,
      kCenter: 0.012,
      damping: 0.82,
      cx: width / 2,
      cy: height / 2,
      width,
      height,
      padding,
    };
    for (let it = 0; it < iterations; it++) stepForces(nodeList, edgeIdx, cfg);
    const out = new Map();
    for (const name of names) {
      const p = positions.get(name);
      out.set(name, { x: p.x, y: p.y });
    }
    return out;
  }

  function resize(dims) {
    if (dims.width) width = dims.width;
    if (dims.height) height = dims.height;
  }

  function drop(name) {
    positions.delete(name);
  }

  return { compute, resize, drop };
}
