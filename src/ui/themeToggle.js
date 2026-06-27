// Light/dark theme. The two aesthetics ("Constellation" dark, "Nautical
// Chart" light) are pure CSS — switching is just a class on <html>, which the
// stylesheet keys all its theme-scoped rules off. Choice persists in
// localStorage; dark is the default.

const STORAGE_KEY = 'aliad-theme';
const THEMES = ['dark', 'light'];

function current() {
  return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
}

function apply(theme) {
  const root = document.documentElement;
  root.classList.toggle('theme-light', theme === 'light');
  root.classList.toggle('theme-dark', theme !== 'light');
}

// Set the initial theme class as early as possible so the first paint is themed.
export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* private mode / blocked storage — fall back to default */
  }
  apply(THEMES.includes(saved) ? saved : 'dark');
}

// Build a top-bar toggle button. Each screen mounts its own (they have
// separate top bars), but they all flip the same shared <html> class.
const mounted = new Set();

export function mountThemeToggle(container) {
  if (!container) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.setAttribute('aria-label', 'Toggle light/dark theme');

  const sync = () => {
    const dark = current() === 'dark';
    // Show the glyph for the theme you'd switch TO.
    btn.textContent = dark ? '☀' : '☾';
    btn.title = dark ? 'Switch to light (Nautical Chart)' : 'Switch to dark (Constellation)';
  };

  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    // Keep every mounted toggle's glyph in sync.
    mounted.forEach((fn) => fn());
  });

  mounted.add(sync);
  sync();
  container.append(btn);
  return btn;
}
