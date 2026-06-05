import { emptyResult } from './provider.js';
import { fetchJson } from '../core/fetchJson.js';
import { mapDetails, pickMatch } from './musicbrainz.map.js';

export const name = 'musicbrainz';
export const minIntervalMs = 1200;

// Proxied through our Pages Function (functions/api/musicbrainz) so the call is
// server-cached and can carry a proper User-Agent. See PHASE1B_SHARED_CACHE_PLAN.md.
const BASE = '/api/musicbrainz/ws/2';

export async function lookup(artistName, { signal, fetchFn = fetch, sleep, recordMeta } = {}) {
  const ctx = { signal, fetchFn, sleep, recordMeta };
  const match = await search(artistName, ctx);
  if (!match) return emptyResult();
  const details = await fetchDetails(match.id, ctx);
  return mapDetails(details);
}

async function search(artistName, ctx) {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const url = `${BASE}/artist?query=${query}&fmt=json&limit=5`;
  const data = await getJson(url, ctx);
  return pickMatch(data, artistName);
}

async function fetchDetails(mbid, ctx) {
  const url = `${BASE}/artist/${encodeURIComponent(mbid)}?inc=aliases+artist-rels&fmt=json`;
  return getJson(url, ctx);
}

const RETRY_OPTIONS = {
  maxAttempts: 5,
  backoffMs: [1000, 3000, 7000, 15000],
};

function getJson(url, ctx) {
  return fetchJson(url, ctx, { providerName: 'MusicBrainz', retryOptions: RETRY_OPTIONS });
}

export function mapDetails(details) {
  const result = emptyResult();
  const sourceUrl = details?.id ? `https://musicbrainz.org/artist/${details.id}` : undefined;

  for (const alias of details?.aliases ?? []) {
    if (!alias?.name) continue;
    result.aliases.push({ name: alias.name, type: alias.type, sourceUrl });
  }

  for (const rel of details?.relations ?? []) {
    const artist = rel?.artist;
    if (!artist?.name) continue;
    const entry = {
      name: artist.name,
      type: artist.type,
      sourceUrl: `https://musicbrainz.org/artist/${artist.id}`,
    };
    const bucket = bucketForRelation(rel);
    if (bucket) result[bucket].push(entry);
  }

  return result;
}

function bucketForRelation(rel) {
  const type = rel?.type ?? '';
  const direction = rel?.direction;

  if (type === 'member of band') {
    if (direction === 'backward') return 'members';
    if (direction === 'forward') return 'groups';
    return null;
  }
  if (type === 'collaboration') return 'relatedProjects';
  if (type.includes('supporting musician') && direction === 'forward') {
    return 'relatedProjects';
  }
  return null;
}
