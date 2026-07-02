import { describe, it, expect } from 'vitest';
import { runClosure } from '../server/api/closure.js';
import { resultToQuads, sourceKeyFor } from '../src/core/quads.js';
import { normaliseName } from '../src/core/merge.js';
import { SCHEMA_VERSION } from '../src/core/schemaVersion.js';

// In-memory D1 stand-in for the closure endpoint: same three methods handleLookup
// uses PLUS getQuadsTouching (the cross-lookup read the walk reads neighbours
// through). Mirrors tests/lookupEndpoint.test.js's fakeStore.
function fakeStore() {
  const lookups = new Map(); // sourceKey -> row (snake_case)
  const quads = new Map(); // sourceKey -> quad[]
  return {
    lookups,
    quads,
    async getLookup(sourceKey) {
      return lookups.get(sourceKey) ?? null;
    },
    async getQuads(sourceKey) {
      return quads.get(sourceKey) ?? [];
    },
    async getQuadsTouching(key) {
      const out = [];
      for (const qs of quads.values()) {
        for (const q of qs) if (q.subject === key || q.object === key) out.push(q);
      }
      return out;
    },
    async putLookupWithQuads(row, qs) {
      lookups.set(row.sourceKey, {
        source_key: row.sourceKey,
        provider: row.provider,
        name_key: row.nameKey,
        schema_version: row.schemaVersion,
        fetched_at: row.fetchedAt,
        is_empty: row.isEmpty ? 1 : 0,
        expires_at: row.expiresAt,
      });
      quads.set(row.sourceKey, qs);
    },
  };
}

const empty = { aliases: [], groups: [], members: [], relatedProjects: [] };
const isEmpty = (r) =>
  !r.aliases?.length && !r.groups?.length && !r.members?.length && !r.relatedProjects?.length;

// Seed a fresh (never-expiring) HIT for one (provider, name) into the store.
function seedHit(store, provider, name, result) {
  const nameKey = normaliseName(name);
  return store.putLookupWithQuads(
    {
      sourceKey: sourceKeyFor(provider, nameKey),
      provider,
      nameKey,
      schemaVersion: SCHEMA_VERSION,
      fetchedAt: 1,
      isEmpty: isEmpty(result),
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    resultToQuads(provider, nameKey, name, result),
  );
}

// Returns empty search results for anything not otherwise routed, so cold nodes
// (aliases/members we didn't seed) resolve to an empty MISS instead of throwing.
function benignFetch(routes = []) {
  return async (url) => {
    for (const [match, payload] of routes) {
      if (url.includes(match)) return { ok: true, status: 200, json: async () => payload };
    }
    if (url.includes('/database/search'))
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    if (url.includes('/artist?'))
      return { ok: true, status: 200, json: async () => ({ artists: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function capture() {
  const events = [];
  const emit = (event, data) => events.push([event, data]);
  const of = (name) => events.filter(([e]) => e === name).map(([, d]) => d);
  return { events, emit, of };
}

const env = { DISCOGS_TOKEN: 'tok' };

describe('runClosure (SSE endpoint core)', () => {
  it('walks a pre-seeded substrate and streams provider/progress/done events', async () => {
    const store = fakeStore();
    await seedHit(store, 'musicbrainz', 'Shpongle', { ...empty, members: [{ name: 'Raja Ram' }] });
    await seedHit(store, 'musicbrainz', 'Raja Ram', {
      ...empty,
      groups: [{ name: 'The Infinity Project' }],
    });

    const { emit, of } = capture();
    await runClosure(env, {
      root: 'Shpongle',
      roots: ['Shpongle'],
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit,
    });

    const [done] = of('done');
    expect(done.merged.groups.map((g) => g.name)).toContain('The Infinity Project');
    expect(done.merged.groups.find((g) => g.name === 'The Infinity Project').via).toBe('Raja Ram');
    expect(done.closure).toContain('shpongle');
    expect(done.closure).toContain('raja ram');

    // Root's MB lookup is a HIT off the seeded substrate; at least one progress
    // event carried the running merged.
    const mbRoot = of('provider').find(
      (p) => p.name === 'Shpongle' && p.provider === 'musicbrainz',
    );
    expect(mbRoot.serverCache).toBe('HIT');
    // A HIT never consulted the upstream, so it carries no stats.
    expect(mbRoot.stats).toBeUndefined();
    expect(of('progress').length).toBeGreaterThan(0);
  });

  it('unions a node`s edges across providers (the Phase 3 cross-provider win)', async () => {
    const store = fakeStore();
    await seedHit(store, 'musicbrainz', 'Infected Mushroom', {
      ...empty,
      aliases: [{ name: 'IM', type: 'Search hint' }],
    });
    await seedHit(store, 'discogs', 'Infected Mushroom', {
      ...empty,
      groups: [{ name: 'Fly Agaric' }],
    });

    const cap = capture();
    await runClosure(env, {
      root: 'Infected Mushroom',
      roots: ['Infected Mushroom'],
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: cap.emit,
    });

    const [done] = cap.of('done');
    // MB alias + Discogs group both surface on the one root node.
    expect(done.merged.aliases.map((a) => a.name)).toContain('IM');
    expect(done.merged.groups.map((g) => g.name)).toContain('Fly Agaric');
  });

  it('drives a cold fetch through handleLookup, writing the substrate', async () => {
    const store = fakeStore();
    const fetchFn = benignFetch([
      ['/artist?', { artists: [{ id: 'mb1', name: 'Solo Artist', score: 100 }] }],
      ['/artist/mb1', { id: 'mb1', aliases: [{ name: 'SA', type: 'Search hint' }], relations: [] }],
    ]);

    const cap = capture();
    await runClosure(env, {
      root: 'Solo Artist',
      roots: ['Solo Artist'],
      store,
      now: () => 1,
      fetchFn,
      emit: cap.emit,
    });

    const mb = cap
      .of('provider')
      .find((p) => p.name === 'Solo Artist' && p.provider === 'musicbrainz');
    expect(mb.serverCache).toBe('MISS');
    expect(mb.ok).toBe(true);
    // Cold lookup → the event carries the upstream telemetry (search + details).
    expect(mb.stats).toEqual({ calls: 2, retries: 0, status429: 0, gateWaitMs: 0 });
    // The fetched result was decomposed into the substrate.
    expect(store.lookups.has('musicbrainz:solo artist')).toBe(true);
    const [done] = cap.of('done');
    expect(done.merged.aliases.map((a) => a.name)).toContain('SA');
    expect(done.queried).toContain('musicbrainz');
  });

  it('takes rate-gate tokens at root priority for the root, expand for interior nodes', async () => {
    const store = fakeStore();
    const gateUrls = [];
    const envWithGate = {
      DISCOGS_TOKEN: 'tok',
      RATE_LIMITER: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (url) => {
            gateUrls.push(url);
            return { json: async () => ({ granted: true }) };
          },
        }),
      },
    };
    // Root has one walkable alias so the walk does exactly one interior lookup;
    // Discogs searches return no match (one gated call per node).
    const fetchFn = benignFetch([
      [
        '/artist?query=artist%3A%22Solo',
        { artists: [{ id: 'mb1', name: 'Solo Artist', score: 100 }] },
      ],
      ['/artist/mb1', { id: 'mb1', aliases: [{ name: 'Second Self' }], relations: [] }],
    ]);

    const cap = capture();
    await runClosure(envWithGate, {
      root: 'Solo Artist',
      roots: ['Solo Artist'],
      store,
      now: () => 1,
      fetchFn,
      emit: cap.emit,
    });

    const tiers = gateUrls.map((u) => new URL(u).searchParams.get('priority'));
    expect(tiers[0]).toBe('root');
    expect(tiers).toContain('expand');
    expect(tiers.filter((t) => t === 'root').length).toBe(1);
  });

  it('emits an error event when no graph substrate is available', async () => {
    const cap = capture();
    await runClosure({}, { root: 'X', roots: ['X'], emit: cap.emit });
    expect(cap.of('error')).toHaveLength(1);
    expect(cap.of('done')).toHaveLength(0);
  });
});
