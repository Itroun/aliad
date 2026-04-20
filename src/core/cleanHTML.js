const DROP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'link',
  'meta',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'picture',
  'source',
  'video',
  'audio',
].join(', ');

export function cleanHTML(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  for (const el of doc.querySelectorAll(DROP_SELECTOR)) el.remove();
  stripComments(doc);
  stripAttributes(doc);
  return collapseWhitespace(doc.body?.innerHTML ?? '');
}

function stripComments(doc) {
  const walker = doc.createTreeWalker(doc, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments = [];
  let node = walker.nextNode();
  while (node) {
    comments.push(node);
    node = walker.nextNode();
  }
  for (const c of comments) c.remove();
}

function stripAttributes(doc) {
  for (const el of doc.body?.querySelectorAll('*') ?? []) {
    for (const attr of [...el.attributes]) {
      el.removeAttribute(attr.name);
    }
  }
}

function collapseWhitespace(html) {
  return html.replace(/\s+/g, ' ').trim();
}
