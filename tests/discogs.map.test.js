import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mapDetails, pickMatch } from '../src/providers/discogs.map.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('discogs.mapDetails', () => {
  it('maps a real details response into buckets', () => {
    const details = fixture('discogs-details-infected-mushroom.json');
    const result = mapDetails(details);
    expect(result.aliases.map((a) => a.name)).toEqual(['I.M.']);
    expect(result.members.map((m) => m.name)).toEqual(['Erez Eisen', 'Amit Duvdevani']);
    expect(result.groups.map((g) => g.name)).toEqual(['Fly Agaric']);
    expect(result.relatedProjects).toEqual([]);
  });

  it('builds source URLs for each entry', () => {
    const details = fixture('discogs-details-infected-mushroom.json');
    const result = mapDetails(details);
    expect(result.members[0].sourceUrl).toBe('https://www.discogs.com/artist/200001');
    expect(result.groups[0].sourceUrl).toBe('https://www.discogs.com/artist/300001');
  });

  it('strips Discogs disambiguation suffixes from names', () => {
    const details = {
      id: 1,
      aliases: [{ id: 2, name: 'Muttley (3)' }],
      groups: [{ id: 3, name: 'Juice (13)' }],
      members: [{ id: 4, name: 'Trickster (2)' }],
    };
    const result = mapDetails(details);
    expect(result.aliases[0].name).toBe('Muttley');
    expect(result.groups[0].name).toBe('Juice');
    expect(result.members[0].name).toBe('Trickster');
  });

  it('preserves names with non-disambiguation parentheses', () => {
    const details = {
      id: 1,
      aliases: [{ id: 2, name: 'Sunn O)))' }],
      groups: [],
      members: [{ id: 3, name: 'Earth (band)' }],
    };
    const result = mapDetails(details);
    expect(result.aliases[0].name).toBe('Sunn O)))');
    expect(result.members[0].name).toBe('Earth (band)');
  });
});

describe('discogs.pickMatch', () => {
  it('returns the first title-matching candidate', () => {
    const search = fixture('discogs-search-infected-mushroom.json');
    const match = pickMatch(search, 'Infected Mushroom');
    expect(match.id).toBe(search.results[0].id);
  });

  it('returns null when no title matches', () => {
    const data = { results: [{ id: 99, title: 'Completely Different Artist' }] };
    expect(pickMatch(data, 'Infected Mushroom')).toBeNull();
  });

  it('skips non-matches and takes the first title match', () => {
    const data = {
      results: [
        { id: 1, title: 'Not Right' },
        { id: 2, title: 'Infected Mushroom' },
      ],
    };
    expect(pickMatch(data, 'Infected Mushroom').id).toBe(2);
  });

  it('matches titles that only differ by a disambiguation suffix', () => {
    const data = { results: [{ id: 7, title: 'Muttley (3)' }] };
    expect(pickMatch(data, 'Muttley').id).toBe(7);
  });

  it('returns null on empty search results', () => {
    expect(pickMatch({ results: [] }, 'Nobody')).toBeNull();
  });
});
