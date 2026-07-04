import { createViewTabs } from './viewTabs.js';
import { mountTopbarActions } from './topbarActions.js';

export function createEmptyGraphScreen({ onViewChange } = {}) {
  const root = document.createElement('div');
  root.className = 'screen screen-graph screen-graph-empty';
  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aliad</span>
      </div>
      <div class="topbar-tabs"></div>
    </header>
    <section class="empty-graph-body">
      <div class="empty-graph-card">
        <h2 class="empty-graph-title">Nothing mapped yet</h2>
        <p class="empty-graph-msg">Add a lineup and its connections will appear here as a map you can explore.</p>
        <button type="button" class="decode-btn empty-graph-go">
          <span>Go to lineup</span>
        </button>
      </div>
    </section>
  `;

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('graph');
  root.querySelector('.topbar-tabs').append(tabs.el);
  mountTopbarActions(root.querySelector('.topbar'));

  root.querySelector('.empty-graph-go').addEventListener('click', () => onViewChange?.('input'));

  return { el: root, setActiveView: tabs.setActive };
}
