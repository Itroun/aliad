// Right-panel "Connections" section: a header for the selected cluster plus one
// collapsible evidence block per edge in that cluster.
// Exposes update(cluster) to swap in a new focused cluster; null shows placeholder.

export function createFocusPanel() {
  const root = document.createElement('div');
  root.className = 'panel-section panel-connection';

  root.innerHTML = `
    <div class="panel-body"></div>
  `;

  const body = root.querySelector('.panel-body');
  let currentClusterId = null;
  // Per-edge expand/collapse state, keyed by "a||b". Defaults to expanded;
  // clusters are small (1–5 edges) so everything opens by default.
  const expanded = new Map();

  function edgeKey(edge) {
    return `${edge.a}||${edge.b}`;
  }

  function renderPlaceholder() {
    body.innerHTML = `<div class="panel-placeholder">Click a cluster to see its connections.</div>`;
  }

  function edgeSection(edge) {
    const key = edgeKey(edge);
    const isOpen = expanded.get(key) !== false;
    const count = edge.evidence.length;
    const label = count === 1 ? 'connection' : 'connections';
    const ev = edge.evidence
      .map((e, i) => {
        const hops = e.hops
          .map(
            (h, j) =>
              (j > 0 ? '<span class="sep">·</span>' : '') +
              `<span class="rel">${escape(h.rel)}</span>` +
              ' ' +
              `<span class="with">${escape(h.with)}</span>`,
          )
          .join('');
        return `
          <div class="evidence-row">
            <span class="evidence-idx">${String(i + 1).padStart(2, '0')}</span>
            <div class="evidence-body">
              <div class="evidence-person">${escape(e.person)}</div>
              <div class="evidence-hops">${hops}</div>
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="connection-edge" data-edge-key="${escape(key)}">
        <div class="connection-title">
          <span>${escape(edge.a)}</span>
          <span class="connection-sep">↔</span>
          <span>${escape(edge.b)}</span>
        </div>
        <button type="button" class="connection-toggle ${isOpen ? 'is-expanded' : ''}">
          <svg class="toggle-caret" width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M1 0l6 4-6 4z"/></svg>
          <span>${count} ${label}</span>
        </button>
        <div class="connection-evidence aliad-fadein ${isOpen ? 'is-open' : ''}">${ev}</div>
      </div>
    `;
  }

  function renderCluster(cluster) {
    const edges = cluster.edges;

    body.innerHTML = `
      <div class="cluster-edges">${edges.map(edgeSection).join('')}</div>
    `;

    body.querySelectorAll('.connection-edge').forEach((section) => {
      const key = section.getAttribute('data-edge-key');
      section.querySelector('.connection-toggle').addEventListener('click', () => {
        const next = expanded.get(key) === false;
        expanded.set(key, next);
        section.querySelector('.connection-toggle').classList.toggle('is-expanded', next);
        section.querySelector('.connection-evidence').classList.toggle('is-open', next);
      });
    });
  }

  function update(cluster) {
    const nextId = cluster ? cluster.id : null;
    if (nextId !== currentClusterId) {
      expanded.clear();
      currentClusterId = nextId;
    }
    if (!cluster) renderPlaceholder();
    else renderCluster(cluster);
  }

  update(null);

  return { el: root, update };
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
