import { fetchJson } from '../core/fetchJson.js';

export const name = 'musicbrainz';
export const minIntervalMs = 1200;

// Thin client (Phase 2b): the search + details + map pipeline now runs
// server-side in functions/api/lookup.js, which also owns the shared KV cache
// and the proper User-Agent. The browser just asks for the mapped result.
// `fetchJson` threads the proxy's X-Cache header into the dev-probe via
// recordMeta, exactly as before.
export async function lookup(artistName, ctx = {}) {
  const url = `/api/lookup?provider=musicbrainz&name=${encodeURIComponent(artistName)}`;
  return fetchJson(url, ctx, { providerName: 'MusicBrainz' });
}
