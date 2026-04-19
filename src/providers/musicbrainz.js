import { emptyResult } from './provider.js';
import { fetchWithRetry } from '../core/fetchWithRetry.js';
import { normaliseName } from '../core/merge.js';

export const name = 'musicbrainz';
export const minIntervalMs = 1200;
export const MIN_SCORE = 90;

const BASE = 'https://musicbrainz.org/ws/2';

export async function lookup(artistName, { signal, fetchFn = fetch, sleep } = {}) {
  const ctx = { signal, fetchFn, sleep };
  const match = await search(artistName, ctx);
  if (!match) return emptyResult();
  const details = await fetchDetails(match.id, ctx);
  return mapDetails(details);
}

async function search(artistName, ctx) {
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const url = `${BASE}/artist?query=${query}&fmt=json&limit=5`;
  const data = await getJson(url, ctx);
  const q = normaliseName(artistName);
  for (const candidate of data?.artists ?? []) {
    if (!candidate?.id) continue;
    if ((candidate.score ?? 0) < MIN_SCORE) break;
    if (nameMatches(q, candidate)) return candidate;
  }
  return null;
}

function nameMatches(normalisedQuery, candidate) {
  if (normaliseName(candidate.name) === normalisedQuery) return true;
  for (const alias of candidate.aliases ?? []) {
    if (normaliseName(alias?.name) === normalisedQuery) return true;
  }
  return false;
}

async function fetchDetails(mbid, ctx) {
  const url = `${BASE}/artist/${encodeURIComponent(mbid)}?inc=aliases+artist-rels&fmt=json`;
  return getJson(url, ctx);
}

const RETRY_OPTIONS = {
  maxAttempts: 5,
  backoffMs: [1000, 3000, 7000, 15000],
};

async function getJson(url, { signal, fetchFn, sleep }) {
  const result = await fetchWithRetry(
    url,
    { headers: { Accept: 'application/json' } },
    { fetchFn, signal, sleep, ...RETRY_OPTIONS },
  );
  if (!result.ok) {
    throw new Error(`MusicBrainz ${result.status ?? result.reason} for ${url}`);
  }
  return result.response.json();
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
