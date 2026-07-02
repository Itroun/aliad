export function createViewTabs({ onChange } = {}) {
  const el = document.createElement('div');
  el.className = 'view-tabs';
  // Deliberately NOT an ARIA tablist: these switch whole screens (and rewrite the
  // URL/history), so they're navigation between views, not tabpanels within one
  // view. A labelled group + `aria-current` on the active button conveys state
  // without the tabpanel/aria-controls wiring and roving-tabindex arrow keys a
  // real tablist would obligate. See ACCESSIBILITY.md.
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Switch view');
  el.innerHTML = `
    <button type="button" class="view-tab" data-view="input">Lineup</button>
    <button type="button" class="view-tab" data-view="graph">Map</button>
    <button type="button" class="view-tab" data-view="list">List</button>
  `;

  const buttons = [...el.querySelectorAll('.view-tab')];
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => onChange?.(btn.dataset.view));
  });

  function setActive(view) {
    buttons.forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('is-active', active);
      // `page` (not `true`): the active tab is the current view within the app.
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  return { el, setActive };
}
