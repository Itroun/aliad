import { describe, it, expect } from 'vitest';
import { identityClosure } from '../src/core/closure.js';
import { resultToQuads, quadsToResult } from '../src/core/quads.js';
import { mergeResults, normaliseName } from '../src/core/merge.js';

// Build an in-memory graph from per-(provider, name) mapped results, decomposing
// each through resultToQuads — the same write path the endpoint uses — so these
// tests exercise the round-trip (decompose → store → reconstitute) AND the
// traversal together. getQuadsTouching mirrors the real D1 cross-lookup query
// (functions/_lib/quadStore.js): every quad where `key` is subject OR object.
function seedGraph(entries) {
  const quads = [];
  for (const { provider = 'p', name, result } of entries) {
    quads.push(...resultToQuads(provider, normaliseName(name), name, result));
  }
  return {
    quads,
    async getQuadsTouching(key) {
      return quads.filter((q) => q.subject === key || q.object === key);
    },
  };
}

// Production wiring: a node's cross-provider result is the deduped reconstitution
// of all quads touching it. mergeResults collapses duplicate edges from different
// providers into one entry (with aggregated sources).
function neighborsFrom(store) {
  const calls = [];
  // identityClosure now hands neighbors the ORIGINAL-cased name (so the server
  // can drive cold searches); normalise internally for the read + call log.
  const neighbors = async (name) => {
    const key = normaliseName(name);
    calls.push(key);
    return mergeResults(quadsToResult(key, await store.getQuadsTouching(key)));
  };
  return { neighbors, calls };
}

function run(rootName, entries, opts = {}) {
  const store = seedGraph(entries);
  const { neighbors, calls } = neighborsFrom(store);
  return identityClosure(rootName, { neighbors, ...opts }).then((res) => ({ ...res, calls }));
}

const empty = { aliases: [], groups: [], members: [], relatedProjects: [] };

describe('identityClosure', () => {
  it('follows aliases and attributes results with via', async () => {
    const { merged } = await run('Dickster', [
      { name: 'Dickster', result: { ...empty, aliases: [{ name: 'Dick Trevor' }] } },
      {
        name: 'Dick Trevor',
        result: {
          ...empty,
          aliases: [{ name: 'Dickster' }],
          groups: [{ name: 'Green Nuns of the Revolution' }],
        },
      },
    ]);
    const gnotr = merged.groups.find((g) => g.name === 'Green Nuns of the Revolution');
    expect(gnotr).toBeTruthy();
    expect(gnotr.via).toBe('Dick Trevor');
  });

  it('follows transitive aliases', async () => {
    const { merged } = await run('A', [
      { name: 'A', result: { ...empty, aliases: [{ name: 'B' }] } },
      { name: 'B', result: { ...empty, aliases: [{ name: 'C' }] } },
      { name: 'C', result: { ...empty, groups: [{ name: 'Deep Group' }] } },
    ]);
    const deep = merged.groups.find((g) => g.name === 'Deep Group');
    expect(deep).toBeTruthy();
    expect(deep.via).toBe('C');
  });

  it('prefers direct entries over via-attributed ones (no via on a direct group)', async () => {
    const { merged } = await run('A', [
      {
        name: 'A',
        result: { ...empty, aliases: [{ name: 'B' }], groups: [{ name: 'SharedGroup' }] },
      },
      { name: 'B', result: { ...empty, groups: [{ name: 'SharedGroup' }] } },
    ]);
    const shared = merged.groups.filter((g) => g.name === 'SharedGroup');
    expect(shared).toHaveLength(1);
    expect(shared[0].via).toBeUndefined();
  });

  it('avoids cycles when following aliases', async () => {
    const { merged, calls } = await run('A', [
      { name: 'A', result: { ...empty, aliases: [{ name: 'B' }] } },
      {
        name: 'B',
        result: { ...empty, aliases: [{ name: 'A' }], groups: [{ name: 'SomeGroup' }] },
      },
    ]);
    expect(calls.sort()).toEqual(['a', 'b']); // each node read exactly once
    expect(merged.groups.some((g) => g.name === 'SomeGroup')).toBe(true);
  });

  it('does not expand aliases typed as Search hint or Legal name', async () => {
    const { calls } = await run('Root', [
      {
        name: 'Root',
        result: {
          ...empty,
          aliases: [
            { name: 'Rooty', type: 'Search hint' },
            { name: 'Richard Rootworth', type: 'Legal name' },
            { name: 'Root Project', type: 'Artist name' },
          ],
        },
      },
      { name: 'Root Project', result: { ...empty, groups: [{ name: 'Something' }] } },
    ]);
    expect(calls.sort()).toEqual(['root', 'root project']);
  });

  it('follows members when the root is itself a group', async () => {
    const { merged } = await run('Shpongle', [
      {
        name: 'Shpongle',
        result: { ...empty, members: [{ name: 'Raja Ram' }, { name: 'Simon Posford' }] },
      },
      { name: 'Raja Ram', result: { ...empty, groups: [{ name: 'The Infinity Project' }] } },
      { name: 'Simon Posford', result: { ...empty, aliases: [{ name: 'Hallucinogen' }] } },
    ]);
    const tip = merged.groups.find((g) => g.name === 'The Infinity Project');
    expect(tip).toBeTruthy();
    expect(tip.via).toBe('Raja Ram');
  });

  it('connects two group inputs via a shared member (root-skip union)', async () => {
    const rootKeys = new Set(['shpongle', 'celtic cross']);
    const { merged } = await run(
      'Shpongle',
      [
        { name: 'Shpongle', result: { ...empty, members: [{ name: 'Raja Ram' }] } },
        { name: 'Celtic Cross', result: { ...empty, members: [{ name: 'Raja Ram' }] } },
        {
          name: 'Raja Ram',
          result: {
            ...empty,
            groups: [
              { name: 'Shpongle' },
              { name: 'Celtic Cross' },
              { name: 'The Infinity Project' },
            ],
          },
        },
      ],
      { rootKeys },
    );
    const names = merged.groups.map((g) => g.name);
    expect(names).toContain('Celtic Cross');
    expect(names).toContain('The Infinity Project');
    expect(merged.groups.find((g) => g.name === 'Celtic Cross').via).toBe('Raja Ram');
  });

  it('does not follow groups/relatedProjects of a person (non-group node)', async () => {
    const { calls } = await run('Soloist', [
      {
        name: 'Soloist',
        result: {
          ...empty,
          groups: [{ name: 'SomeBand' }],
          relatedProjects: [{ name: 'SomeProject' }],
        },
      },
    ]);
    // Only the root is read — neither groups nor relatedProjects are walked.
    expect(calls).toEqual(['soloist']);
  });

  it('records a multi-hop via chain (member then alias)', async () => {
    const { merged } = await run(
      'GroupA',
      [
        { name: 'GroupA', result: { ...empty, members: [{ name: 'Member1' }] } },
        { name: 'Member1', result: { ...empty, aliases: [{ name: 'Member1Alias' }] } },
        { name: 'Member1Alias', result: { ...empty, groups: [{ name: 'OtherGroup' }] } },
      ],
      { rootKeys: new Set(['groupa']) },
    );
    const other = merged.groups.find((g) => g.name === 'OtherGroup');
    expect(other).toBeTruthy();
    expect(other.via).toBe('Member1Alias');
    expect(other.viaChain).toEqual(['Member1Alias', 'Member1']);
    expect(other.viaHadMemberStep).toBe(true);
  });

  it('does not fan into co-members when an alias resolves to a group', async () => {
    const { merged, closure } = await run(
      'Mark Allen',
      [
        { name: 'Mark Allen', result: { ...empty, aliases: [{ name: 'Hopefiend' }] } },
        {
          name: 'Hopefiend',
          result: {
            ...empty,
            members: [{ name: 'Mark Allen' }, { name: 'William Bryan Halsey' }],
          },
        },
        { name: 'William Bryan Halsey', result: { ...empty, groups: [{ name: 'Ultravibe' }] } },
      ],
      { rootKeys: new Set(['mark allen']) },
    );
    // WBH's group must NOT leak in, and WBH must not enter the closure.
    expect(merged.groups.map((g) => g.name)).not.toContain('Ultravibe');
    expect(closure.has('william bryan halsey')).toBe(false);
    // The alias is stripped so it can't bridge to other lineup acts.
    expect(merged.aliases.map((a) => a.name)).not.toContain('Hopefiend');
  });

  it('caps alias fan-out: registers names in closure without reading them', async () => {
    const aliases = Array.from({ length: 20 }, (_, i) => ({ name: `Pseudonym-${i}` }));
    aliases.push({ name: 'LineupMatch' });
    const { closure, calls } = await run(
      'Prolific',
      [{ name: 'Prolific', result: { ...empty, aliases } }],
      { rootKeys: new Set(['prolific', 'lineupmatch']) },
    );
    // Only the root is read — no alias is walked.
    expect(calls).toEqual(['prolific']);
    // But all alias names land in the closure for clustering.
    expect(closure.has('lineupmatch')).toBe(true);
    expect(closure.has('pseudonym 0')).toBe(true);
  });

  it('walks aliases normally when fan-out is at or below the cap', async () => {
    const aliases = Array.from({ length: 10 }, (_, i) => ({ name: `Alt-${i}` }));
    const { calls } = await run('Small', [{ name: 'Small', result: { ...empty, aliases } }]);
    expect(calls).toHaveLength(11); // root + 10 aliases
  });

  it('skips reading names that are themselves roots, but unions them into the closure', async () => {
    const { closure, calls } = await run(
      'A',
      [
        { name: 'A', result: { ...empty, aliases: [{ name: 'B' }] } },
        { name: 'B', result: { ...empty, groups: [{ name: 'B-Group' }] } },
      ],
      { rootKeys: new Set(['a', 'b']) },
    );
    expect(closure.has('b')).toBe(true); // unioned for clustering
    expect(calls).toEqual(['a']); // but B is another root's job — not read here
  });

  it('honours the budget cap and reports exhaustion on an unbounded chain', async () => {
    // Synthetic store: every node has exactly one alias to the next, forever.
    const calls = [];
    const neighbors = async (name) => {
      const key = normaliseName(name);
      calls.push(key);
      // Letter suffix so each name normalises to a distinct, ever-growing key.
      return { ...empty, aliases: [{ name: `${key}z` }] };
    };
    let exhausted = null;
    const { closure } = await identityClosure('seed', {
      neighbors,
      maxLookups: 5,
      onBudgetExhausted: (info) => {
        exhausted = info;
      },
    });
    expect(calls.length).toBeLessThanOrEqual(6); // root read + 5 budgeted reads
    expect(exhausted).toBeTruthy();
    expect(exhausted.skipped).toBeGreaterThan(0);
    expect(closure.size).toBeGreaterThan(0);
  });

  it('unions a node`s edges across providers into one cross-provider result', async () => {
    // The Phase 3 win: MB and Discogs lookups of the same artist combine. Phase 2
    // scoped reconstitution to one source_key; getQuadsTouching crosses them.
    // Asserted at the neighbour (reconstitution) level — the substrate capability
    // the traversal is built on, isolated from the walk's reverse-edge artifacts.
    const store = seedGraph([
      {
        provider: 'musicbrainz',
        name: 'Infected Mushroom',
        result: { ...empty, aliases: [{ name: 'IM' }], members: [{ name: 'Erez Aizen' }] },
      },
      {
        provider: 'discogs',
        name: 'Infected Mushroom',
        result: {
          ...empty,
          aliases: [{ name: 'I.M.' }],
          groups: [{ name: 'Fly Agaric' }],
          members: [{ name: 'Erez Eisen' }],
        },
      },
    ]);
    const { neighbors } = neighborsFrom(store);
    const node = await neighbors('infected mushroom');
    // Distinct names from both providers survive (normalisation keeps them apart).
    expect(node.aliases.map((a) => a.name).sort()).toEqual(['I.M.', 'IM']);
    expect(node.groups.map((g) => g.name)).toEqual(['Fly Agaric']);
    expect(node.members.map((m) => m.name).sort()).toEqual(['Erez Aizen', 'Erez Eisen']);
  });
});
