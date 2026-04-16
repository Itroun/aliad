import { describe, it, expect } from 'vitest';
import { lookupAll } from '../src/core/lookup.js';

function stubProvider(name, handlers) {
  return {
    name,
    async lookup(artistName) {
      const handler = handlers[artistName];
      if (typeof handler === 'function') return handler();
      if (handler instanceof Error) throw handler;
      return handler ?? { aliases: [], groups: [], members: [], relatedProjects: [] };
    },
  };
}

describe('lookupAll', () => {
  it('calls every provider for every unique artist and merges results', async () => {
    const mb = stubProvider('musicbrainz', {
      'Infected Mushroom': {
        aliases: [{ name: 'IM' }],
        groups: [],
        members: [{ name: 'Erez Aizen' }],
        relatedProjects: [],
      },
    });
    const dg = stubProvider('discogs', {
      'Infected Mushroom': {
        aliases: [{ name: 'I.M.' }],
        groups: [{ name: 'Fly Agaric' }],
        members: [{ name: 'Erez Eisen' }],
        relatedProjects: [],
      },
    });

    const events = [];
    const results = await lookupAll(['Infected Mushroom'], [mb, dg], {
      onProviderResult: (artist, provider, outcome) => {
        events.push({ artist, provider, ok: outcome.ok });
      },
      onArtistDone: (artist, merged) => {
        events.push({ artist, done: true, memberCount: merged.members.length });
      },
    });

    expect(results).toHaveLength(1);
    expect(events.filter((e) => e.ok)).toHaveLength(2);
    const done = events.find((e) => e.done);
    expect(done.memberCount).toBe(2);
  });

  it('trims, dedupes and skips blank input names', async () => {
    const calls = [];
    const p = {
      name: 'p',
      async lookup(artistName) {
        calls.push(artistName);
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };
    await lookupAll(['  Foo  ', 'foo', '', 'Bar', 'BAR'], [p]);
    expect(calls.sort()).toEqual(['Bar', 'Foo']);
  });

  it('follows aliases and attributes results with via', async () => {
    const p = stubProvider('mb', {
      Dickster: {
        aliases: [{ name: 'Dick Trevor' }],
        groups: [],
        members: [],
        relatedProjects: [],
      },
      'Dick Trevor': {
        aliases: [{ name: 'Dickster' }],
        groups: [{ name: 'Green Nuns of the Revolution' }],
        members: [],
        relatedProjects: [],
      },
    });

    const doneEvents = [];
    const results = await lookupAll(['Dickster'], [p], {
      onArtistDone: (artist, merged) => doneEvents.push({ artist, merged }),
    });

    const groups = results[0].merged.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Green Nuns of the Revolution');
    expect(groups[0].via).toBe('Dick Trevor');
    expect(doneEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('avoids cycles when following aliases', async () => {
    const lookups = [];
    const p = {
      name: 'p',
      async lookup(name) {
        lookups.push(name);
        if (name === 'A') return { aliases: [{ name: 'B' }], groups: [], members: [], relatedProjects: [] };
        if (name === 'B') return { aliases: [{ name: 'A' }], groups: [{ name: 'SomeGroup' }], members: [], relatedProjects: [] };
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };

    await lookupAll(['A'], [p]);
    expect(lookups).toEqual(['A', 'B']);
  });

  it('follows transitive aliases', async () => {
    const p = stubProvider('p', {
      A: { aliases: [{ name: 'B' }], groups: [], members: [], relatedProjects: [] },
      B: { aliases: [{ name: 'C' }], groups: [], members: [], relatedProjects: [] },
      C: { aliases: [], groups: [{ name: 'Deep Group' }], members: [], relatedProjects: [] },
    });

    const results = await lookupAll(['A'], [p]);
    const groups = results[0].merged.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Deep Group');
    expect(groups[0].via).toBe('C');
  });

  it('prefers direct entries over via-attributed ones', async () => {
    const p = stubProvider('p', {
      A: {
        aliases: [{ name: 'B' }],
        groups: [{ name: 'SharedGroup' }],
        members: [],
        relatedProjects: [],
      },
      B: {
        aliases: [],
        groups: [{ name: 'SharedGroup' }],
        members: [],
        relatedProjects: [],
      },
    });

    const results = await lookupAll(['A'], [p]);
    const groups = results[0].merged.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('SharedGroup');
    expect(groups[0].via).toBeUndefined();
  });

  it('reports provider errors without failing the artist', async () => {
    const failing = stubProvider('bad', { Foo: new Error('rate limited') });
    const working = stubProvider('good', { Foo: { aliases: [{ name: 'X' }], groups: [], members: [], relatedProjects: [] } });

    const outcomes = [];
    const results = await lookupAll(['Foo'], [failing, working], {
      onProviderResult: (_artist, _provider, outcome) => outcomes.push(outcome),
    });

    expect(outcomes.some((o) => o.ok === false)).toBe(true);
    expect(results[0].merged.aliases.map((a) => a.name)).toEqual(['X']);
  });
});
