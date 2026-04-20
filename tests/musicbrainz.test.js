import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookup, mapDetails } from '../src/providers/musicbrainz.js';

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

describe('musicbrainz.lookup', () => {
  it('maps a real search + details response', async () => {
    const search = fixture('musicbrainz-search-infected-mushroom.json');
    const details = fixture('musicbrainz-details-infected-mushroom.json');
    const fetchFn = fakeFetch([
      ['/artist?query=', search],
      [`/artist/${search.artists[0].id}`, details],
    ]);

    const result = await lookup('Infected Mushroom', { fetchFn });

    expect(result.members.map((m) => m.name).sort()).toEqual(['Amit Duvdevani', 'Erez Aizen']);
    expect(result.groups.map((g) => g.name).sort()).toEqual(['Fly Agaric', 'Psy Trance Mafia']);
    expect(result.relatedProjects.map((r) => r.name)).toEqual(['Infected Deedrah']);
    expect(result.aliases.length).toBeGreaterThan(0);
  });

  it('returns the empty shape when search finds no artist', async () => {
    const fetchFn = fakeFetch([['/artist?query=', { count: 0, artists: [] }]]);
    const result = await lookup('Nonexistent Artist 12345', { fetchFn });
    expect(result).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
  });

  it('rejects low-confidence search results', async () => {
    const lowScore = {
      count: 1,
      artists: [{ id: 'abc', name: 'Something Else', score: 70 }],
    };
    const fetchFn = fakeFetch([['/artist?query=', lowScore]]);
    const result = await lookup('Infected Mushroom', { fetchFn });
    expect(result).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
  });

  it('rejects high-score results whose name and aliases do not match', async () => {
    const mismatch = {
      count: 1,
      artists: [
        {
          id: 'abc',
          name: 'Totally Different Band',
          score: 100,
          aliases: [{ name: 'Another Name' }],
        },
      ],
    };
    const fetchFn = fakeFetch([['/artist?query=', mismatch]]);
    const result = await lookup('Infected Mushroom', { fetchFn });
    expect(result).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
  });

  it('accepts a candidate that matches via one of its aliases', async () => {
    const search = {
      count: 1,
      artists: [
        {
          id: 'xyz',
          name: 'Canonical Name',
          score: 100,
          aliases: [{ name: 'Infected Mushroom' }],
        },
      ],
    };
    const details = { id: 'xyz', aliases: [], relations: [] };
    const fetchFn = fakeFetch([
      ['/artist?query=', search],
      ['/artist/xyz', details],
    ]);
    const result = await lookup('Infected Mushroom', { fetchFn });
    expect(result).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
  });

  it('propagates network errors', async () => {
    const fetchFn = async () => {
      throw new Error('offline');
    };
    await expect(lookup('whatever', { fetchFn, sleep: () => {} })).rejects.toThrow('offline');
  });

  it('throws on non-ok HTTP status', async () => {
    const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(lookup('whatever', { fetchFn, sleep: () => {} })).rejects.toThrow(/503/);
  });
});

describe('musicbrainz.mapDetails', () => {
  it('filters out backward supporting-musician relations', () => {
    const details = fixture('musicbrainz-details-infected-mushroom.json');
    const result = mapDetails(details);
    const names = result.relatedProjects.map((r) => r.name);
    expect(names).not.toContain('Jonathan Davis');
    expect(names).not.toContain('Perry Farrell');
  });
});
