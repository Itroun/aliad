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

  function start(artistNames, providerNames) {
    clear();
    for (const name of artistNames) {
      const card = ensureCard(name);
      for (const providerName of providerNames) {
        card.setProviderStatus(providerName, 'loading');
      }
    }
  }

  function onProviderResult(artistName, providerName, outcome) {
    const card = ensureCard(artistName);
    card.setProviderStatus(providerName, outcome.ok ? 'ok' : 'error', outcome.error);
  }

  function onArtistDone(artistName, merged) {
    const card = ensureCard(artistName);
    card.renderData(merged);
  }

  return { start, onProviderResult, onArtistDone, clear };
}

function renderCard(artistName) {
  const root = document.createElement('article');
  root.className = 'artist-card';

  const heading = document.createElement('h2');
  heading.textContent = artistName;
  root.append(heading);

  const status = document.createElement('p');
  status.className = 'artist-status';
  root.append(status);

  const body = document.createElement('div');
  body.className = 'artist-body';
  root.append(body);

  const providerStatuses = new Map();

  function refreshStatus() {
    const parts = [...providerStatuses.entries()].map(([provider, state]) => {
      if (state.status === 'loading') return `${provider}: searching…`;
      if (state.status === 'error') return `${provider}: error`;
      return `${provider}: done`;
    });
    status.textContent = parts.join(' · ');
  }

  function setProviderStatus(provider, statusValue, error) {
    providerStatuses.set(provider, { status: statusValue, error });
    refreshStatus();
  }

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
        li.textContent = entry.via
          ? `${entry.name} (as ${entry.via})`
          : entry.name;
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

  return { root, setProviderStatus, renderData };
}
