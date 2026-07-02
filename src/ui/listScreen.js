// List view: the lineup results as scrollable, copy-pasteable text. Doubles as
// a lightweight export — the Copy button yields the same plain-text block the
// graph encodes, for pasting into notes / chat / a spreadsheet. Fed live from
// the graph screen's current graph via update(); shows an empty state until
// results arrive. Plain DOM, mirrors emptyGraphScreen.js.

import { buildExportModel, toPlainText } from '../core/lineupExport.js';
import { noConnectionsHeading } from '../core/labels.js';
import { createViewTabs } from './viewTabs.js';
import { mountThemeToggle } from './themeToggle.js';

export function createListScreen({ onViewChange } = {}) {
  const root = document.createElement('div');
  root.className = 'screen screen-list';
  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aliad</span>
      </div>
      <div class="topbar-tabs"></div>
      <div class="topbar-right">
        <button type="button" class="list-copy" hidden>Copy as text</button>
        <span class="visually-hidden" data-copy-status role="status" aria-live="polite"></span>
      </div>
    </header>
    <section class="list-body" aria-label="Lineup results">
      <div class="list-scroll"></div>
    </section>
  `;

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('list');
  root.querySelector('.topbar-tabs').append(tabs.el);
  mountThemeToggle(root.querySelector('.topbar'));

  const scroll = root.querySelector('.list-scroll');
  const copyBtn = root.querySelector('.list-copy');
  const copyStatus = root.querySelector('[data-copy-status]');

  let model = { clusters: [], singletons: [] };

  copyBtn.addEventListener('click', async () => {
    const text = toPlainText(model);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied('Copied', 'Lineup copied to clipboard');
    } catch {
      // Clipboard API unavailable / blocked (insecure context, denied perm):
      // select the text so the user can copy it manually.
      selectScrollText();
      flashCopied(
        'Press ⌘/Ctrl+C',
        'Copy failed — text selected; press Control or Command plus C to copy',
      );
    }
  });

  let copyResetTimer = null;
  // `label` is the visible button swap; `spoken` is the screen-reader wording
  // (the ⌘ glyph reads poorly, and the outcome deserves an explicit announce).
  function flashCopied(label, spoken) {
    copyBtn.textContent = label;
    copyBtn.classList.add('is-copied');
    copyStatus.textContent = spoken || label;
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyBtn.textContent = 'Copy as text';
      copyBtn.classList.remove('is-copied');
      copyStatus.textContent = ''; // reset so an identical next copy re-announces
    }, 1600);
  }

  function selectScrollText() {
    const range = document.createRange();
    range.selectNodeContents(scroll);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function renderEmpty() {
    copyBtn.hidden = true;
    // Drop the scroll padding so the card centres over the full region, matching
    // the map empty state (whose .empty-graph-body pads symmetrically).
    scroll.classList.add('is-empty');
    scroll.innerHTML = `
      <div class="list-empty">
        <div class="empty-graph-card">
          <h2 class="empty-graph-title">Nothing listed yet</h2>
          <p class="empty-graph-msg">Add a lineup and its connections will appear here as plain text you can copy out.</p>
          <button type="button" class="decode-btn list-empty-go"><span>Go to lineup</span></button>
        </div>
      </div>
    `;
    scroll
      .querySelector('.list-empty-go')
      ?.addEventListener('click', () => onViewChange?.('input'));
  }

  function render() {
    const hasContent = model.clusters.length > 0 || model.singletons.length > 0;
    if (!hasContent) {
      renderEmpty();
      return;
    }
    scroll.classList.remove('is-empty');
    copyBtn.hidden = false;

    const sections = [];

    if (model.clusters.length) {
      const blocks = model.clusters
        .flatMap((c) => c.edges)
        .map((edge) => {
          const evRows = edge.evidence
            .map((ev) => {
              const chain = ev.hops
                .map(
                  (h) =>
                    `<span class="list-rel">${escape(h.rel)}</span> ` +
                    `<span class="list-with">${escape(h.with)}</span>`,
                )
                .join('<span class="list-sep" aria-hidden="true"> · </span>');
              return `
                <li class="list-evidence">
                  <span class="list-person">${escape(ev.person)}</span>
                  <span class="list-chain">${chain}</span>
                </li>`;
            })
            .join('');
          return `
            <div class="list-edge">
              <div class="list-edge-title">
                <span>${escape(edge.a)}</span>
                <span class="list-edge-sep" aria-hidden="true">↔</span>
                <span>${escape(edge.b)}</span>
              </div>
              <ul class="list-evidence-rows">${evRows}</ul>
            </div>`;
        })
        .join('');
      sections.push(`
        <section class="list-section">
          <h2 class="list-heading">Connected acts</h2>
          <div class="list-edges">${blocks}</div>
        </section>`);
    }

    if (model.singletons.length) {
      const items = model.singletons.map((n) => `<li>${escape(n)}</li>`).join('');
      // Shared heading so the list and map views always read the same.
      sections.push(`
        <section class="list-section">
          <h2 class="list-heading">${escape(noConnectionsHeading(model.singletons.length))}</h2>
          <ul class="list-singletons">${items}</ul>
        </section>`);
    }

    scroll.innerHTML = sections.join('');
  }

  // Re-render from the graph screen's current graph. Called on every streamed
  // update and at finalize, so the list stays in step with the map.
  function update(graph, lineup = []) {
    model = buildExportModel(graph, { lineup });
    render();
  }

  renderEmpty();

  return { el: root, update, setActiveView: tabs.setActive };
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
