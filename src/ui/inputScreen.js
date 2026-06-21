import { dedupeNames } from '../core/merge.js';
import { createViewTabs } from './viewTabs.js';

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

const MAX_URLS = 10;

export function createInputScreen({ onSubmit, onCancel, onViewChange } = {}) {
  const root = document.createElement('div');
  root.className = 'screen screen-input';

  root.innerHTML = `
    <div class="grid-bg"></div>
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-logo">aka</span>
        <span class="wordmark-tagline">Lineup identity graph</span>
      </div>
      <div class="topbar-tabs"></div>
    </header>
    <main class="input-main">
      <div class="input-hero">
        <div class="eyebrow"><span class="eyebrow-num">01</span><span>Drop in a lineup</span></div>
        <h1 class="input-title">Who&rsquo;s actually<br/>on the bill?</h1>
        <p class="input-lede">
          Paste a festival lineup or link one from the web.
          <span class="lede-accent"> aka </span>
          finds the other names each act performs under &mdash;
          the side projects, the aliases, the shared members.
        </p>
      </div>

      <label class="field field-textarea">
        <div class="field-labelrow">
          <span class="field-label">Paste lineup</span>
          <button type="button" class="link-btn example-btn">Try an example &darr;</button>
        </div>
        <textarea class="lineup-input"
          rows="10"
          placeholder="One act per line, or paste the raw HTML&#10;from the festival website. We&rsquo;ll figure it out."
        ></textarea>
      </label>

      <div class="divider-or">
        <span class="divider-rule"></span>
        <span class="divider-or-label">or</span>
        <span class="divider-rule"></span>
      </div>

      <div class="field field-url">
        <div class="field-labelrow">
          <span class="field-label">Link to a lineup</span>
          <span class="field-hint">One per stage &middot; we merge them</span>
        </div>
        <div class="url-list"></div>
        <button type="button" class="link-btn url-add">+ Add another URL</button>
      </div>

      <div class="decode-row">
        <button type="button" class="decode-btn" disabled>
          <span>Decode lineup</span><span class="decode-arrow">&rarr;</span>
        </button>
        <span class="decode-counter"></span>
      </div>

      <div class="input-footer">
        <span>Works with plain text &middot; HTML &middot; URLs</span>
        <span>aka / v0.1</span>
      </div>
    </main>
  `;

  const textarea = root.querySelector('.lineup-input');
  const urlList = root.querySelector('.url-list');
  const urlAdd = root.querySelector('.url-add');
  const decodeBtn = root.querySelector('.decode-btn');
  const exampleBtn = root.querySelector('.example-btn');
  const counter = root.querySelector('.decode-counter');

  let pastedHTML = null;
  let pasteFormat = null;
  let justPasted = false;

  function clearPasteState() {
    pastedHTML = null;
    pasteFormat = null;
  }

  // ---- URL rows (one per festival stage page; merged on submit) ----

  function urlInputs() {
    return [...urlList.querySelectorAll('.url-input')];
  }

  // Trimmed, non-empty, de-duplicated URLs in row order.
  function collectUrls() {
    const seen = new Set();
    const urls = [];
    for (const input of urlInputs()) {
      const value = input.value.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      urls.push(value);
    }
    return urls;
  }

  function syncRowChrome() {
    const rows = [...urlList.querySelectorAll('.url-wrap')];
    // The remove button is pointless when a single empty row is all there is.
    const removable = rows.length > 1;
    for (const row of rows) {
      row.querySelector('.url-remove').hidden = !removable;
    }
    urlAdd.hidden = rows.length >= MAX_URLS;
  }

  function addUrlRow(focus = false) {
    if (urlList.querySelectorAll('.url-wrap').length >= MAX_URLS) return;
    const row = document.createElement('div');
    row.className = 'url-wrap';
    row.innerHTML = `
      <span class="url-prefix">&#x2197;</span>
      <input type="text" class="url-input" placeholder="https://festival.example/lineup" />
      <button type="button" class="url-remove" aria-label="Remove URL">&times;</button>
    `;
    row.querySelector('.url-input').addEventListener('input', onUrlInput);
    row.querySelector('.url-remove').addEventListener('click', () => removeUrlRow(row));
    urlList.append(row);
    syncRowChrome();
    if (focus) row.querySelector('.url-input').focus();
  }

  function removeUrlRow(row) {
    onCancel?.();
    row.remove();
    if (urlList.querySelectorAll('.url-wrap').length === 0) addUrlRow();
    syncRowChrome();
    updateCounter();
  }

  // Back to a single empty row (mutual exclusion: textarea wins).
  function resetUrlRows() {
    urlList.replaceChildren();
    addUrlRow();
  }

  function onUrlInput() {
    onCancel?.();
    if (collectUrls().length) {
      textarea.value = '';
      clearPasteState();
    }
    updateCounter();
  }

  function updateCounter() {
    const text = textarea.value.trim();
    const urls = collectUrls();
    const hasInput = Boolean(text || urls.length);
    decodeBtn.disabled = !hasInput;
    if (!hasInput) {
      counter.textContent = '';
      return;
    }
    const lines = text ? text.split(/\n+/).filter(Boolean).length : 0;
    const bits = [];
    if (lines) bits.push(`${lines} line${lines === 1 ? '' : 's'}`);
    if (urls.length) bits.push(`${urls.length} url${urls.length === 1 ? '' : 's'}`);
    counter.textContent = bits.join(' · ');
  }

  addUrlRow();

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
    if (textarea.value.trim()) resetUrlRows();
    updateCounter();
  });

  urlAdd.addEventListener('click', () => addUrlRow(true));

  exampleBtn.addEventListener('click', () => {
    textarea.value = EXAMPLE_LINEUP;
    resetUrlRows();
    clearPasteState();
    pasteFormat = 'plain-text';
    updateCounter();
    textarea.focus();
  });

  decodeBtn.addEventListener('click', () => {
    const urls = collectUrls();
    const text = textarea.value.trim();
    if (urls.length) {
      onSubmit?.({ type: 'url', urls });
    } else if (text && pastedHTML) {
      onSubmit?.({ type: 'paste-html', value: text, html: pastedHTML, pasteFormat: 'html' });
    } else if (text) {
      onSubmit?.({ type: 'text', value: text, pasteFormat });
    }
  });

  const tabs = createViewTabs({ onChange: (v) => onViewChange?.(v) });
  tabs.setActive('input');
  root.querySelector('.topbar-tabs').append(tabs.el);

  return { el: root, setActiveView: tabs.setActive };
}
