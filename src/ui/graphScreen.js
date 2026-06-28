import { buildGraph } from '../core/graph.js';
import { normaliseName } from '../core/merge.js';
import { createLayout } from './graph/layout.js';
import { createGraphPane } from './graph/render.js';
import { computeFitTransform, zoomAtPoint } from './graph/viewport.js';
import { createFocusPanel } from './graph/focusPanel.js';
import { createViewTabs } from './viewTabs.js';
import { mountThemeToggle } from './themeToggle.js';

export function createGraphScreen({ lineup, onViewChange }) {
  const root = document.createElement('div');
  root.className = 'screen screen-graph';
  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aliad</span>
      </div>
      <div class="topbar-tabs"></div>
      <div class="topbar-center"></div>
      <div class="topbar-right" role="status" aria-live="polite">
        <span class="progress-counter">000%</span>
        <div class="progress-bar"><div class="progress-fill"></div></div>
      </div>
    </header>
    <section class="graph-region"></section>
    <aside class="detail-region">
      <div class="panel-host-connection"></div>
      <div class="panel-section panel-singletons" hidden>
        <div class="singleton-list" hidden></div>
        <button type="button" class="panel-eyebrow singletons-toggle" aria-expanded="false">
          <span class="singletons-chevron">&#x25B8;</span>
          <span class="singletons-label"></span>
        </button>
      </div>
    </aside>
  `;

  const graphRegion = root.querySelector('.graph-region');
  const panelHost = root.querySelector('.panel-host-connection');
  const singletonListEl = root.querySelector('.singleton-list');
  const singletonSection = root.querySelector('.panel-singletons');
  const singletonToggle = root.querySelector('.singletons-toggle');
  const singletonLabel = root.querySelector('.singletons-label');
  const progressCounter = root.querySelector('.progress-counter');
  const progressFill = root.querySelector('.progress-fill');
  const progressBar = root.querySelector('.progress-bar');
  // The bar shimmers while the walk is still streaming — the "it's alive" signal,
  // visible no matter how slowly the honest fill advances.
  progressBar.classList.add('is-resolving');

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('graph');
  root.querySelector('.topbar-tabs').append(tabs.el);
  mountThemeToggle(root.querySelector('.topbar'));

  const pane = createGraphPane();
  graphRegion.append(pane.el);

  // Legend chip: the node vocabulary (person / group / collaboration) plus the
  // Fit control, pinned bottom-right of the canvas.
  const legend = document.createElement('div');
  legend.className = 'graph-legend';
  legend.innerHTML = `
    <span class="legend-item"><span class="legend-glyph is-person"></span>Person</span>
    <span class="legend-item"><span class="legend-glyph is-group"></span>Group</span>
    <span class="legend-item"><span class="legend-glyph is-collab"></span>Collaboration</span>
    <span class="legend-sep"></span>
    <button type="button" class="legend-zoom-btn" data-dir="out" aria-label="Zoom out" title="Zoom out">&minus;</button>
    <span class="legend-zoom">100%</span>
    <button type="button" class="legend-zoom-btn" data-dir="in" aria-label="Zoom in" title="Zoom in">+</button>
    <button type="button" class="legend-fit" title="Fit graph to view">Fit</button>
  `;
  root.append(legend);
  const fitBtn = legend.querySelector('.legend-fit');
  const zoomIndicator = legend.querySelector('.legend-zoom');
  legend.querySelectorAll('.legend-zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => zoomBy(btn.dataset.dir === 'in' ? 1.25 : 1 / 1.25));
  });

  // Plain-language reassurance shown only when a run is projected to be slow (a
  // lineup we haven't looked up before takes far longer than a cached one).
  const progressHint = document.createElement('div');
  progressHint.className = 'progress-hint';
  progressHint.textContent = 'First time looking up this lineup — this can take a few minutes.';
  graphRegion.append(progressHint);

  const focusPanel = createFocusPanel();
  panelHost.append(focusPanel.el);

  // ── Connections drawer (narrow / zoomed widths only) ───────────────
  // At wide widths the detail panel is a fixed sidebar (CSS). Below the layout
  // breakpoint it becomes a bottom sheet; this handle toggles it, and selecting
  // a cluster auto-opens it so a tap reveals that cluster's evidence. The handle
  // is CSS-hidden when the sidebar is shown, so it's inert on desktop.
  const detailRegion = root.querySelector('.detail-region');
  const drawerHandle = document.createElement('button');
  drawerHandle.type = 'button';
  drawerHandle.className = 'drawer-handle';
  drawerHandle.setAttribute('aria-controls', 'graph-connections-panel');
  detailRegion.id = 'graph-connections-panel';
  detailRegion.prepend(drawerHandle);

  let drawerOpen = false;
  function syncDrawer() {
    detailRegion.classList.toggle('is-open', drawerOpen);
    drawerHandle.setAttribute('aria-expanded', String(drawerOpen));
    drawerHandle.textContent = drawerOpen ? 'Connections ▾' : 'Connections ▴';
  }
  function setDrawer(open) {
    drawerOpen = open;
    syncDrawer();
  }
  drawerHandle.addEventListener('click', () => setDrawer(!drawerOpen));
  syncDrawer();

  // The unconnected-acts list is collapsed by default — it's a long, low-value
  // list that otherwise crowds the panel. Clicking the header expands it.
  singletonToggle.addEventListener('click', () => {
    const expanded = singletonToggle.getAttribute('aria-expanded') === 'true';
    singletonToggle.setAttribute('aria-expanded', String(!expanded));
    singletonListEl.hidden = expanded;
  });

  // ── State ──────────────────────────────────────────────────────────
  const completedResults = []; // [{ name, merged, closure, sources, parts }]
  const completedNames = new Set(); // lineup names that finished lookup
  let currentGraph = { clusters: [], singletons: [], kinds: new Map() };
  // Focus is keyed on a representative member name (normalised), not the cluster
  // id: ids (c${root}) shift as clusters merge during streaming, but a member
  // name resolves robustly to whichever cluster currently contains it. Null = no
  // selection (the panel shows its prompt) — the default until the user clicks.
  let manualFocusCluster = null;
  let finalized = false;
  let firstLayoutRun = true;
  const startTime = performance.now();
  let hintShown = false;

  const layout = createLayout({ width: 100, height: 100 });

  // Subscribers (e.g. the List view) notified whenever currentGraph changes, so
  // a sibling view can re-render off the same source of truth without its own
  // copy of the streamed results. Fired on every completion and at finalize.
  const graphSubscribers = new Set();
  function emitGraphChange() {
    for (const cb of graphSubscribers) cb(currentGraph, lineup);
  }
  function onGraphChange(cb) {
    graphSubscribers.add(cb);
    cb(currentGraph, lineup); // prime with current state on subscribe
    return () => graphSubscribers.delete(cb);
  }

  // Resolve a focus key (a normalised member name) to the cluster that currently
  // contains it, or null if no longer present (e.g. it became a singleton).
  function resolveCluster(key) {
    if (!key) return null;
    return currentGraph.clusters.find((c) => c.nodes.some((n) => normaliseName(n) === key)) || null;
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
    zoomIndicator.textContent = `${Math.round(viewport.k * 100)}%`;
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
  // Select a cluster by one of its member names: focus it (dim the rest), reveal
  // its evidence. `pan` brings it into view — wanted for keyboard nav (the target
  // may be off-screen) but not for a mouse click on an already-visible node.
  function selectCluster(name, { pan = false } = {}) {
    manualFocusCluster = normaliseName(name);
    setDrawer(true); // reveal the evidence on the bottom sheet (no-op when wide)
    if (pan) panClusterIntoView(resolveCluster(manualFocusCluster));
    render();
  }

  function clearSelection() {
    if (!manualFocusCluster) return;
    manualFocusCluster = null;
    setDrawer(false);
    render();
  }

  // Pan (no zoom change) so the cluster's centroid sits in the pane, but only if
  // it's currently outside a comfortable margin — keyboard nav shouldn't yank the
  // view when the target is already on screen.
  function panClusterIntoView(cluster) {
    if (!cluster) return;
    const pts = cluster.nodes.map((n) => lastPositions.get(n)).filter(Boolean);
    if (!pts.length) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const { width, height } = paneDims();
    const sx = cx * viewport.k + viewport.tx;
    const sy = cy * viewport.k + viewport.ty;
    const margin = 80;
    if (sx >= margin && sx <= width - margin && sy >= margin && sy <= height - margin) return;
    viewport = { ...viewport, tx: width / 2 - cx * viewport.k, ty: height / 2 - cy * viewport.k };
    autoFit = false;
    applyViewport(true); // smooth glide to the centred cluster
  }

  // Zoom about the pane centre (keyboard / button zoom has no pointer anchor).
  function zoomBy(factor) {
    const { width, height } = paneDims();
    viewport = zoomAtPoint(viewport, width / 2, height / 2, factor);
    autoFit = false;
    applyViewport(true);
  }

  function render() {
    const { width, height } = paneDims();
    const clusterNames = [...clusterMembers()];
    const edges = allEdges();
    const focusedCluster = resolveCluster(manualFocusCluster);
    const focusedClusterNodes = focusedCluster ? new Set(focusedCluster.nodes) : null;

    // One representative node per cluster is the keyboard tab stop; its label
    // names the cluster + size for screen readers.
    const navOrder = [];
    const ariaLabels = new Map();
    for (const c of currentGraph.clusters) {
      const rep = c.nodes[0];
      if (!rep) continue;
      navOrder.push(rep);
      const count = c.nodes.length;
      ariaLabels.set(rep, `${rep}, cluster of ${count} connected act${count === 1 ? '' : 's'}`);
    }

    pane.update({
      width,
      height,
      nodes: clusterNames,
      edges,
      positions: lastPositions,
      kinds: currentGraph.kinds,
      focusedClusterNodes,
      navOrder,
      ariaLabels,
      onClusterClick: (name) => selectCluster(name, { pan: false }),
      onClusterFocus: (name) => selectCluster(name, { pan: true }),
      onClearFocus: clearSelection,
      onZoomIn: () => zoomBy(1.25),
      onZoomOut: () => zoomBy(1 / 1.25),
      onFit: () => {
        autoFit = true;
        fitToContent(true);
      },
      onPan: (dx, dy) => {
        viewport = { ...viewport, tx: viewport.tx + dx, ty: viewport.ty + dy };
        autoFit = false;
        applyViewport(false); // instant step pan, matching wheel/drag
      },
    });
    focusPanel.update(focusedCluster);
    renderSingletons();
  }

  // Recompute layout (runs the sim) THEN render. Only for real changes: new
  // data arriving (scheduleRelayout) and resize. `settle` runs the finalize-only
  // feature-aware de-collision pass (node↔foreign-edge), used once at finalize.
  function recomputeLayoutAndRender(settle = false) {
    const { width, height } = paneDims();
    layout.resize({ width, height });

    const clusterNames = [...clusterMembers()];
    if (clusterNames.length > 0) {
      const result = layout.compute(
        { clusters: currentGraph.clusters },
        firstLayoutRun ? 250 : 70,
        { settle },
      );
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
    let count = 0;
    lineup.forEach((name, i) => {
      if (clustered.has(name)) return;
      count++;
      const resolved = completedNames.has(name);
      const row = document.createElement('div');
      row.className = `singleton-row${resolved ? ' is-resolved' : ''}`;
      row.innerHTML = `
        <span class="singleton-dot"></span>
        <span class="singleton-name"></span>
      `;
      row.querySelector('.singleton-name').textContent = name;
      singletonListEl.append(row);
    });
    // Hide the whole section when everything's connected; otherwise show the count.
    singletonSection.hidden = count === 0;
    singletonLabel.textContent = `${count} act${count === 1 ? '' : 's'} with no connections`;
  }

  function updateProgress() {
    const completed = completedNames.size;
    const total = Math.max(1, lineup.length);
    const pct = Math.round((completed / total) * 100);
    progressCounter.textContent = `${String(pct).padStart(3, '0')}%`;
    // Spoken form for the aria-live region — the bare "045%" glyph isn't meaningful.
    progressCounter.setAttribute('aria-label', `${pct}% of lineup resolved`);
    progressFill.style.width = `${pct}%`;

    // Project the remaining time from the observed completion rate; if it's going
    // to be a long haul (an un-cached lineup), latch the reassurance on. Wait for a
    // few completions + a little wall-clock so the rate estimate is stable.
    if (!hintShown && !finalized && completed >= 3) {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed > 6) {
        const projectedRemaining = ((total - completed) / completed) * elapsed;
        if (projectedRemaining > 45) {
          hintShown = true;
          progressHint.classList.add('is-visible');
        }
      }
    }
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

  // Drag the empty canvas to pan. Starting on an edge or node is left to that
  // element's own click handler, so panning never steals a cluster-select click.
  let panFrom = null;
  pane.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.graph-edge, .graph-node')) return;
    panFrom = { x: e.clientX, y: e.clientY, tx: viewport.tx, ty: viewport.ty, moved: false };
    pane.el.classList.add('is-panning');
    pane.el.setPointerCapture(e.pointerId);
  });
  pane.el.addEventListener('pointermove', (e) => {
    if (!panFrom) return;
    if (Math.abs(e.clientX - panFrom.x) > 3 || Math.abs(e.clientY - panFrom.y) > 3) {
      panFrom.moved = true;
    }
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
    const wasClick = !panFrom.moved;
    panFrom = null;
    pane.el.classList.remove('is-panning');
    pane.el.releasePointerCapture?.(e.pointerId);
    // A click on empty canvas (no drag) clears the selection back to the prompt.
    if (wasClick) clearSelection();
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

    currentGraph = buildGraph(completedResults);
    updateProgress();
    scheduleRelayout();
    emitGraphChange();
  }

  function onArtistDone() {
    // No-op: we update on full artist completion, not per-provider.
  }

  function finalize() {
    finalized = true;
    progressBar.classList.remove('is-resolving');
    progressHint.classList.remove('is-visible');
    // The streaming progress readout is transient — clear it from the top bar
    // once the walk is done (the persistent zoom lives in the canvas legend).
    progressCounter.hidden = true;
    progressBar.hidden = true;
    // One settling pass to clear node↔foreign-edge intrusions left by the
    // box-only de-collision during streaming. Cancel any pending relayout so it
    // doesn't run a non-settle pass right after and undo the cleanup.
    if (relayoutTimer != null) {
      clearTimeout(relayoutTimer);
      relayoutTimer = null;
    }
    recomputeLayoutAndRender(true);
    renderSingletons();
    emitGraphChange();
  }

  return {
    el: root,
    onArtistComplete,
    onArtistDone,
    finalize,
    onGraphChange,
    setActiveView: tabs.setActive,
  };
}
