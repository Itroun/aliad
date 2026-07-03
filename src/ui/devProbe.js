const NOOP_PROBE = {
  el: null,
  reset() {},
  onAttempt() {},
  note() {},
  providerResult() {},
  lookupStats() {},
};

// One vocabulary for upstream-cost stats ({ calls, retries, status429,
// gateWaitMs }), shared by the per-node tags (main.js) and the per-provider
// roll-up below so the two dev-probe surfaces can't drift apart.
export function formatStatsParts(stats) {
  const parts = [`${stats.calls ?? 0} calls`];
  // A dump hit serves from the local Discogs snapshot — zero calls, zero gate.
  // Per-lookup `dumpHit` is a boolean; the roll-up sums it to a count.
  const dumpHits = stats.dumpHit === true ? 1 : (stats.dumpHit ?? 0);
  if (dumpHits) parts.push(`${dumpHits} dump`);
  if (stats.status429) parts.push(`429×${stats.status429}`);
  if (stats.retries) parts.push(`${stats.retries} retries`);
  // Sub-100ms gate waits are noise, not backpressure.
  if (stats.gateWaitMs >= 100) parts.push(`gate ${(stats.gateWaitMs / 1000).toFixed(1)}s`);
  return parts;
}

// 'H:3/M:9/S:1' shorthand for an L2 outcome tally — shared by the per-act
// summaries and the per-provider roll-up.
function formatCacheBits(t) {
  const bits = [];
  if (t.HIT) bits.push(`H:${t.HIT}`);
  if (t.MISS) bits.push(`M:${t.MISS}`);
  if (t.STALE) bits.push(`S:${t.STALE}`);
  return bits;
}

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

  // Run-wide summary block: the L2 (D1 quad store) cache roll-up plus one
  // upstream-stats line per provider. Created eagerly and pinned as the first
  // list item so it reads as a header summary, rather than getting buried under
  // whichever act happened to resolve first (which is where lazy creation used
  // to drop it).
  const summaryRow = document.createElement('li');
  summaryRow.className = 'dev-probe-item state-info';
  const serverCacheLine = document.createElement('div');
  summaryRow.append(serverCacheLine);
  // provider name -> { line: div, tally } for the per-provider upstream stats.
  const providerStats = new Map();
  // The run-wide L2 line is DERIVED from the per-provider tallies — one stream
  // of events, one set of counters, so the header can't contradict the
  // per-provider lines. Run a lineup in a second browser to see HITs climb —
  // that proves the cross-visitor cache works.
  function renderServerCache() {
    const sum = { HIT: 0, MISS: 0, STALE: 0 };
    for (const { tally } of providerStats.values()) {
      sum.HIT += tally.HIT;
      sum.MISS += tally.MISS;
      sum.STALE += tally.STALE;
    }
    serverCacheLine.textContent =
      `server-cache · HIT=${sum.HIT}` + ` · MISS=${sum.MISS} · STALE=${sum.STALE}`;
  }
  renderServerCache();
  list.append(summaryRow);

  function reset() {
    rows.clear();
    actGroups.clear();
    providerStats.clear();
    summaryRow.replaceChildren(serverCacheLine);
    renderServerCache();
    list.replaceChildren(summaryRow);
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

    // Keep the run-wide summary block pinned directly beneath the fetch
    // attempt rows (just under "direct → ok") rather than above them. With no
    // fetch row (e.g. pasted text) it stays at the top.
    if (li.nextSibling !== summaryRow) {
      list.insertBefore(summaryRow, li.nextSibling);
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

    const cacheBits = formatCacheBits(t);
    const parts = [`${act}`, `${t.n} lookups`];
    if (cacheBits.length) parts.push(`L2 ${cacheBits.join('/')}`);
    if (t.err) parts.push(`${t.err} err`);
    group.summary.textContent = parts.join(' · ');
    group.summary.className = t.err ? 'state-fail' : 'state-info';
  }

  // Per-provider run roll-up: lookup + L2 outcome counts always; upstream call/
  // retry/429/gate-wait totals when the server sent stats (cold lookups only).
  // This is the cold-run cost accounting — one glance says which provider's
  // budget the run actually spent (and wasted, via retries/429s). Also feeds
  // the derived run-wide server-cache line above.
  function lookupStats(provider, { serverCache: label, ok = true, stats } = {}) {
    if (!provider) return;
    let entry = providerStats.get(provider);
    if (!entry) {
      const line = document.createElement('div');
      summaryRow.append(line);
      entry = {
        line,
        tally: {
          lookups: 0,
          HIT: 0,
          MISS: 0,
          STALE: 0,
          err: 0,
          calls: 0,
          retries: 0,
          status429: 0,
          gateWaitMs: 0,
          dumpHit: 0,
        },
      };
      providerStats.set(provider, entry);
    }

    const t = entry.tally;
    t.lookups++;
    if (!ok) t.err++;
    if (label in t) t[label]++;
    if (stats) {
      t.calls += stats.calls ?? 0;
      t.retries += stats.retries ?? 0;
      t.status429 += stats.status429 ?? 0;
      t.gateWaitMs += stats.gateWaitMs ?? 0;
      t.dumpHit += stats.dumpHit ? 1 : 0;
    }

    const cacheBits = formatCacheBits(t);
    const parts = [provider, `${t.lookups} lookups`];
    if (cacheBits.length) parts.push(`L2 ${cacheBits.join('/')}`);
    parts.push(...formatStatsParts(t));
    if (t.err) parts.push(`${t.err} err`);
    entry.line.textContent = parts.join(' · ');

    renderServerCache();
    el.hidden = false;
  }

  return { el, reset, onAttempt, note, providerResult, lookupStats };
}
