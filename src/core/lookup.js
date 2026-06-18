import { dedupeNames, mergeResults } from './merge.js';

// Phase 3b: the identity-graph walk runs SERVER-SIDE now. lookupAll no longer
// touches providers or the L1 browser cache directly — for each lineup name it
// opens an SSE stream to /api/closure (functions/api/closure.js), which drives
// the cold/expired fetches, runs the closure query over the shared D1 quad
// store, and streams progress back. This module keeps the public lookupAll
// contract (same callbacks, same return shape) so the UI is untouched, plus the
// client-side collab split: "X vs Y" rows call the endpoint once per part + the
// combo and merge the streams here. The old browser BFS (expandIdentityGraph /
// enqueueFromNode) and its per-provider rate-limit/cache machinery are gone —
// the expansion rules now live solely in src/core/closure.js.

// Festival lineups commonly use "X vs Y", "X b2b Y", "X & Y" for collab acts.
// Providers don't know these combined names, so we look up the constituents
// individually and merge their data + closures into the combo's entry.
const COLLAB_SEPARATORS = [/\s+vs\.?\s+/i, /\s+b2b\s+/i, /\s+&\s+/];

export function splitCollab(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  for (const sep of COLLAB_SEPARATORS) {
    if (!sep.test(s)) continue;
    const parts = s
      .split(sep)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return null;
}

// Provider selection lives server-side now (the walk runs over /api/closure), so
// lookupAll just takes the lineup names and the progress callbacks.
export function lookupAll(names, callbacks = {}) {
  const { onArtistDone, onArtistComplete } = callbacks;
  const unique = dedupeNames(names);
  // The full deduped lineup drives the endpoint's root-union/skip rule.
  const roots = unique;

  return Promise.all(
    unique.map(async (name) => {
      const combo = await streamClosure(name, roots, callbacks, { reportName: name });

      let merged = combo.merged;
      const closure = new Set(combo.closure);
      // `sources` attributes each relation back to the sub-name that hosts it,
      // so the graph can render "aka Filteria" rather than "aka X vs Filteria".
      const sources = [{ name, merged: combo.merged }];

      const parts = splitCollab(name);
      if (parts) {
        const partResults = await Promise.all(
          parts.map((p) => streamClosure(p, roots, callbacks, { reportName: null })),
        );
        partResults.forEach((pr, i) => {
          merged = mergeResults(merged, pr.merged);
          for (const k of pr.closure) closure.add(k);
          sources.push({ name: parts[i], merged: pr.merged });
        });
        onArtistDone?.(name, merged);
      }

      onArtistComplete?.(name, merged, {
        queried: combo.queried ?? [],
        errored: combo.errored ?? [],
        closure,
      });
      return { name, merged, closure, sources, parts: parts ?? [] };
    }),
  );
}

// Open one /api/closure SSE stream and translate its events back into the
// existing per-artist callbacks. Resolves { merged, closure, queried, errored }
// from the terminal `done` event. `reportName` is the lineup row this stream's
// progress should update (null for a collab part, whose name isn't a row).
async function streamClosure(name, roots, callbacks, { reportName }) {
  const { onProviderResult, onArtistDone, onBudgetExhausted, signal } = callbacks;

  const params = new URLSearchParams();
  params.set('root', name);
  for (const r of roots) params.append('roots', r);

  const res = await fetch(`/api/closure?${params.toString()}`, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`closure request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  const handle = (event, data) => {
    switch (event) {
      case 'provider':
        onProviderResult?.(name, data.provider, {
          ok: data.ok,
          result: data.result,
          via: data.via,
          cached: data.cached,
          serverCache: data.serverCache,
          error: data.ok ? undefined : new Error('lookup failed'),
        });
        break;
      case 'progress':
        // Suppress progress routing for collab parts — the part's display name
        // isn't a lineup row, so updates for it have nowhere useful to land.
        if (reportName) onArtistDone?.(reportName, data.merged);
        break;
      case 'budget':
        onBudgetExhausted?.(name, data);
        break;
      case 'done':
        result = data;
        break;
      case 'error':
        throw new Error(data.message || 'closure error');
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (dataStr) handle(event, JSON.parse(dataStr));
    }
  }

  if (!result) throw new Error('closure stream ended without a result');
  return result;
}
