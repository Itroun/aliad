import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookup, mapDetails } from '../src/providers/discogs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function fakeFetch(routes) {
  return async (url) => {
    for (const [match, payload] of routes) {
      if (url.includes(match)) {
        return { ok: true, status: 200, json: async () => payload };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe('discogs.lookup', () => {
  it('maps a search + details response', async () => {
    const search = fixture('discogs-search-infected-mushroom.json');
    const details = fixture('discogs-details-infected-mushroom.json');
    const fetchFn = fakeFetch([
      ['/database/search', search],
      [`/artists/${search.results[0].id}`, details],
    ]);

    const result = await lookup('Infected Mushroom', { fetchFn });

    expect(result.aliases.map((a) => a.name)).toEqual(['I.M.']);
    expect(result.members.map((m) => m.name)).toEqual(['Erez Eisen', 'Amit Duvdevani']);
    expect(result.groups.map((g) => g.name)).toEqual(['Fly Agaric']);
    expect(result.relatedProjects).toEqual([]);
  });

  it('returns the empty shape when search finds no artist', async () => {
    const fetchFn = fakeFetch([['/database/search', { results: [] }]]);
    const result = await lookup('Nonexistent 12345', { fetchFn });
    expect(result).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
  });

  it('throws on non-ok HTTP status', async () => {
    const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(lookup('whatever', { fetchFn })).rejects.toThrow(/429/);
  });
});

describe('discogs.mapDetails', () => {
  it('builds source URLs for each entry', () => {
    const details = fixture('discogs-details-infected-mushroom.json');
    const result = mapDetails(details);
    expect(result.members[0].sourceUrl).toBe('https://www.discogs.com/artist/200001');
    expect(result.groups[0].sourceUrl).toBe('https://www.discogs.com/artist/300001');
  });
});
