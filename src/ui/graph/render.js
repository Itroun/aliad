// Imperative SVG renderer for the graph pane.
// Nodes live in a <div> layer for CSS-animated halos; edges live in an <svg>.
//
// Positions are ANIMATED, not applied instantly: each `update()` sets new target
// positions, and a requestAnimationFrame loop eases every node from its current
// rendered position toward its target, redrawing nodes AND edges together each
// frame so lines stay attached. The layout still recomputes from scratch on every
// streamed result — this just turns the resulting position jumps into smooth
// glides. New nodes appear at their target (then fade/pop in) rather than gliding
// from nowhere.

const SVG_NS = 'http://www.w3.org/2000/svg';
const EASE = 0.08; // per-frame approach fraction — low = calm, gradual glides
const DONE_EPS = 0.4; // px; stop animating once everything is this close

export function createGraphPane() {
  const root = document.createElement('div');
  root.className = 'graph-pane';
  root.innerHTML = `
    <svg class="graph-svg"></svg>
    <div class="graph-nodes"></div>
  `;
  const svg = root.querySelector('.graph-svg');
  const nodesLayer = root.querySelector('.graph-nodes');

  // Track DOM elements by stable key so updates can fade-in new edges.
  const nodeEls = new Map(); // name → HTMLElement
  const edgeEls = new Map(); // "a||b" → SVGGElement
  const edgeData = new Map(); // "a||b" → { a, b, evCount }

  // Animation state.
  const renderedPos = new Map(); // name → { x, y } (current, eased)
  const targetPos = new Map(); // name → { x, y } (latest layout result)
  let rafId = null;

  function edgeKey(a, b) {
    return `${a}||${b}`;
  }

  function update({ width, height, nodes, edges, positions, focusedEdgeKey, onEdgeClick }) {
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // ── Edges: reconcile elements; geometry is applied each frame from rendered
    // positions so edges follow the nodes' easing. ──────────────────────
    const seenEdges = new Set();
    for (const edge of edges) {
      const key = edgeKey(edge.a, edge.b);
      seenEdges.add(key);
      let g = edgeEls.get(key);
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.classList.add('graph-edge', 'aka-fadein');
        g.innerHTML = `
          <line class="edge-hit" stroke="transparent" stroke-width="18"></line>
          <line class="edge-line" stroke-linecap="round"></line>
          <g class="edge-ticks"></g>
        `;
        g.addEventListener('click', () => onEdgeClick?.(edge));
        svg.append(g);
        edgeEls.set(key, g);
      }
      g.classList.toggle('is-focused', key === focusedEdgeKey);
      edgeData.set(key, { a: edge.a, b: edge.b, evCount: edge.evidence.length });
    }
    for (const [key, el] of edgeEls) {
      if (!seenEdges.has(key)) {
        el.remove();
        edgeEls.delete(key);
        edgeData.delete(key);
      }
    }

    // ── Nodes: reconcile elements + set targets. ────────────────────────
    const seenNodes = new Set();
    let newCount = 0;
    for (const name of nodes) {
      const pos = positions.get(name);
      if (!pos) continue;
      seenNodes.add(name);
      let el = nodeEls.get(name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'graph-node node-enter';
        el.innerHTML = `<span class="node-dot"></span><span class="node-label"></span>`;
        // Stagger entrances within a batch so additions cascade rather than pop
        // all at once (capped so a big first batch doesn't drag).
        el.style.setProperty('--enter-delay', `${Math.min(newCount * 35, 280)}ms`);
        newCount++;
        nodesLayer.append(el);
        nodeEls.set(name, el);
        // A new node appears AT its target (then fades/pops in), not gliding in.
        renderedPos.set(name, { x: pos.x, y: pos.y });
      }
      targetPos.set(name, { x: pos.x, y: pos.y });
      const label = el.querySelector('.node-label');
      label.textContent = name;
      // `align-left` puts the label to the LEFT of the dot. The side (edge-aware,
      // with an on-canvas guard) is decided in the layout so the de-collision
      // pass and the renderer agree on each label's footprint.
      el.classList.toggle('align-left', !!pos.labelLeft);
    }
    for (const [name, el] of nodeEls) {
      if (!seenNodes.has(name)) {
        el.remove();
        nodeEls.delete(name);
        renderedPos.delete(name);
        targetPos.delete(name);
      }
    }

    applyAll();
    ensureAnimating();
  }

  // Write current rendered positions to the DOM (nodes + edge geometry).
  function applyAll() {
    for (const [name, el] of nodeEls) {
      const r = renderedPos.get(name);
      if (!r) continue;
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
    }
    for (const [key, g] of edgeEls) {
      const data = edgeData.get(key);
      const pa = data && renderedPos.get(data.a);
      const pb = data && renderedPos.get(data.b);
      if (!pa || !pb) continue;
      applyEdge(g, pa, pb, data.evCount);
    }
  }

  function applyEdge(g, pa, pb, evCount) {
    const hit = g.querySelector('.edge-hit');
    const line = g.querySelector('.edge-line');
    for (const seg of [hit, line]) {
      seg.setAttribute('x1', pa.x);
      seg.setAttribute('y1', pa.y);
      seg.setAttribute('x2', pb.x);
      seg.setAttribute('y2', pb.y);
    }
    // Evidence ticks at midpoint, perpendicular to the line.
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const tickSpacing = 5;
    const ticks = g.querySelector('.edge-ticks');
    ticks.replaceChildren();
    for (let i = 0; i < evCount; i++) {
      const offset = (i - (evCount - 1) / 2) * tickSpacing;
      const cx = mx + ux * offset;
      const cy = my + uy * offset;
      const tick = document.createElementNS(SVG_NS, 'line');
      tick.classList.add('edge-tick');
      tick.setAttribute('x1', cx + px * 4);
      tick.setAttribute('y1', cy + py * 4);
      tick.setAttribute('x2', cx - px * 4);
      tick.setAttribute('y2', cy - py * 4);
      ticks.append(tick);
    }
  }

  function ensureAnimating() {
    if (rafId == null) rafId = requestAnimationFrame(tick);
  }

  function tick() {
    let maxDelta = 0;
    for (const [name, t] of targetPos) {
      const r = renderedPos.get(name);
      if (!r) continue;
      r.x += (t.x - r.x) * EASE;
      r.y += (t.y - r.y) * EASE;
      maxDelta = Math.max(maxDelta, Math.abs(t.x - r.x), Math.abs(t.y - r.y));
    }
    if (maxDelta <= DONE_EPS) {
      // Snap exactly onto targets and stop.
      for (const [name, t] of targetPos) renderedPos.set(name, { x: t.x, y: t.y });
      applyAll();
      rafId = null;
      return;
    }
    applyAll();
    rafId = requestAnimationFrame(tick);
  }

  function clear() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    for (const el of nodeEls.values()) el.remove();
    for (const el of edgeEls.values()) el.remove();
    nodeEls.clear();
    edgeEls.clear();
    edgeData.clear();
    renderedPos.clear();
    targetPos.clear();
  }

  return { el: root, update, clear };
}
