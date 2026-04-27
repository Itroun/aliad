import { dedupeNames } from '../core/merge.js';
import { createViewTabs } from './viewTabs.js';

export function parseLineup(text) {
  return dedupeNames(String(text ?? '').split('\n'));
}

const EXAMPLE_LINEUP = [
  'Atmos',
  'Battle of the Future Buddhas',
  'Blue Planet Corporation',
  'Doof',
  'Eat Static',
  'Growling Mad Scientists',
  'Filteria',
  'Ultravibe',
  '1200mic',
  'Bumbling Loons',
  'Dickster',
  'Etnica',
  'Green Nuns of the Revolution',
  'Pleiadians',
].join('\n');

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

      <label class="field field-url">
        <div class="field-labelrow">
          <span class="field-label">Link to a lineup</span>
        </div>
        <div class="url-wrap">
          <span class="url-prefix">&#x2197;</span>
          <input type="text" class="url-input" placeholder="https://festival.example/lineup" />
        </div>
      </label>

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
  const urlInput = root.querySelector('.url-input');
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

  function updateCounter() {
    const text = textarea.value.trim();
    const url = urlInput.value.trim();
    const hasInput = Boolean(text || url);
    decodeBtn.disabled = !hasInput;
    if (!hasInput) {
      counter.textContent = '';
      return;
    }
    const lines = text ? text.split(/\n+/).filter(Boolean).length : 0;
    const bits = [];
    if (lines) bits.push(`${lines} line${lines === 1 ? '' : 's'}`);
    if (url) bits.push(bits.length ? '+ 1 url' : '1 url');
    counter.textContent = bits.join(' · ');
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
    if (textarea.value.trim()) urlInput.value = '';
    updateCounter();
  });

  urlInput.addEventListener('input', () => {
    onCancel?.();
    if (urlInput.value.trim()) {
      textarea.value = '';
      clearPasteState();
    }
    updateCounter();
  });

  exampleBtn.addEventListener('click', () => {
    textarea.value = EXAMPLE_LINEUP;
    urlInput.value = '';
    clearPasteState();
    pasteFormat = 'plain-text';
    updateCounter();
    textarea.focus();
  });

  decodeBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    const text = textarea.value.trim();
    if (url) {
      onSubmit?.({ type: 'url', value: url });
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
