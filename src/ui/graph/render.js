// Imperative SVG renderer for the graph pane.
// Nodes live in a <div> layer for CSS-animated halos; edges live in an <svg>.

const SVG_NS = 'http://www.w3.org/2000/svg';

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

  function edgeKey(a, b) {
    return `${a}||${b}`;
  }

  function update({ width, height, nodes, edges, positions, focusedEdgeKey, onEdgeClick }) {
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // ── Edges ─────────────────────────────────────────────────────────
    const seenEdges = new Set();
    for (const edge of edges) {
      const key = edgeKey(edge.a, edge.b);
      seenEdges.add(key);
      const pa = positions.get(edge.a);
      const pb = positions.get(edge.b);
      if (!pa || !pb) continue;

      let g = edgeEls.get(key);
      const isNew = !g;
      if (isNew) {
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

      const hit = g.querySelector('.edge-hit');
      const line = g.querySelector('.edge-line');
      hit.setAttribute('x1', pa.x);
      hit.setAttribute('y1', pa.y);
      hit.setAttribute('x2', pb.x);
      hit.setAttribute('y2', pb.y);
      line.setAttribute('x1', pa.x);
      line.setAttribute('y1', pa.y);
      line.setAttribute('x2', pb.x);
      line.setAttribute('y2', pb.y);

      // Evidence ticks at midpoint, perpendicular to the line.
      const totalEv = edge.evidence.length;
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
      for (let i = 0; i < totalEv; i++) {
        const offset = (i - (totalEv - 1) / 2) * tickSpacing;
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
    for (const [key, el] of edgeEls) {
      if (!seenEdges.has(key)) {
        el.remove();
        edgeEls.delete(key);
      }
    }

    // ── Nodes ─────────────────────────────────────────────────────────
    const seenNodes = new Set();
    for (const name of nodes) {
      const pos = positions.get(name);
      if (!pos) continue;
      seenNodes.add(name);
      let el = nodeEls.get(name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'graph-node aka-fadein';
        el.innerHTML = `<span class="node-dot"></span><span class="node-label"></span>`;
        nodesLayer.append(el);
        nodeEls.set(name, el);
      }
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      const label = el.querySelector('.node-label');
      label.textContent = name;
      // Label alignment: right of dot when on the left half, else left.
      el.classList.toggle('align-left', pos.x > width * 0.55);
    }
    for (const [name, el] of nodeEls) {
      if (!seenNodes.has(name)) {
        el.remove();
        nodeEls.delete(name);
      }
    }
  }

  function clear() {
    for (const el of nodeEls.values()) el.remove();
    for (const el of edgeEls.values()) el.remove();
    nodeEls.clear();
    edgeEls.clear();
  }

  return { el: root, update, clear };
}
