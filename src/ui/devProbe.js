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
  let serverCacheRow = null;
  const serverTally = { HIT: 0, MISS: 0, STALE: 0 };

  function reset() {
    rows.clear();
    actGroups.clear();
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
  // works.
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

  return { el, reset, onAttempt, note, providerResult, serverCache };
}
