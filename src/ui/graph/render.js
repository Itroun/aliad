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
  // Edges and nodes are both drawn in WORLD coordinates; the pan/zoom viewport
  // transform lives on the wrapper layers (the <g> and the inner nodes div), so
  // the renderer never has to know about scale/pan — it just draws world coords.
  root.innerHTML = `
    <svg class="graph-svg"><g class="graph-vp"></g></svg>
    <div class="graph-nodes"><div class="graph-nodes-vp"></div></div>
  `;
  const svg = root.querySelector('.graph-svg');
  const edgeVp = root.querySelector('.graph-vp');
  const nodesLayer = root.querySelector('.graph-nodes-vp');

  // Track DOM elements by stable key so updates can fade-in new edges.
  const nodeEls = new Map(); // name → HTMLElement
  const edgeEls = new Map(); // "a||b" → SVGGElement
  const edgeData = new Map(); // "a||b" → { a, b, evCount }

  // Animation state.
  const renderedPos = new Map(); // name → { x, y } (current, eased)
  const targetPos = new Map(); // name → { x, y } (latest layout result)
  let rafId = null;

  // ── Keyboard navigation state ──────────────────────────────────────
  // Cluster-by-cluster nav: one representative node per cluster is focusable
  // (roving tabindex), arrows move between them, Enter/Space selects, Esc clears.
  // `cb` holds the latest behaviour callbacks (refreshed every update so node
  // listeners never go stale); `nav` holds the focusable order + current target.
  const cb = {};
  const nav = { order: [], labels: new Map(), current: null };

  // Selection follows focus: tabbing or clicking onto a cluster's representative
  // selects it (no pan — only arrows pan). The cluster-selection styling is then
  // the focus indicator, so graph nodes need no separate focus ring (see the
  // focus section in style.css). Reuses onClusterClick (the no-pan select path).
  root.addEventListener('focusin', (e) => {
    const name = e.target?.dataset?.name;
    if (name && nav.order.includes(name)) cb.onClusterClick?.(name);
  });

  // One delegated keydown handler for the whole pane. Zoom/fit work whenever
  // focus is inside the graph; arrow/select/clear act on the focused nav node.
  root.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') return void (cb.onZoomIn?.(), e.preventDefault());
    if (e.key === '-' || e.key === '_') return void (cb.onZoomOut?.(), e.preventDefault());
    if (e.key === '0') return void (cb.onFit?.(), e.preventDefault());

    const active = document.activeElement;
    const name = active && nav.order.includes(active.dataset?.name) ? active.dataset.name : null;
    if (name == null) return;

    if (e.shiftKey) {
      const PAN = 60;
      const d = {
        ArrowLeft: [PAN, 0],
        ArrowRight: [-PAN, 0],
        ArrowUp: [0, PAN],
        ArrowDown: [0, -PAN],
      }[e.key];
      if (!d) return;
      cb.onPan?.(d[0], d[1]);
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        moveNav(1);
        e.preventDefault();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        moveNav(-1);
        e.preventDefault();
        break;
      case 'Enter':
      case ' ':
        cb.onClusterFocus?.(name);
        e.preventDefault();
        break;
      case 'Escape':
        cb.onClearFocus?.();
        active.blur(); // drop focus off the now-deselected node so focus is never unindicated
        e.preventDefault();
        break;
    }
  });

  // Move the roving focus `dir` clusters along (wrapping), then select it so the
  // panel + dimming follow focus and the cluster pans into view.
  function moveNav(dir) {
    if (!nav.order.length) return;
    const idx = nav.order.indexOf(nav.current);
    const start = idx < 0 ? 0 : idx;
    nav.current = nav.order[(start + dir + nav.order.length) % nav.order.length];
    applyNav();
    // Select (+pan) before moving DOM focus: the focusin handler then sees the
    // cluster already selected and no-ops, so each arrow step renders once.
    cb.onClusterFocus?.(nav.current);
    nodeEls.get(nav.current)?.focus();
  }

  // Re-apply roving tabindex + button semantics. One representative holds
  // tabindex 0 (the tab stop); the rest get -1. A node that stops being a
  // representative (cluster merges) drops its nav semantics. Crucially we never
  // removeAttribute('tabindex') on a node that stays a representative — doing so
  // blurs it if it's the focused element. Setting .tabIndex = -1 keeps focus.
  function applyNav() {
    if (!nav.order.includes(nav.current)) nav.current = nav.order[0] ?? null;
    const navSet = new Set(nav.order);
    // If a streamed merge demotes the focused representative (its cluster's
    // nodes[0] changed), stripping its tabindex below would blur it and drop
    // focus to <body>. Detect that and hand focus to the new current rep so
    // keyboard nav survives relayouts. Only when WE caused the blur — never
    // grab focus that was sitting elsewhere.
    let blurredCurrent = false;
    for (const [name, el] of nodeEls) {
      if (navSet.has(name)) {
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', nav.labels.get(name) || name);
        el.tabIndex = name === nav.current ? 0 : -1;
      } else if (el.hasAttribute('role')) {
        if (el === document.activeElement) blurredCurrent = true;
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
        el.removeAttribute('tabindex');
      }
    }
    if (blurredCurrent) nodeEls.get(nav.current)?.focus();
  }

  function edgeKey(a, b) {
    return `${a}||${b}`;
  }

  function update({
    width,
    height,
    nodes,
    edges,
    positions,
    kinds,
    focusedClusterNodes,
    navOrder,
    ariaLabels,
    onClusterClick,
    onClusterFocus,
    onClearFocus,
    onZoomIn,
    onZoomOut,
    onFit,
    onPan,
  }) {
    // Refresh behaviour callbacks so the once-bound listeners stay current.
    Object.assign(cb, {
      onClusterClick,
      onClusterFocus,
      onClearFocus,
      onZoomIn,
      onZoomOut,
      onFit,
      onPan,
    });
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    // When a cluster is focused, everything outside it recedes. Null/empty set
    // means nothing is selected → no dimming anywhere.
    const hasFocus = focusedClusterNodes && focusedClusterNodes.size > 0;

    // ── Edges: reconcile elements; geometry is applied each frame from rendered
    // positions so edges follow the nodes' easing. ──────────────────────
    const seenEdges = new Set();
    for (const edge of edges) {
      const key = edgeKey(edge.a, edge.b);
      seenEdges.add(key);
      let g = edgeEls.get(key);
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.classList.add('graph-edge', 'aliad-fadein');
        g.innerHTML = `
          <line class="edge-hit" stroke="transparent" stroke-width="18"></line>
          <line class="edge-line" stroke-linecap="round"></line>
          <g class="edge-ticks"></g>
        `;
        g.addEventListener('click', () => cb.onClusterClick?.(edge.a));
        edgeVp.append(g);
        edgeEls.set(key, g);
      }
      // An edge belongs to exactly one cluster, so testing either endpoint is
      // enough to know whether this edge is inside the focused cluster.
      const inFocus = hasFocus && focusedClusterNodes.has(edge.a);
      g.classList.toggle('is-focused', inFocus);
      g.classList.toggle('is-dimmed', hasFocus && !inFocus);
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
        el.dataset.name = name; // reverse lookup for keyboard nav
        el.addEventListener('click', () => cb.onClusterClick?.(name));
        nodesLayer.append(el);
        nodeEls.set(name, el);
        // A new node appears AT its target (then fades/pops in), not gliding in.
        renderedPos.set(name, { x: pos.x, y: pos.y });
      }
      targetPos.set(name, { x: pos.x, y: pos.y });
      // Entity-kind style (person / group / collab) — drives the dot shape.
      const kind = kinds?.get(name) || 'person';
      el.classList.toggle('node-kind-person', kind === 'person');
      el.classList.toggle('node-kind-group', kind === 'group');
      el.classList.toggle('node-kind-collab', kind === 'collab');
      const label = el.querySelector('.node-label');
      label.textContent = name;
      // `align-left` puts the label to the LEFT of the dot. The side (edge-aware,
      // with an on-canvas guard) is decided in the layout so the de-collision
      // pass and the renderer agree on each label's footprint.
      el.classList.toggle('align-left', !!pos.labelLeft);
      el.classList.toggle('is-dimmed', hasFocus && !focusedClusterNodes.has(name));
    }
    for (const [name, el] of nodeEls) {
      if (!seenNodes.has(name)) {
        el.remove();
        nodeEls.delete(name);
        renderedPos.delete(name);
        targetPos.delete(name);
      }
    }

    // ── Keyboard nav: refresh focusable order + roving tabindex. ────────
    nav.order = navOrder || [];
    nav.labels = ariaLabels || new Map();
    applyNav();

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

  // Apply the pan/zoom viewport transform to both wrapper layers. `animate`
  // eases the change (used for programmatic fit); omit it for wheel/drag so the
  // graph tracks the pointer immediately.
  function setTransform({ k, tx, ty }, animate = false) {
    edgeVp.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
    nodesLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    edgeVp.classList.toggle('is-animating', animate);
    nodesLayer.classList.toggle('is-animating', animate);
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
    nav.order = [];
    nav.labels = new Map();
    nav.current = null;
  }

  return { el: root, update, clear, setTransform };
}
