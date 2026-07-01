import { dedupeNames } from '../core/merge.js';
import { classifyInput } from '../core/classifyInput.js';
import { createViewTabs } from './viewTabs.js';
import { mountThemeToggle } from './themeToggle.js';

export function parseLineup(text) {
  return dedupeNames(String(text ?? '').split('\n'));
}

const EXAMPLE_LINEUP = [
  'Atmos',
  'Battle of the Future Buddhas',
  'Filteria',
  'Ultravibe',
  'Moon Beasts',
  'Proxeeus',
  'DOOF',
  'The Infinity Project VS Excess Head',
  'Process',
  'Mark Allen',
  'Skizologic vc Filteria',
  'Cosmosis VS Laughing Buddha',
  'Psychaos',
  'Growling Mad Scientists',
].join('\n');

// Shown greyed in the empty field. Mixes plain names and a stage link so the one
// field visibly invites both kinds of input at once. Imaginary acts/festival.
const PLACEHOLDER = [
  'Nova Drift',
  'Cosmic Tide vs Aurora Veil',
  'The Glass Orchard',
  '',
  'https://festival.example/lineup',
  'https://festival.example/main-stage',
  'https://festival.example/lineup/forest-stage',
].join('\n');

// Whole-line URLs past this point are dropped on submit (abuse / runaway-paste
// guard). Plain lineup text is unaffected.
const MAX_URLS = 10;

export function createInputScreen({ onSubmit, onCancel, onViewChange } = {}) {
  const root = document.createElement('div');
  root.className = 'screen screen-input';

  // Dev-only quick-fill. A polished prod version is a future TODO.
  const showExample = import.meta.env.MODE !== 'production';

  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aliad</span>
      </div>
      <div class="topbar-tabs"></div>
    </header>
    <main class="input-main">
      <div class="input-hero">
        <div class="hero-stars" aria-hidden="true">
          <span class="star">&#x2726;</span><span class="rule"></span>
          <span class="star">&#x2726;</span><span class="rule"></span>
          <span class="star">&#x2726;</span>
        </div>
        <h1 class="input-title">Who&rsquo;s performing?</h1>
        <p class="input-lede">
          Paste a festival lineup, a link to a lineup or both.
          <span class="lede-accent"> aliad </span>
          finds the other names each act performs under, so you can see who&rsquo;s playing more than once.
        </p>
      </div>

      <div class="field field-paste">
        <div class="field-labelrow">
          <span class="field-hint">One act or link per line</span>
          ${showExample ? '<button type="button" class="link-btn example-btn">Try an example</button>' : ''}
        </div>
        <label class="visually-hidden" for="lineup-input">Festival lineup &mdash; paste artist names, a link, or both</label>
        <textarea id="lineup-input" class="lineup-input"
          rows="11"
          placeholder="${PLACEHOLDER}"
        ></textarea>
        <div class="field-readout" hidden>
          <span class="readout-icon" aria-hidden="true">&#x2726;</span>
          <span class="readout-text"></span>
        </div>
      </div>

      <div class="decode-row">
        <button type="button" class="decode-btn" disabled>
          <span class="decode-label">Map lineup</span><span class="decode-spinner" aria-hidden="true"></span>
        </button>
      </div>

      <div class="input-footer">
        <span class="footer-mark">aliad</span>
        <!-- TODO(deploy): point href at the real aliad repo. -->
        <a class="footer-link" href="https://github.com/example/aliad" target="_blank" rel="noopener noreferrer">github</a>
      </div>
    </main>
  `;

  const textarea = root.querySelector('.lineup-input');
  const decodeBtn = root.querySelector('.decode-btn');
  const decodeLabel = root.querySelector('.decode-label');
  const exampleBtn = root.querySelector('.example-btn');
  const readout = root.querySelector('.field-readout');
  const readoutText = root.querySelector('.readout-text');

  // Match the column beneath the hero (paste field, button row, footer rule) to
  // the rendered width of the "Who's performing?" title. The title scales with
  // the viewport, so re-measure when it resizes and publish it as --field-w.
  const inputTitle = root.querySelector('.input-title');
  const syncFieldWidth = () => {
    const w = inputTitle.getBoundingClientRect().width;
    if (w) root.style.setProperty('--field-w', `${Math.round(w)}px`);
  };
  new ResizeObserver(syncFieldWidth).observe(inputTitle);

  let pastedHTML = null;
  let pasteFormat = null;
  let justPasted = false;
  // While resolving input (URL fetch + LLM extraction) the form is locked and the
  // button becomes a live progress indicator. updateReadout() bails out so input
  // events can't re-enable the button mid-flight.
  let busy = false;

  function setBusy(label) {
    busy = true;
    root.classList.add('is-busy');
    decodeBtn.classList.add('is-busy');
    decodeBtn.disabled = true;
    decodeLabel.textContent = label;
  }

  function clearBusy() {
    busy = false;
    root.classList.remove('is-busy');
    decodeBtn.classList.remove('is-busy');
    decodeLabel.textContent = 'Map lineup';
    updateReadout(); // restore the enabled/disabled state from current input
  }

  function clearPasteState() {
    pastedHTML = null;
    pasteFormat = null;
  }

  // Live "what did we find" line under the field. Mirrors exactly what submit()
  // will do, so the auto-detection never feels like a black box: links it will
  // fetch, acts it will parse, or both.
  function updateReadout() {
    if (busy) return; // locked while resolving — clearBusy() re-runs this after
    const { urls, actCount } = classifyInput(textarea.value);
    const linkCount = Math.min(urls.length, MAX_URLS);
    const hasInput = Boolean(linkCount || actCount);
    decodeBtn.disabled = !hasInput;

    if (!hasInput) {
      readout.hidden = true;
      readoutText.textContent = '';
      return;
    }

    readout.hidden = false;
    readoutText.textContent = describe(linkCount, actCount);
  }

  function describe(linkCount, actCount) {
    const links = linkCount ? `${linkCount} link${linkCount === 1 ? '' : 's'}` : '';
    const acts = actCount ? `${actCount} act${actCount === 1 ? '' : 's'}` : '';
    const pageRead =
      linkCount === 1
        ? 'The page will be read for its lineup'
        : 'Each page will be read for its lineup';

    if (links && acts) {
      const pastedActs = actCount === 1 ? 'the pasted act' : 'the pasted acts';
      return `${links} + ${acts} found. ${pageRead}, then merged with ${pastedActs}.`;
    }
    if (links) {
      return linkCount === 1
        ? `${links} found. ${pageRead}.`
        : `${links} found. ${pageRead} and the lineups will be merged.`;
    }
    return acts;
  }

  textarea.addEventListener('paste', (event) => {
    onCancel?.();
    const html = event.clipboardData?.getData('text/html');
    if (html && html.includes('<')) {
      pastedHTML = html;
      pasteFormat = 'html';
    } else {
      pastedHTML = null;
      pasteFormat = 'plain-text';
    }
    justPasted = true;
  });

  textarea.addEventListener('input', () => {
    onCancel?.();
    if (justPasted) justPasted = false;
    else clearPasteState();
    updateReadout();
  });

  exampleBtn?.addEventListener('click', () => {
    textarea.value = EXAMPLE_LINEUP;
    clearPasteState();
    pasteFormat = 'plain-text';
    updateReadout();
    textarea.focus();
  });

  decodeBtn.addEventListener('click', () => {
    const { urls, text } = classifyInput(textarea.value);
    const capped = urls.slice(0, MAX_URLS);
    if (!capped.length && !text) return;
    onSubmit?.({
      urls: capped,
      text,
      // Rich-paste HTML only helps the text path; if every line was a URL there's
      // no lineup text for it to enrich, so drop it.
      html: text && pastedHTML ? pastedHTML : null,
      pasteFormat,
    });
  });

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('input');
  root.querySelector('.topbar-tabs').append(tabs.el);
  mountThemeToggle(root.querySelector('.topbar'));

  return { el: root, setActiveView: tabs.setActive, setBusy, clearBusy };
}
