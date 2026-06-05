import { fetchJson } from '../core/fetchJson.js';

export const name = 'discogs';
export const minIntervalMs = 1500;

// Thin client (Phase 2b): search + details + map run server-side in
// functions/api/lookup.js (which injects the Discogs token and owns the shared
// KV cache). The browser just asks for the mapped result.
export async function lookup(artistName, ctx = {}) {
  const url = `/api/lookup?provider=discogs&name=${encodeURIComponent(artistName)}`;
  return fetchJson(url, ctx, { providerName: 'Discogs' });
}
