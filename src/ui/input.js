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

export function createInput({ onSubmit }) {
  const form = document.createElement('form');
  form.className = 'lineup-form';

  const label = document.createElement('label');
  label.htmlFor = 'lineup';
  label.textContent = 'Paste your festival lineup — one artist per line:';

  const textarea = document.createElement('textarea');
  textarea.id = 'lineup';
  textarea.name = 'lineup';
  textarea.rows = 10;
  textarea.placeholder = 'Infected Mushroom\nShpongle\nAphex Twin';

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Look up';

  form.append(label, textarea, button);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const names = parseLineup(textarea.value);
    if (names.length) onSubmit(names);
  });

  return form;
}
