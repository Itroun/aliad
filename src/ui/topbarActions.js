// The right-hand cluster shared by every screen's topbar: an "about" trigger
// next to the theme toggle. Mounted in place of the bare theme toggle so the two
// controls always travel together and stay right-aligned.
import { mountThemeToggle } from './themeToggle.js';
import { openAboutDialog } from './aboutDialog.js';

export function mountTopbarActions(topbar) {
  if (!topbar) return;
  const actions = document.createElement('div');
  actions.className = 'topbar-actions';

  const about = document.createElement('button');
  about.type = 'button';
  about.className = 'about-btn';
  about.textContent = 'about';
  about.addEventListener('click', openAboutDialog);
  actions.append(about);

  topbar.append(actions);
  mountThemeToggle(actions); // toggle sits inside the cluster, right of "about"
  return actions;
}
