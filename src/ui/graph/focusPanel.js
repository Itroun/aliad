// Right-panel "Connection" section: title, collapsible evidence list.
// Exposes update(edge) to swap in a new focused edge; null to show placeholder.

export function createFocusPanel() {
  const root = document.createElement('div');
  root.className = 'panel-section panel-connection';

  root.innerHTML = `
    <div class="panel-eyebrow">Connection</div>
    <div class="panel-body"></div>
  `;

  const body = root.querySelector('.panel-body');
  let expanded = false;
  let currentEdgeKey = null;

  function edgeKey(edge) {
    return edge ? `${edge.a}||${edge.b}` : null;
  }

  function renderPlaceholder() {
    body.innerHTML = `<div class="panel-placeholder">Click a connection to see who links them.</div>`;
  }

  function renderEdge(edge) {
    const count = edge.evidence.length;
    const personWord = count === 1 ? 'person' : 'people';
    const ev = edge.evidence
      .map((e, i) => {
        const hops = e.hops
          .map(
            (h, j) =>
              (j > 0 ? '<span class="sep">·</span>' : '') +
              `<span class="rel">${escape(h.rel)}</span>` +
              '<span class="arrow">→</span>' +
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

    body.innerHTML = `
      <div class="connection-title">
        <span>${escape(edge.a)}</span>
        <span class="connection-sep">↔</span>
        <span>${escape(edge.b)}</span>
      </div>
      <button type="button" class="connection-toggle ${expanded ? 'is-expanded' : ''}">
        <svg class="toggle-caret" width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M1 0l6 4-6 4z"/></svg>
        <span>Connected by ${count} ${personWord}</span>
      </button>
      <div class="connection-evidence aka-fadein ${expanded ? 'is-open' : ''}">${ev}</div>
    `;

    body.querySelector('.connection-toggle').addEventListener('click', () => {
      expanded = !expanded;
      const toggle = body.querySelector('.connection-toggle');
      const list = body.querySelector('.connection-evidence');
      toggle.classList.toggle('is-expanded', expanded);
      list.classList.toggle('is-open', expanded);
    });
  }

  function update(edge) {
    const nextKey = edgeKey(edge);
    if (nextKey !== currentEdgeKey) {
      expanded = false;
      currentEdgeKey = nextKey;
    }
    if (!edge) renderPlaceholder();
    else renderEdge(edge);
  }

  update(null);

  return { el: root, update };
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
