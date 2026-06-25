import { buildGraph } from '../core/graph.js';
import { normaliseName } from '../core/merge.js';
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
        <span class="wordmark-logo">aliad</span>
      </div>
      <div class="topbar-tabs"></div>
      <div class="topbar-center"></div>
      <div class="topbar-right">
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

  const pane = createGraphPane();
  graphRegion.append(pane.el);

  const fitBtn = document.createElement('button');
  fitBtn.className = 'graph-fit-btn';
  fitBtn.type = 'button';
  fitBtn.title = 'Fit graph to view';
  fitBtn.textContent = 'Fit';
  graphRegion.append(fitBtn);

  // Plain-language reassurance shown only when a run is projected to be slow (a
  // lineup we haven't looked up before takes far longer than a cached one).
  const progressHint = document.createElement('div');
  progressHint.className = 'progress-hint';
  progressHint.textContent = 'First time looking up this lineup — this can take a few minutes.';
  graphRegion.append(progressHint);

  const focusPanel = createFocusPanel();
  panelHost.append(focusPanel.el);

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
    const focusedCluster = resolveCluster(manualFocusCluster);
    const focusedClusterNodes = focusedCluster
      ? new Set(focusedCluster.nodes)
      : null;

    pane.update({
      width,
      height,
      nodes: clusterNames,
      edges,
      positions: lastPositions,
      kinds: currentGraph.kinds,
      focusedClusterNodes,
      onClusterClick: (name) => {
        manualFocusCluster = normaliseName(name);
        render();
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
    if (wasClick && manualFocusCluster) {
      manualFocusCluster = null;
      render();
    }
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
  }

  function onArtistDone() {
    // No-op: we update on full artist completion, not per-provider.
  }

  function finalize() {
    finalized = true;
    progressCounter.textContent = '100%';
    progressFill.style.width = '100%';
    progressBar.classList.remove('is-resolving');
    progressHint.classList.remove('is-visible');
    // One settling pass to clear node↔foreign-edge intrusions left by the
    // box-only de-collision during streaming. Cancel any pending relayout so it
    // doesn't run a non-settle pass right after and undo the cleanup.
    if (relayoutTimer != null) {
      clearTimeout(relayoutTimer);
      relayoutTimer = null;
    }
    recomputeLayoutAndRender(true);
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
