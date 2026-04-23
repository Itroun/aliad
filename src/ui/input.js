import { dedupeNames } from '../core/merge.js';

export function parseLineup(text) {
  return dedupeNames(String(text ?? '').split('\n'));
}

export function createInput({ onSubmit, onCancel }) {
  const form = document.createElement('form');
  form.className = 'lineup-form';

  const label = document.createElement('label');
  label.htmlFor = 'lineup';
  label.textContent = 'Paste a festival lineup or artist list:';

  const textarea = document.createElement('textarea');
  textarea.id = 'lineup';
  textarea.name = 'lineup';
  textarea.rows = 10;
  textarea.placeholder = 'Infected Mushroom\nShpongle\nAphex Twin';

  const urlLabel = document.createElement('label');
  urlLabel.htmlFor = 'lineup-url';
  urlLabel.textContent = 'Or paste a lineup URL:';
  urlLabel.className = 'url-label';

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.id = 'lineup-url';
  urlInput.name = 'url';
  urlInput.placeholder = 'https://festival-website.com/lineup';
  urlInput.className = 'url-input';

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Look up';

  form.append(label, textarea, urlLabel, urlInput, button);

  let pastedHTML = null;
  let pasteFormat = null;
  let justPasted = false;

  function clearPasteState() {
    pastedHTML = null;
    pasteFormat = null;
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
    if (justPasted) {
      justPasted = false;
    } else {
      clearPasteState();
    }
    if (textarea.value.trim()) urlInput.value = '';
  });
  urlInput.addEventListener('input', () => {
    onCancel?.();
    if (urlInput.value.trim()) {
      textarea.value = '';
      clearPasteState();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    const text = textarea.value.trim();
    if (url) {
      onSubmit({ type: 'url', value: url });
    } else if (text && pastedHTML) {
      onSubmit({ type: 'paste-html', value: text, html: pastedHTML, pasteFormat: 'html' });
    } else if (text) {
      onSubmit({ type: 'text', value: text, pasteFormat });
    }
  });

  return form;
}
