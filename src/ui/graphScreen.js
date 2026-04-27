import { buildGraph } from '../core/graph.js';
import { diffGraph } from './graph/eventStream.js';
import { createLayout } from './graph/layout.js';
import { createGraphPane } from './graph/render.js';
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

  const focusPanel = createFocusPanel();
  panelHost.append(focusPanel.el);

  // ── State ──────────────────────────────────────────────────────────
  const completedResults = []; // [{ name, merged, closure }]
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

  function recomputeLayoutAndRender() {
    const { width, height } = paneDims();
    layout.resize({ width, height });

    const clusterNames = [...clusterMembers()];
    const edges = allEdges();
    const positions =
      clusterNames.length > 0
        ? layout.compute({ names: clusterNames, edges }, firstLayoutRun ? 250 : 70)
        : new Map();
    firstLayoutRun = false;

    const focusedKey = manualFocusKey ?? autoFocusKey;
    const focusedEdge = allEdges().find((e) => edgeKey(e) === focusedKey) || null;

    pane.update({
      width,
      height,
      nodes: clusterNames,
      edges,
      positions,
      focusedEdgeKey: focusedKey,
      onEdgeClick: (edge) => {
        manualFocusKey = edgeKey(edge);
        recomputeLayoutAndRender();
      },
    });
    focusPanel.update(focusedEdge);
    renderSingletons();
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

  // ── Callbacks for lookupAll ────────────────────────────────────────
  function onArtistComplete(name, merged, summary = {}) {
    if (finalized) return;
    if (completedNames.has(name)) return;
    completedNames.add(name);
    completedResults.push({ name, merged, closure: summary.closure ?? new Set() });

    prevGraph = currentGraph;
    currentGraph = buildGraph(completedResults);
    const { newEdges } = diffGraph(prevGraph, currentGraph);

    if (!manualFocusKey && newEdges.length > 0 && !autoFocusKey) {
      autoFocusKey = edgeKey(newEdges[0].edge);
    }

    updateProgress();
    recomputeLayoutAndRender();
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
