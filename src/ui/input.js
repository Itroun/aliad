export function parseLineup(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
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

  const banner = document.createElement('p');
  banner.className = 'paste-banner';
  banner.hidden = true;
  banner.textContent = 'Rich content detected \u2014 webpage formatting will be used for better extraction.';

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'paste-banner-dismiss';
  dismissBtn.textContent = '\u00d7';
  banner.append(dismissBtn);

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

  form.append(label, textarea, banner, urlLabel, urlInput, button);

  let pastedHTML = null;

  function clearHTML() {
    pastedHTML = null;
    banner.hidden = true;
  }

  let justPasted = false;

  textarea.addEventListener('paste', (event) => {
    onCancel?.();
    const html = event.clipboardData?.getData('text/html');
    if (html && html.includes('<')) {
      pastedHTML = html;
      banner.hidden = false;
      justPasted = true;
    } else {
      clearHTML();
    }
  });

  dismissBtn.addEventListener('click', clearHTML);

  textarea.addEventListener('input', () => {
    onCancel?.();
    if (justPasted) {
      justPasted = false;
    } else {
      clearHTML();
    }
    if (textarea.value.trim()) urlInput.value = '';
  });
  urlInput.addEventListener('input', () => {
    onCancel?.();
    if (urlInput.value.trim()) {
      textarea.value = '';
      clearHTML();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    const text = textarea.value.trim();
    if (url) {
      onSubmit({ type: 'url', value: url });
    } else if (text && pastedHTML) {
      onSubmit({ type: 'paste-html', value: text, html: pastedHTML });
    } else if (text) {
      onSubmit({ type: 'text', value: text });
    }
  });

  return form;
}
