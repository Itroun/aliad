import { emptyResult } from './provider.js';
import { fetchWithRetry } from '../core/retry.js';
import { normaliseName } from '../core/merge.js';

export const name = 'discogs';
export const minIntervalMs = 1500;

const PROXY = '/api/discogs';

export async function lookup(artistName, { signal, fetchFn = fetch, sleep } = {}) {
  const ctx = { signal, fetchFn, sleep };
  const match = await search(artistName, ctx);
  if (!match) return emptyResult();
  const details = await fetchDetails(match.id, ctx);
  return mapDetails(details);
}

async function search(artistName, ctx) {
  const url = `${PROXY}/database/search?q=${encodeURIComponent(artistName)}&type=artist`;
  const data = await getJson(url, ctx);
  const q = normaliseName(artistName);
  for (const candidate of data?.results ?? []) {
    if (!candidate?.id) continue;
    const title = normaliseName(stripDisambiguation(candidate.title ?? ''));
    if (title === q) return candidate;
  }
  return null;
}

async function fetchDetails(id, ctx) {
  const url = `${PROXY}/artists/${encodeURIComponent(id)}`;
  return getJson(url, ctx);
}

async function getJson(url, { signal, fetchFn, sleep }) {
  const res = await fetchWithRetry(
    fetchFn,
    url,
    { signal, headers: { Accept: 'application/json' } },
    { sleep },
  );
  if (!res.ok) throw new Error(`Discogs ${res.status} for ${url}`);
  return res.json();
}

function stripDisambiguation(name) {
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
