import { emptyResult } from './provider.js';

export const name = 'discogs';
export const minIntervalMs = 1050;

const PROXY = '/api/discogs';

export async function lookup(artistName, { signal, fetchFn = fetch } = {}) {
  const match = await search(artistName, { signal, fetchFn });
  if (!match) return emptyResult();
  const details = await fetchDetails(match.id, { signal, fetchFn });
  return mapDetails(details);
}

async function search(artistName, { signal, fetchFn }) {
  const url = `${PROXY}/database/search?q=${encodeURIComponent(artistName)}&type=artist`;
  const data = await getJson(url, { signal, fetchFn });
  const first = data?.results?.[0];
  return first && first.id ? first : null;
}

async function fetchDetails(id, { signal, fetchFn }) {
  const url = `${PROXY}/artists/${encodeURIComponent(id)}`;
  return getJson(url, { signal, fetchFn });
}

async function getJson(url, { signal, fetchFn }) {
  const res = await fetchFn(url, { signal, headers: { Accept: 'application/json' } });
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
