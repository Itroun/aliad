import { emptyResult } from './provider.js';
import { fetchJson } from '../core/fetchJson.js';
import { mapDetails, pickMatch } from './discogs.map.js';

export const name = 'discogs';
export const minIntervalMs = 1500;

const PROXY = '/api/discogs';

export async function lookup(artistName, { signal, fetchFn = fetch, sleep, recordMeta } = {}) {
  const ctx = { signal, fetchFn, sleep, recordMeta };
  const match = await search(artistName, ctx);
  if (!match) return emptyResult();
  const details = await fetchDetails(match.id, ctx);
  return mapDetails(details);
}

async function search(artistName, ctx) {
  const url = `${PROXY}/database/search?q=${encodeURIComponent(artistName)}&type=artist`;
  const data = await getJson(url, ctx);
  return pickMatch(data, artistName);
}

async function fetchDetails(id, ctx) {
  const url = `${PROXY}/artists/${encodeURIComponent(id)}`;
  return getJson(url, ctx);
}

function getJson(url, ctx) {
  return fetchJson(url, ctx, { providerName: 'Discogs' });
}
