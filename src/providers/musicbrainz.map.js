// Pure MusicBrainz response → result-shape logic. No fetch, no I/O. Imported by
// both the browser provider (Phase 1b) and the server lookup endpoint (Phase 2b),
// so the same search-candidate selection and detail mapping run on either side.

import { emptyResult } from './provider.js';
import { normaliseName } from '../core/merge.js';

export const MIN_SCORE = 90;

// Pick the best search candidate: first one that clears MIN_SCORE and whose
// name (or one of its aliases) matches the query. Results are score-ordered, so
// once a candidate drops below MIN_SCORE no later one can qualify.
export function pickMatch(searchData, artistName) {
  const q = normaliseName(artistName);
  for (const candidate of searchData?.artists ?? []) {
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
