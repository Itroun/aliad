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
        events.push({ artist, provider, ok: outcome.ok, via: outcome.via });
      },
      onArtistDone: (artist, merged) => {
        events.push({ artist, done: true, memberCount: merged.members.length });
      },
    });

    expect(results).toHaveLength(1);
    const directOk = events.filter((e) => e.ok && !e.via);
    expect(directOk).toHaveLength(2);
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
        if (name === 'A')
          return { aliases: [{ name: 'B' }], groups: [], members: [], relatedProjects: [] };
        if (name === 'B')
          return {
            aliases: [{ name: 'A' }],
            groups: [{ name: 'SomeGroup' }],
            members: [],
            relatedProjects: [],
          };
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

  it('fires onArtistComplete with a queried/errored summary', async () => {
    const good = stubProvider('mb', {
      Foo: { aliases: [], groups: [], members: [], relatedProjects: [] },
    });
    const bad = stubProvider('dg', { Foo: new Error('boom') });

    const completions = [];
    await lookupAll(['Foo'], [good, bad], {
      onArtistComplete: (artist, _merged, summary) => completions.push({ artist, summary }),
    });

    expect(completions).toHaveLength(1);
    expect(completions[0].summary.queried).toEqual(['mb']);
    expect(completions[0].summary.errored).toEqual(['dg']);
  });

  it('fires onBudgetExhausted when expansion is truncated', async () => {
    let counter = 0;
    const p = {
      name: 'p',
      async lookup() {
        counter++;
        return {
          aliases: [{ name: `alias-${counter}-a` }, { name: `alias-${counter}-b` }],
          groups: [],
          members: [],
          relatedProjects: [],
        };
      },
    };

    const budgetHits = [];
    await lookupAll(['Root'], [p], {
      onBudgetExhausted: (artist, info) => budgetHits.push({ artist, info }),
    });

    expect(budgetHits).toHaveLength(1);
    expect(budgetHits[0].artist).toBe('Root');
    expect(budgetHits[0].info.skipped).toBeGreaterThan(0);
  });

  it('does not expand aliases typed as Search hint or Legal name', async () => {
    const lookups = [];
    const p = {
      name: 'p',
      async lookup(name) {
        lookups.push(name);
        if (name === 'Root') {
          return {
            aliases: [
              { name: 'Rooty', type: 'Search hint' },
              { name: 'Richard Rootworth', type: 'Legal name' },
              { name: 'Root Project', type: 'Artist name' },
            ],
            groups: [],
            members: [],
            relatedProjects: [],
          };
        }
        return { aliases: [], groups: [{ name: 'Something' }], members: [], relatedProjects: [] };
      },
    };

    await lookupAll(['Root'], [p]);
    expect(lookups).toEqual(['Root', 'Root Project']);
  });

  it('caps expansion at the per-root lookup budget', async () => {
    const lookups = [];
    const p = {
      name: 'p',
      async lookup(name) {
        lookups.push(name);
        const next = `${name}+`;
        return {
          aliases: [{ name: next }],
          groups: [],
          members: [],
          relatedProjects: [],
        };
      },
    };

    await lookupAll(['A'], [p]);
    expect(lookups.length).toBeLessThanOrEqual(26);
  });

  it('follows members when the root is itself a group', async () => {
    const p = stubProvider('p', {
      Shpongle: {
        aliases: [],
        groups: [],
        members: [{ name: 'Raja Ram' }, { name: 'Simon Posford' }],
        relatedProjects: [],
      },
      'Raja Ram': {
        aliases: [],
        groups: [{ name: 'The Infinity Project' }],
        members: [],
        relatedProjects: [],
      },
      'Simon Posford': {
        aliases: [{ name: 'Hallucinogen' }],
        groups: [],
        members: [],
        relatedProjects: [],
      },
    });

    const results = await lookupAll(['Shpongle'], [p]);
    const groupNames = results[0].merged.groups.map((g) => g.name).sort();
    expect(groupNames).toEqual(['The Infinity Project']);
    const infinity = results[0].merged.groups.find((g) => g.name === 'The Infinity Project');
    expect(infinity.via).toBe('Raja Ram');
  });

  it('connects two group inputs via a shared member', async () => {
    const p = stubProvider('p', {
      Shpongle: {
        aliases: [],
        groups: [],
        members: [{ name: 'Raja Ram' }],
        relatedProjects: [],
      },
      'Celtic Cross': {
        aliases: [],
        groups: [],
        members: [{ name: 'Raja Ram' }],
        relatedProjects: [],
      },
      'Raja Ram': {
        aliases: [],
        groups: [{ name: 'Shpongle' }, { name: 'Celtic Cross' }, { name: 'The Infinity Project' }],
        members: [],
        relatedProjects: [],
      },
    });

    const results = await lookupAll(['Shpongle', 'Celtic Cross'], [p]);
    const shpongleGroups = results[0].merged.groups.map((g) => g.name);
    // Shpongle discovers Celtic Cross (and Infinity Project) via Raja Ram; Shpongle itself is the root so not listed.
    expect(shpongleGroups).toContain('Celtic Cross');
    expect(shpongleGroups).toContain('The Infinity Project');
    const celticViaRaja = results[0].merged.groups.find((g) => g.name === 'Celtic Cross');
    expect(celticViaRaja.via).toBe('Raja Ram');
  });

  it('does not follow groups of a person (non-group node)', async () => {
    const lookups = [];
    const p = {
      name: 'p',
      async lookup(name) {
        lookups.push(name);
        if (name === 'Soloist') {
          return {
            aliases: [],
            groups: [{ name: 'SomeBand' }],
            members: [],
            relatedProjects: [{ name: 'SomeProject' }],
          };
        }
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };
    await lookupAll(['Soloist'], [p]);
    // Only the root was looked up — neither `groups` nor `relatedProjects` are followed.
    expect(lookups).toEqual(['Soloist']);
  });

  it('records a multi-hop via chain', async () => {
    const p = stubProvider('p', {
      GroupA: {
        aliases: [{ name: 'GroupA-Alias' }],
        groups: [],
        members: [],
        relatedProjects: [],
      },
      'GroupA-Alias': {
        aliases: [],
        groups: [],
        members: [{ name: 'Member1' }],
        relatedProjects: [],
      },
      Member1: {
        aliases: [],
        groups: [{ name: 'OtherGroup' }],
        members: [],
        relatedProjects: [],
      },
    });

    const results = await lookupAll(['GroupA'], [p]);
    const other = results[0].merged.groups.find((g) => g.name === 'OtherGroup');
    expect(other).toBeTruthy();
    expect(other.via).toBe('Member1');
    expect(other.viaChain).toEqual(['Member1', 'GroupA-Alias']);
  });

  it('reports provider errors without failing the artist', async () => {
    const failing = stubProvider('bad', { Foo: new Error('rate limited') });
    const working = stubProvider('good', {
      Foo: { aliases: [{ name: 'X' }], groups: [], members: [], relatedProjects: [] },
    });

    const outcomes = [];
    const results = await lookupAll(['Foo'], [failing, working], {
      onProviderResult: (_artist, _provider, outcome) => outcomes.push(outcome),
    });

    expect(outcomes.some((o) => o.ok === false)).toBe(true);
    expect(results[0].merged.aliases.map((a) => a.name)).toEqual(['X']);
  });
});
