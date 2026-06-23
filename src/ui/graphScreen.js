import { buildGraph } from '../core/graph.js';
import { diffGraph } from './graph/eventStream.js';
import { createLayout } from './graph/layout.js';
import { createGraphPane } from './graph/render.js';
import { computeFitTransform, zoomAtPoint } from './graph/viewport.js';
import { createFocusPanel } from './graph/focusPanel.js';
import { createViewTabs } from './viewTabs.js';

export function createGraphScreen({ lineup, onViewChange }) {
  const root = document.createElement('div');
  root.className = 'screen screen-graph';
  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aka</span>
        <span class="wordmark-tagline">Lineup identity graph</span>
      </div>
      <div class="topbar-tabs"></div>
      <div class="topbar-center">
        <span class="resolving-indicator">
          <span class="resolving-dot"></span>
          <span class="resolving-label">Resolving…</span>
        </span>
      </div>
      <div class="topbar-right">
        <span class="progress-counter">000%</span>
        <div class="progress-bar"><div class="progress-fill"></div></div>
      </div>
    </header>
    <section class="graph-region"></section>
    <aside class="detail-region">
      <div class="panel-host-connection"></div>
      <div class="panel-section panel-singletons">
        <div class="panel-eyebrow">No matches</div>
        <div class="singleton-list"></div>
      </div>
    </aside>
  `;

  const graphRegion = root.querySelector('.graph-region');
  const panelHost = root.querySelector('.panel-host-connection');
  const singletonListEl = root.querySelector('.singleton-list');
  const progressCounter = root.querySelector('.progress-counter');
  const progressFill = root.querySelector('.progress-fill');
  const resolvingIndicator = root.querySelector('.resolving-indicator');

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('graph');
  root.querySelector('.topbar-tabs').append(tabs.el);

  const pane = createGraphPane();
  graphRegion.append(pane.el);

  const fitBtn = document.createElement('button');
  fitBtn.className = 'graph-fit-btn';
  fitBtn.type = 'button';
  fitBtn.title = 'Fit graph to view';
  fitBtn.textContent = 'Fit';
  graphRegion.append(fitBtn);

  const focusPanel = createFocusPanel();
  panelHost.append(focusPanel.el);

  // ── State ──────────────────────────────────────────────────────────
  const completedResults = []; // [{ name, merged, closure, sources, parts }]
  const completedNames = new Set(); // lineup names that finished lookup
  let prevGraph = { clusters: [], singletons: [] };
  let currentGraph = { clusters: [], singletons: [] };
  let manualFocusKey = null;
  let autoFocusKey = null;
  let finalized = false;
  let firstLayoutRun = true;

  const layout = createLayout({ width: 100, height: 100 });

  function edgeKey(edge) {
    return `${edge.a}||${edge.b}`;
  }

  function allEdges() {
    return currentGraph.clusters.flatMap((c) => c.edges);
  }

  function clusterMembers() {
    return new Set(currentGraph.clusters.flatMap((c) => c.nodes));
  }

  function paneDims() {
    const rect = graphRegion.getBoundingClientRect();
    return { width: rect.width || 800, height: rect.height || 600 };
  }

  // Latest computed positions, reused by focus-only re-renders so a click never
  // re-runs the force sim.
  let lastPositions = new Map();
  let lastBounds = null;

  // ── Pan/zoom viewport ──────────────────────────────────────────────
  // World→screen transform. `autoFit` keeps the whole graph framed as new acts
  // stream in; the first manual zoom/pan turns it off (so we don't yank the
  // user's view), and the Fit button turns it back on.
  let viewport = { k: 1, tx: 0, ty: 0 };
  let autoFit = true;

  function applyViewport(animate) {
    pane.setTransform(viewport, animate);
  }

  function fitToContent(animate) {
    if (!lastBounds) return;
    const { width, height } = paneDims();
    viewport = computeFitTransform(lastBounds, width, height);
    applyViewport(animate);
  }

  // Re-render with the CURRENT positions (no layout recompute). Used for focus
  // changes (edge clicks): the sim is warm-started and not at equilibrium, so
  // resuming it on every click would drift clusters around until it settles —
  // a focus change must not move the graph.
  function render() {
    const { width, height } = paneDims();
    const clusterNames = [...clusterMembers()];
    const edges = allEdges();
    const focusedKey = manualFocusKey ?? autoFocusKey;
    const focusedEdge = edges.find((e) => edgeKey(e) === focusedKey) || null;

    pane.update({
      width,
      height,
      nodes: clusterNames,
      edges,
      positions: lastPositions,
      focusedEdgeKey: focusedKey,
      onEdgeClick: (edge) => {
        manualFocusKey = edgeKey(edge);
        render();
      },
    });
    focusPanel.update(focusedEdge);
    renderSingletons();
  }

  // Recompute layout (runs the sim) THEN render. Only for real changes: new
  // data arriving (scheduleRelayout) and resize.
  function recomputeLayoutAndRender() {
    const { width, height } = paneDims();
    layout.resize({ width, height });

    const clusterNames = [...clusterMembers()];
    if (clusterNames.length > 0) {
      const result = layout.compute({ clusters: currentGraph.clusters }, firstLayoutRun ? 250 : 70);
      lastPositions = result.positions;
      lastBounds = result.bounds;
    } else {
      lastPositions = new Map();
      lastBounds = null;
    }
    firstLayoutRun = false;

    // Keep the whole graph framed as it grows — until the user takes manual
    // control of the viewport (then we leave their pan/zoom alone).
    if (autoFit) fitToContent(true);

    render();
  }

  function renderSingletons() {
    const clustered = clusterMembers();
    singletonListEl.replaceChildren();
    lineup.forEach((name, i) => {
      if (clustered.has(name)) return;
      const resolved = completedNames.has(name);
      const row = document.createElement('div');
      row.className = `singleton-row${resolved ? ' is-resolved' : ''}`;
      row.innerHTML = `
        <span class="singleton-idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="singleton-dot"></span>
        <span class="singleton-name"></span>
      `;
      row.querySelector('.singleton-name').textContent = name;
      singletonListEl.append(row);
    });
  }

  function updateProgress() {
    const pct = Math.round((completedNames.size / Math.max(1, lineup.length)) * 100);
    progressCounter.textContent = `${String(pct).padStart(3, '0')}%`;
    progressFill.style.width = `${pct}%`;
  }

  // ── Init ───────────────────────────────────────────────────────────
  renderSingletons();
  updateProgress();

  // Throttle relayouts: many streamed completions collapse into at most one
  // layout pass every RELAYOUT_INTERVAL_MS, so the graph's target positions
  // change a few times a second rather than every frame. Combined with the
  // renderer's gentle easing, this keeps the motion calm — nodes settle between
  // bursts instead of continuously re-aiming. A trailing call guarantees the
  // final state still renders.
  const RELAYOUT_INTERVAL_MS = 1500;
  let relayoutTimer = null;
  let lastRelayout = 0;
  function scheduleRelayout() {
    if (relayoutTimer != null) return;
    const wait = Math.max(0, RELAYOUT_INTERVAL_MS - (performance.now() - lastRelayout));
    relayoutTimer = setTimeout(() => {
      relayoutTimer = null;
      lastRelayout = performance.now();
      recomputeLayoutAndRender();
    }, wait);
  }

  // Re-layout on resize (debounced via rAF).
  let resizeScheduled = false;
  window.addEventListener('resize', () => {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(() => {
      resizeScheduled = false;
      recomputeLayoutAndRender();
    });
  });

  // ── Pan/zoom interaction ───────────────────────────────────────────
  // Pointer position relative to the pane's top-left (= screen coords the
  // viewport transform is expressed in).
  function panePoint(e) {
    const r = pane.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pane.el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { x, y } = panePoint(e);
      // Trackpads/mice report wildly different deltas; map sign to a gentle step.
      const factor = Math.exp(-e.deltaY * 0.0015);
      viewport = zoomAtPoint(viewport, x, y, factor);
      autoFit = false;
      applyViewport(false);
    },
    { passive: false },
  );

  // Drag the empty canvas to pan. Starting on an edge is left to the edge's own
  // click handler, so panning never steals an edge click.
  let panFrom = null;
  pane.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.graph-edge')) return;
    panFrom = { x: e.clientX, y: e.clientY, tx: viewport.tx, ty: viewport.ty };
    pane.el.classList.add('is-panning');
    pane.el.setPointerCapture(e.pointerId);
  });
  pane.el.addEventListener('pointermove', (e) => {
    if (!panFrom) return;
    viewport = {
      ...viewport,
      tx: panFrom.tx + (e.clientX - panFrom.x),
      ty: panFrom.ty + (e.clientY - panFrom.y),
    };
    autoFit = false;
    applyViewport(false);
  });
  const endPan = (e) => {
    if (!panFrom) return;
    panFrom = null;
    pane.el.classList.remove('is-panning');
    pane.el.releasePointerCapture?.(e.pointerId);
  };
  pane.el.addEventListener('pointerup', endPan);
  pane.el.addEventListener('pointercancel', endPan);

  fitBtn.addEventListener('click', () => {
    autoFit = true;
    fitToContent(true);
  });

  // ── Callbacks for lookupAll ────────────────────────────────────────
  function onArtistComplete(name, merged, summary = {}) {
    if (finalized) return;
    if (completedNames.has(name)) return;
    completedNames.add(name);
    completedResults.push({
      name,
      merged,
      closure: summary.closure ?? new Set(),
      sources: summary.sources,
      parts: summary.parts,
    });

    prevGraph = currentGraph;
    currentGraph = buildGraph(completedResults);
    const { newEdges } = diffGraph(prevGraph, currentGraph);

    if (!manualFocusKey && newEdges.length > 0 && !autoFocusKey) {
      autoFocusKey = edgeKey(newEdges[0].edge);
    }

    updateProgress();
    scheduleRelayout();
  }

  function onArtistDone() {
    // No-op: we update on full artist completion, not per-provider.
  }

  function finalize() {
    finalized = true;
    resolvingIndicator.classList.add('is-hidden');
    progressCounter.textContent = '100%';
    progressFill.style.width = '100%';
    renderSingletons();
  }

  return {
    el: root,
    onArtistComplete,
    onArtistDone,
    finalize,
    setActiveView: tabs.setActive,
  };
}
