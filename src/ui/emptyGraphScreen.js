import { createViewTabs } from './viewTabs.js';

export function createEmptyGraphScreen({ onViewChange } = {}) {
  const root = document.createElement('div');
  root.className = 'screen screen-graph screen-graph-empty';
  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aliad</span>
        <span class="wordmark-tagline">Lineup identity graph</span>
      </div>
      <div class="topbar-tabs"></div>
    </header>
    <section class="empty-graph-body">
      <div class="empty-graph-card">
        <div class="empty-graph-eyebrow">No lineup yet</div>
        <p class="empty-graph-msg">Drop a lineup into the input view to see the connections graph.</p>
      </div>
    </section>
  `;

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('graph');
  root.querySelector('.topbar-tabs').append(tabs.el);

  return { el: root, setActiveView: tabs.setActive };
}
