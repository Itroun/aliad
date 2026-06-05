// Pure Discogs response → result-shape logic. No fetch, no I/O. Imported by both
// the browser provider (Phase 1b) and the server lookup endpoint (Phase 2b).

import { emptyResult } from './provider.js';
import { normaliseName } from '../core/merge.js';

// Discogs search results carry no score; match on normalised title (after
// stripping the `(3)`-style disambiguation suffix). First exact match wins.
export function pickMatch(searchData, artistName) {
  const q = normaliseName(artistName);
  for (const candidate of searchData?.results ?? []) {
    if (!candidate?.id) continue;
    const title = normaliseName(stripDisambiguation(candidate.title ?? ''));
    if (title === q) return candidate;
  }
  return null;
}

export function stripDisambiguation(name) {
  return name.replace(/ \(\d+\)$/, '');
}

export function mapDetails(details) {
  const result = emptyResult();
  const sourceUrl = details?.id ? `https://www.discogs.com/artist/${details.id}` : undefined;

  for (const alias of details?.aliases ?? []) {
    if (!alias?.name) continue;
    result.aliases.push({
      name: stripDisambiguation(alias.name),
      sourceUrl: alias.id ? `https://www.discogs.com/artist/${alias.id}` : sourceUrl,
    });
  }

  for (const group of details?.groups ?? []) {
    if (!group?.name) continue;
    result.groups.push({
      name: stripDisambiguation(group.name),
      sourceUrl: group.id ? `https://www.discogs.com/artist/${group.id}` : sourceUrl,
    });
  }

  for (const member of details?.members ?? []) {
    if (!member?.name) continue;
    result.members.push({
      name: stripDisambiguation(member.name),
      sourceUrl: member.id ? `https://www.discogs.com/artist/${member.id}` : sourceUrl,
    });
  }

  return result;
}
