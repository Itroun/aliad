const SECTIONS = [
  { key: 'aliases', label: 'Also known as' },
  { key: 'groups', label: 'Member of' },
  { key: 'members', label: 'Members' },
  { key: 'relatedProjects', label: 'Related projects' },
];

export function createResults(container) {
  let cards = new Map();

  function clear() {
    cards = new Map();
    container.replaceChildren();
  }

  function ensureCard(artistName) {
    if (cards.has(artistName)) return cards.get(artistName);
    const card = renderCard(artistName);
    cards.set(artistName, card);
    container.append(card.root);
    return card;
  }

  function start(artistNames) {
    clear();
    for (const name of artistNames) ensureCard(name);
  }

  function onArtistDone(artistName, merged) {
    ensureCard(artistName).renderData(merged);
  }

  function onArtistComplete(artistName, merged, summary) {
    const card = ensureCard(artistName);
    card.renderData(merged);
    card.markComplete(summary);
  }

  function renderClusters({ clusters, singletons }) {
    cards = new Map();
    container.replaceChildren();

    if (clusters.length) {
      const section = document.createElement('section');
      section.className = 'clusters';
      const h2 = document.createElement('h2');
      h2.textContent = 'Same act, different names';
      section.append(h2);
      for (const cluster of clusters) {
        const article = document.createElement('article');
        article.className = 'cluster';
        const ul = document.createElement('ul');
        for (const name of cluster.names) {
          const li = document.createElement('li');
          li.textContent = name;
          ul.append(li);
        }
        article.append(ul);
        section.append(article);
      }
      container.append(section);
    }

    if (singletons.length) {
      const section = document.createElement('section');
      section.className = 'singletons';
      const h2 = document.createElement('h2');
      h2.textContent = 'No aliases on the lineup';
      section.append(h2);
      const ul = document.createElement('ul');
      for (const { name } of singletons) {
        const li = document.createElement('li');
        li.textContent = name;
        ul.append(li);
      }
      section.append(ul);
      container.append(section);
    }

    if (!clusters.length && !singletons.length) {
      const empty = document.createElement('p');
      empty.className = 'results-empty';
      empty.textContent = 'No results.';
      container.append(empty);
    }
  }

  return { start, onArtistDone, onArtistComplete, renderClusters, clear };
}

function renderCard(artistName) {
  const root = document.createElement('article');
  root.className = 'artist-card';

  const heading = document.createElement('h2');
  heading.textContent = artistName;
  root.append(heading);

  const status = document.createElement('p');
  status.className = 'artist-status';
  status.textContent = 'Searching\u2026';
  root.append(status);

  const body = document.createElement('div');
  body.className = 'artist-body';
  root.append(body);

  function renderData(merged) {
    body.replaceChildren();
    let anyContent = false;
    for (const { key, label } of SECTIONS) {
      const entries = merged?.[key] ?? [];
      if (!entries.length) continue;
      anyContent = true;
      const section = document.createElement('section');
      const h3 = document.createElement('h3');
      h3.textContent = label;
      const ul = document.createElement('ul');
      for (const entry of entries) {
        const li = document.createElement('li');
        li.textContent = entry.via ? `${entry.name} (as ${entry.via})` : entry.name;
        ul.append(li);
      }
      section.append(h3, ul);
      body.append(section);
    }
    if (!anyContent) {
      const empty = document.createElement('p');
      empty.className = 'artist-empty';
      empty.textContent = 'No aliases, groups, members, or related projects found.';
      body.append(empty);
    }
  }

  function markComplete({ queried = [], errored = [] } = {}) {
    const parts = [];
    if (queried.length) {
      parts.push(`Showing results from ${formatList(queried)}`);
    } else {
      parts.push('Done');
    }
    if (errored.length) {
      parts.push(`${formatList(errored)} unavailable`);
    }
    status.textContent = parts.join(' \u00b7 ');
    status.classList.toggle('has-error', errored.length > 0);
  }

  return { root, renderData, markComplete };
}

function formatList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
