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

  it('caps alias fan-out: registers names in closure without walking them', async () => {
    const lookups = [];
    // 20 aliases on the root node, exceeding the fan-out cap of 15. Each alias
    // would normally be looked up; with the cap, none are, but all names should
    // still land in the closure.
    const aliases = Array.from({ length: 20 }, (_, i) => ({ name: `Pseudonym-${i}` }));
    aliases.push({ name: 'LineupMatch' }); // one of the names matches another input
    const p = {
      name: 'p',
      async lookup(name) {
        lookups.push(name);
        if (name === 'Prolific') {
          return { aliases, groups: [], members: [], relatedProjects: [] };
        }
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };

    const results = await lookupAll(['Prolific', 'LineupMatch'], [p]);
    // Only the two root lookups happen — no aliases are walked from Prolific.
    expect(lookups.sort()).toEqual(['LineupMatch', 'Prolific']);
    // But LineupMatch's name is in Prolific's closure so clustering can union them.
    const prolific = results.find((r) => r.name === 'Prolific');
    expect(prolific.closure.has('lineupmatch')).toBe(true);
    expect(prolific.closure.has('pseudonym 0')).toBe(true);
  });

  it('walks aliases normally when the fan-out is at or below the cap', async () => {
    const lookups = [];
    const aliases = Array.from({ length: 10 }, (_, i) => ({ name: `Alt-${i}` }));
    const p = {
      name: 'p',
      async lookup(name) {
        lookups.push(name);
        if (name === 'Small') {
          return { aliases, groups: [], members: [], relatedProjects: [] };
        }
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };
    await lookupAll(['Small'], [p]);
    // Root + all 10 aliases = 11 lookups.
    expect(lookups).toHaveLength(11);
  });

  it('coalesces concurrent lookups for the same name across roots', async () => {
    const calls = [];
    const p = {
      name: 'p',
      async lookup(name) {
        calls.push(name);
        if (name === 'A') {
          return {
            aliases: [{ name: 'Shared' }],
            groups: [],
            members: [],
            relatedProjects: [],
          };
        }
        if (name === 'B') {
          return {
            aliases: [{ name: 'Shared' }],
            groups: [],
            members: [],
            relatedProjects: [],
          };
        }
        return {
          aliases: [],
          groups: [{ name: 'SharedGroup' }],
          members: [],
          relatedProjects: [],
        };
      },
    };

    const outcomes = [];
    const results = await lookupAll(['A', 'B'], [p], {
      onProviderResult: (_artist, _provider, outcome) => {
        if (outcome.via === 'Shared') outcomes.push(outcome);
      },
    });
    // Shared is not a root, so both A's and B's walks want it. Cache should
    // ensure exactly one lookup is issued for Shared.
    const sharedCalls = calls.filter((n) => n === 'Shared');
    expect(sharedCalls).toHaveLength(1);
    // Both closures still contain the shared alias.
    for (const r of results) {
      expect(r.closure.has('shared')).toBe(true);
    }
    // Exactly one of the two walks issued the real call; the other got a cache hit.
    const firstCallers = outcomes.filter((o) => o.cached === false);
    const cacheHits = outcomes.filter((o) => o.cached === true);
    expect(firstCallers).toHaveLength(1);
    expect(cacheHits).toHaveLength(1);
  });

  it('caches repeated lookups across initial and expansion phases', async () => {
    const calls = [];
    const p = {
      name: 'p',
      async lookup(name) {
        calls.push(name);
        if (name === 'A') {
          return { aliases: [{ name: 'C' }], groups: [], members: [], relatedProjects: [] };
        }
        if (name === 'B') {
          return { aliases: [{ name: 'A' }], groups: [], members: [], relatedProjects: [] };
        }
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };

    // A is both a root and an alias reachable from B. Cache + root-skip means
    // A is looked up exactly once (for its own root walk).
    await lookupAll(['A', 'B'], [p]);
    const aCalls = calls.filter((n) => n === 'A');
    expect(aCalls).toHaveLength(1);
  });

  it('skips expansion lookup for names that are themselves roots', async () => {
    const calls = [];
    const p = {
      name: 'p',
      async lookup(name) {
        calls.push(name);
        if (name === 'A') {
          return { aliases: [{ name: 'B' }], groups: [], members: [], relatedProjects: [] };
        }
        if (name === 'B') {
          return {
            aliases: [],
            groups: [{ name: 'B-Group' }],
            members: [],
            relatedProjects: [],
          };
        }
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };

    const results = await lookupAll(['A', 'B'], [p]);
    // B is a root, so A's walk should not look up B for expansion.
    // B still gets looked up exactly once for its own root walk.
    expect(calls.filter((n) => n === 'B')).toHaveLength(1);
    // A's closure contains B so clustering can union them.
    const a = results.find((r) => r.name === 'A');
    expect(a.closure.has('b')).toBe(true);
  });

  it('clusters via group-of-alias when the group is a lineup root', async () => {
    // Filteria → alias Jannis Tzikas → his groups list Ultravibe.
    // Ultravibe doesn't list Jannis directly as a member, so the only path
    // is through the alias-then-group chain. Filteria's closure must still
    // pick up Ultravibe so clustering can union them.
    const p = stubProvider('p', {
      Filteria: {
        aliases: [{ name: 'Jannis Tzikas' }],
        groups: [],
        members: [],
        relatedProjects: [],
      },
      'Jannis Tzikas': {
        aliases: [],
        groups: [{ name: 'Ultravibe' }],
        members: [],
        relatedProjects: [],
      },
      Ultravibe: { aliases: [], groups: [], members: [], relatedProjects: [] },
    });

    const results = await lookupAll(['Filteria', 'Ultravibe'], [p]);
    const f = results.find((r) => r.name === 'Filteria');
    expect(f.closure.has('ultravibe')).toBe(true);
  });

  it('does not walk into non-root groups during expansion', async () => {
    // Mirror of the above, but Ultravibe is NOT a lineup root. We must not
    // enqueue it (would explode budget on prolific session musicians).
    const calls = [];
    const p = {
      name: 'p',
      async lookup(name) {
        calls.push(name);
        if (name === 'Filteria') {
          return {
            aliases: [{ name: 'Jannis Tzikas' }],
            groups: [],
            members: [],
            relatedProjects: [],
          };
        }
        if (name === 'Jannis Tzikas') {
          return {
            aliases: [],
            groups: [{ name: 'Ultravibe' }],
            members: [],
            relatedProjects: [],
          };
        }
        return { aliases: [], groups: [], members: [], relatedProjects: [] };
      },
    };

    await lookupAll(['Filteria'], [p]);
    expect(calls).not.toContain('Ultravibe');
  });

  it('still clusters transitively across roots even with root-skip', async () => {
    // A -> B (root), B -> C (root), C stands alone. Clustering union over
    // closures should still join all three.
    const p = stubProvider('p', {
      A: { aliases: [{ name: 'B' }], groups: [], members: [], relatedProjects: [] },
      B: { aliases: [{ name: 'C' }], groups: [], members: [], relatedProjects: [] },
      C: { aliases: [], groups: [], members: [], relatedProjects: [] },
    });

    const results = await lookupAll(['A', 'B', 'C'], [p]);
    const a = results.find((r) => r.name === 'A');
    const b = results.find((r) => r.name === 'B');
    expect(a.closure.has('b')).toBe(true);
    expect(b.closure.has('c')).toBe(true);
  });

  it('coalesces failures without retrying the shared call', async () => {
    const calls = [];
    const p = {
      name: 'p',
      async lookup(name) {
        calls.push(name);
        if (name === 'Shared') throw new Error('boom');
        return {
          aliases: [{ name: 'Shared' }],
          groups: [],
          members: [],
          relatedProjects: [],
        };
      },
    };

    const errors = [];
    await lookupAll(['A', 'B'], [p], {
      onProviderResult: (_artist, _provider, outcome) => {
        if (!outcome.ok) errors.push(outcome.error.message);
      },
    });
    // Both walks tried Shared, but the cache returned the same rejected promise
    // to both, so only one upstream call was actually made.
    expect(calls.filter((n) => n === 'Shared')).toHaveLength(1);
    // And both walks saw the error (one from each expansion attempt).
    expect(errors.filter((m) => m === 'boom').length).toBeGreaterThanOrEqual(2);
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
