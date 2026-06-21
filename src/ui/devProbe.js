const NOOP_PROBE = {
  el: null,
  reset() {},
  onAttempt() {},
  note() {},
  providerResult() {},
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
  // One collapsible group per lineup act, so a big run reads as ~N act summaries
  // instead of hundreds of per-node lines (the walk detail stays one click away).
  const actGroups = new Map();
  const serverTally = { HIT: 0, MISS: 0, STALE: 0 };

  // Run-wide L2 (D1 quad store) cache roll-up. Created eagerly and pinned as the
  // first list item so it reads as a header summary, rather than getting buried
  // under whichever act happened to resolve first (which is where lazy creation
  // used to drop it).
  const serverCacheRow = document.createElement('li');
  serverCacheRow.className = 'dev-probe-item state-info';
  function renderServerCache() {
    serverCacheRow.textContent =
      `server-cache · HIT=${serverTally.HIT}` +
      ` · MISS=${serverTally.MISS} · STALE=${serverTally.STALE}`;
  }
  renderServerCache();
  list.append(serverCacheRow);

  function reset() {
    rows.clear();
    actGroups.clear();
    serverTally.HIT = 0;
    serverTally.MISS = 0;
    serverTally.STALE = 0;
    renderServerCache();
    list.replaceChildren(serverCacheRow);
    el.hidden = true;
  }

  function onAttempt({ path, state, attempts, reason, url }) {
    el.hidden = false;

    // With several lineup URLs in one run, each shares the same `path`
    // ('direct'/'reader'), so key the row by url+path to keep them distinct.
    const key = url ? `${url}::${path}` : path;
    let li = rows.get(key);
    if (!li) {
      li = document.createElement('li');
      rows.set(key, li);
      list.append(li);
    }

    // Keep the run-wide server-cache summary pinned directly beneath the fetch
    // attempt rows (just under "direct → ok") rather than above them. With no
    // fetch row (e.g. pasted text) it stays at the top.
    if (li.nextSibling !== serverCacheRow) {
      list.insertBefore(serverCacheRow, li.nextSibling);
    }

    li.className = `dev-probe-item state-${state}`;

    const parts = [];
    if (url) parts.push(shortenUrl(url));
    parts.push(`${path} \u2192 ${state}`);
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

  // Compact a lineup URL to host + last path segment for the attempt row.
  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const tail = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
      return tail ? `${u.host}/${tail}` : u.host;
    } catch {
      return url.slice(0, 40);
    }
  }

  function note(text) {
    el.hidden = false;
    const li = document.createElement('li');
    li.className = 'dev-probe-item state-info';
    li.textContent = text;
    list.append(li);
  }

  // One result of the identity walk for a lineup act, folded into that act's
  // collapsible group. `line` is the human-readable per-node detail; `ok` and
  // `serverCache` drive the at-a-glance summary so the group is legible collapsed.
  function providerResult(act, { line, ok = true, serverCache: label } = {}) {
    el.hidden = false;
    let group = actGroups.get(act);
    if (!group) {
      const details = document.createElement('details');
      details.className = 'dev-probe-item';
      const summary = document.createElement('summary');
      details.append(summary);
      const li = document.createElement('li');
      li.append(details);
      list.append(li);
      group = { summary, details, tally: { n: 0, HIT: 0, MISS: 0, STALE: 0, err: 0 } };
      actGroups.set(act, group);
    }

    const t = group.tally;
    t.n++;
    if (!ok) t.err++;
    if (label in t) t[label]++;

    const detail = document.createElement('div');
    detail.className = `dev-probe-detail ${ok ? 'state-info' : 'state-fail'}`;
    detail.textContent = line;
    group.details.append(detail);

    const cacheBits = [];
    if (t.HIT) cacheBits.push(`H:${t.HIT}`);
    if (t.MISS) cacheBits.push(`M:${t.MISS}`);
    if (t.STALE) cacheBits.push(`S:${t.STALE}`);
    const parts = [`${act}`, `${t.n} lookups`];
    if (cacheBits.length) parts.push(`L2 ${cacheBits.join('/')}`);
    if (t.err) parts.push(`${t.err} err`);
    group.summary.textContent = parts.join(' · ');
    group.summary.className = t.err ? 'state-fail' : 'state-info';
  }

  // Rolling tally of the shared L2 (D1 quad store) cache outcomes. Run a lineup
  // in a second browser to see HITs climb — that proves the cross-visitor cache
  // works. The row itself is created eagerly above and pinned to the top.
  function serverCache(outcome) {
    if (!outcome || !(outcome in serverTally)) return;
    serverTally[outcome]++;
    el.hidden = false;
    renderServerCache();
  }

  return { el, reset, onAttempt, note, providerResult, serverCache };
}
