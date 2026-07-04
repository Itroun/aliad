// The About surface. A single native <dialog> (focus-trap, Escape-to-close, and
// a backdrop come for free) built lazily on first open and reused thereafter.
// Its copy is generated from the repo-root about.md at build time (Vite ?raw), so
// that file stays the single source of truth — edit the prose there, not here.
import aboutMarkdown from '../../about.md?raw';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'); // the link renderer drops URLs into href="…"
}

// Inline pass: escape first (trusted first-party content, but good hygiene), then
// links, then bold. Order matters so we don't rewrite inside a URL.
function renderInline(text) {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Deliberately supports only the constructs about.md uses: #/## headings,
// ordered + unordered lists, bold, links, and blank-line-separated paragraphs.
// Keep the source within that subset (or extend this) rather than reaching for a
// Markdown dependency.
function renderMarkdown(md) {
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = (kind) => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    let m;
    // A blank line ends a paragraph but NOT a list: about.md separates list items
    // with blank lines (loose lists), and closing here would split one list into
    // several single-item lists — restarting <ol> numbering at 1 each time. The
    // list is instead closed lazily when a heading or paragraph actually follows.
    if (!line) {
      flushPara();
    } else if ((m = line.match(/^##\s+(.*)/))) {
      flushPara();
      closeList();
      out.push(`<h3>${renderInline(m[1])}</h3>`);
    } else if ((m = line.match(/^#\s+(.*)/))) {
      flushPara();
      closeList();
      out.push(`<h2 id="about-title">${renderInline(m[1])}</h2>`);
    } else if ((m = line.match(/^-\s+(.*)/))) {
      flushPara();
      openList('ul'); // openList closes a list of the other kind first
      out.push(`<li>${renderInline(m[1])}</li>`);
    } else if ((m = line.match(/^\d+\.\s+(.*)/))) {
      flushPara();
      openList('ol');
      out.push(`<li>${renderInline(m[1])}</li>`);
    } else {
      closeList(); // a paragraph after list items ends the list
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join('\n');
}

let dialogEl = null;

function build() {
  const d = document.createElement('dialog');
  d.className = 'about-dialog';
  d.setAttribute('aria-labelledby', 'about-title');
  d.innerHTML = `
    <button type="button" class="about-close" aria-label="Close about">&#x2715;</button>
    <div class="about-content">${renderMarkdown(aboutMarkdown)}</div>
  `;
  d.querySelector('.about-close').addEventListener('click', () => d.close());
  // A click that lands on the dialog element itself is the backdrop / box margin
  // (content clicks target the inner children), so treat it as dismiss.
  d.addEventListener('click', (event) => {
    if (event.target === d) d.close();
  });
  document.body.append(d);
  return d;
}

export function openAboutDialog() {
  if (!dialogEl) dialogEl = build();
  dialogEl.showModal();
}
