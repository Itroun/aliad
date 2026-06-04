const NOOP_PROBE = {
  el: null,
  reset() {},
  onAttempt() {},
  note() {},
  cache() {},
  serverCache() {},
};

export function createDevProbe() {
  if (import.meta.env.MODE === 'production') return NOOP_PROBE;

  const el = document.createElement('section');
  el.className = 'dev-probe';
  el.hidden = true;

  const heading = document.createElement('h3');
  heading.textContent = 'Dev probe \u2014 dev build only';

  const list = document.createElement('ul');

  el.append(heading, list);

  const rows = new Map();
  let cacheRow = null;
  let serverCacheRow = null;
  const serverTally = { HIT: 0, MISS: 0, STALE: 0 };

  function reset() {
    rows.clear();
    cacheRow = null;
    serverCacheRow = null;
    serverTally.HIT = 0;
    serverTally.MISS = 0;
    serverTally.STALE = 0;
    list.replaceChildren();
    el.hidden = true;
  }

  function onAttempt({ path, state, attempts, reason }) {
    el.hidden = false;

    let li = rows.get(path);
    if (!li) {
      li = document.createElement('li');
      rows.set(path, li);
      list.append(li);
    }

    li.className = `dev-probe-item state-${state}`;

    const parts = [`${path} \u2192 ${state}`];
    if (Array.isArray(attempts) && attempts.length) {
      parts.push(`attempts=${attempts.length}`);
      const last = attempts[attempts.length - 1];
      if (last?.status) parts.push(`last-status=${last.status}`);
      if (last?.challenge) parts.push('challenge-detected');
      if (last?.error) parts.push(`net-error`);
    }
    if (state === 'fail' && reason) parts.push(reason);

    li.textContent = parts.join(' \u00b7 ');
  }

  function note(text) {
    el.hidden = false;
    const li = document.createElement('li');
    li.className = 'dev-probe-item state-info';
    li.textContent = text;
    list.append(li);
  }

  function cache(stats) {
    if (!stats) return;
    el.hidden = false;
    if (!cacheRow) {
      cacheRow = document.createElement('li');
      cacheRow.className = 'dev-probe-item state-info';
      list.append(cacheRow);
    }
    cacheRow.textContent =
      `cache · hits=${stats.hits} · misses=${stats.misses}` +
      ` · stale=${stats.stale} · writes=${stats.writes}`;
  }

  // Rolling tally of the shared L2 (proxy) cache outcomes, distinct from the
  // per-browser L1 (IndexedDB) `cache` row above. Run a lineup in a second
  // browser to see HITs climb — that proves the cross-visitor cache works.
  function serverCache(outcome) {
    if (!outcome || !(outcome in serverTally)) return;
    serverTally[outcome]++;
    el.hidden = false;
    if (!serverCacheRow) {
      serverCacheRow = document.createElement('li');
      serverCacheRow.className = 'dev-probe-item state-info';
      list.append(serverCacheRow);
    }
    serverCacheRow.textContent =
      `server-cache · HIT=${serverTally.HIT}` +
      ` · MISS=${serverTally.MISS} · STALE=${serverTally.STALE}`;
  }

  return { el, reset, onAttempt, note, cache, serverCache };
}
