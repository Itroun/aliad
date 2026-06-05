import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mapDetails, pickMatch } from '../src/providers/musicbrainz.map.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('musicbrainz.mapDetails', () => {
  it('maps a real details response into buckets', () => {
    const details = fixture('musicbrainz-details-infected-mushroom.json');
    const result = mapDetails(details);
    expect(result.members.map((m) => m.name).sort()).toEqual(['Amit Duvdevani', 'Erez Aizen']);
    expect(result.groups.map((g) => g.name).sort()).toEqual(['Fly Agaric', 'Psy Trance Mafia']);
    expect(result.relatedProjects.map((r) => r.name)).toEqual(['Infected Deedrah']);
    expect(result.aliases.length).toBeGreaterThan(0);
  });

  it('filters out backward supporting-musician relations', () => {
    const details = fixture('musicbrainz-details-infected-mushroom.json');
    const result = mapDetails(details);
    const names = result.relatedProjects.map((r) => r.name);
    expect(names).not.toContain('Jonathan Davis');
    expect(names).not.toContain('Perry Farrell');
  });
});

describe('musicbrainz.pickMatch', () => {
  it('returns the first candidate matching name and score', () => {
    const search = fixture('musicbrainz-search-infected-mushroom.json');
    const match = pickMatch(search, 'Infected Mushroom');
    expect(match.id).toBe(search.artists[0].id);
  });

  it('returns null when no candidate clears the score threshold', () => {
    const data = { artists: [{ id: 'abc', name: 'Something Else', score: 70 }] };
    expect(pickMatch(data, 'Infected Mushroom')).toBeNull();
  });

  it('returns null on a high-score name+alias mismatch', () => {
    const data = {
      artists: [
        {
          id: 'abc',
          name: 'Totally Different Band',
          score: 100,
          aliases: [{ name: 'Another Name' }],
        },
      ],
    };
    expect(pickMatch(data, 'Infected Mushroom')).toBeNull();
  });

  it('matches a candidate via one of its aliases', () => {
    const data = {
      artists: [
        { id: 'xyz', name: 'Canonical Name', score: 100, aliases: [{ name: 'Infected Mushroom' }] },
      ],
    };
    expect(pickMatch(data, 'Infected Mushroom').id).toBe('xyz');
  });

  it('returns null on empty search results', () => {
    expect(pickMatch({ count: 0, artists: [] }, 'Nobody')).toBeNull();
  });
});
