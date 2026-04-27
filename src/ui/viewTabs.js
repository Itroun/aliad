export function createViewTabs({ onChange } = {}) {
  const el = document.createElement('div');
  el.className = 'view-tabs';
  el.innerHTML = `
    <button type="button" class="view-tab" data-view="input">Lineup</button>
    <button type="button" class="view-tab" data-view="graph">Connections</button>
  `;

  const buttons = [...el.querySelectorAll('.view-tab')];
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => onChange?.(btn.dataset.view));
  });

  function setActive(view) {
    buttons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === view);
    });
  }

  return { el, setActive };
}
