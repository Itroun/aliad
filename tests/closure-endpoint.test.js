import { describe, it, expect } from 'vitest';
import { runClosure } from '../server/api/closure.js';
import { fakeRateLimiterNs } from './helpers/fakeRateLimiter.js';
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
    await seedHit(store, 'discogs', 'Shpongle', { ...empty, members: [{ name: 'Raja Ram' }] });
    // Seeded under musicbrainz, which the walk no longer consults (TEMP removal
    // in closure.js): the quads must still enrich the union via
    // getQuadsTouching — dormant MB data keeps contributing.
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

    // Root's Discogs lookup is a HIT off the seeded substrate; at least one
    // progress event carried the running merged.
    const dgRoot = of('provider').find((p) => p.name === 'Shpongle' && p.provider === 'discogs');
    expect(dgRoot.serverCache).toBe('HIT');
    // A HIT never consulted the upstream, so it carries no stats.
    expect(dgRoot.stats).toBeUndefined();
    expect(of('progress').length).toBeGreaterThan(0);
    // MB is TEMP-removed from the walk: no lookups, no provider events.
    expect(of('provider').filter((p) => p.provider === 'musicbrainz')).toHaveLength(0);
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
      ['/database/search?q=Solo', { results: [{ id: 7, title: 'Solo Artist' }] }],
      ['/artists/7', { id: 7, aliases: [{ name: 'SA' }] }],
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

    const dg = cap.of('provider').find((p) => p.name === 'Solo Artist' && p.provider === 'discogs');
    expect(dg.serverCache).toBe('MISS');
    expect(dg.ok).toBe(true);
    // Cold lookup → the event carries the upstream telemetry (search + details).
    expect(dg.stats).toEqual({
      calls: 2,
      retries: 0,
      status429: 0,
      gateWaitMs: 0,
      dumpHit: 0,
      dumpError: 0,
    });
    // The fetched result was decomposed into the substrate.
    expect(store.lookups.has('discogs:solo artist')).toBe(true);
    const [done] = cap.of('done');
    expect(done.merged.aliases.map((a) => a.name)).toContain('SA');
    expect(done.queried).toContain('discogs');
  });

  it('takes rate-gate tokens at root priority for the root, expand for interior nodes', async () => {
    const store = fakeStore();
    const ns = fakeRateLimiterNs([{ granted: true }]);
    const envWithGate = { DISCOGS_TOKEN: 'tok', RATE_LIMITER: ns };
    // A dormant MB seed gives the root one walkable alias, so the walk does
    // exactly one interior lookup; Discogs searches return no match (one gated
    // call per node).
    await seedHit(store, 'musicbrainz', 'Solo Artist', {
      ...empty,
      aliases: [{ name: 'Second Self' }],
    });
    const fetchFn = benignFetch();

    const cap = capture();
    await runClosure(envWithGate, {
      root: 'Solo Artist',
      roots: ['Solo Artist'],
      store,
      now: () => 1,
      fetchFn,
      emit: cap.emit,
    });

    const tiers = ns.urls.map((u) => new URL(u).searchParams.get('priority'));
    expect(tiers[0]).toBe('root');
    expect(tiers).toContain('expand');
    expect(tiers.filter((t) => t === 'root').length).toBe(1);
  });

  it('stops the walk at the next node once the signal aborts', async () => {
    const store = fakeStore();
    // Root has a walkable alias, so an un-aborted walk would do a second node.
    await seedHit(store, 'musicbrainz', 'Solo Artist', {
      ...empty,
      aliases: [{ name: 'Second Self' }],
    });
    const fetchFn = benignFetch();
    const signal = { aborted: false };
    const cap = capture();
    let providerEvents = 0;
    const emit = (event, data) => {
      // Client disconnects right after the root's own provider lookup (one per
      // node with MB TEMP-removed), before the walk reads the alias node.
      if (event === 'provider' && ++providerEvents === 1) signal.aborted = true;
      cap.emit(event, data);
    };
    await expect(
      runClosure(env, {
        root: 'Solo Artist',
        roots: ['Solo Artist'],
        store,
        now: () => 1,
        fetchFn,
        emit,
        signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // Only the root's cold Discogs lookup hit the wire; the alias node was
    // never fetched.
    const lookedUp = cap.of('provider').map((p) => p.name);
    expect(lookedUp).toEqual(['Solo Artist']);
  });

  it('re-roots onto the base name when a performance-mode billing resolves to nothing', async () => {
    const store = fakeStore();
    // The billed name is absent from the sources; the base name is not.
    await seedHit(store, 'discogs', 'Etnica', { ...empty, members: [{ name: 'Max Lanfranconi' }] });

    const cap = capture();
    await runClosure(env, {
      root: 'Etnica in DUB',
      roots: ['Etnica in DUB'],
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: cap.emit,
    });

    expect(cap.of('resolved')).toEqual([{ from: 'Etnica in DUB', to: 'Etnica' }]);
    const [done] = cap.of('done');
    expect(done.merged.members.map((m) => m.name)).toContain('Max Lanfranconi');
    expect(done.closure).toContain('etnica');
  });

  it('does not re-root when the billed name resolves', async () => {
    const store = fakeStore();
    // A real artist whose name ends in a qualifier word. The rule must not fire.
    await seedHit(store, 'discogs', 'Synergy Dub', {
      ...empty,
      members: [{ name: 'Some Person' }],
    });

    const cap = capture();
    await runClosure(env, {
      root: 'Synergy Dub',
      roots: ['Synergy Dub'],
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: cap.emit,
    });

    expect(cap.of('resolved')).toHaveLength(0);
    expect(cap.of('done')[0].merged.members.map((m) => m.name)).toContain('Some Person');
  });

  it('skips the re-root when another lineup row already owns the base name', async () => {
    const store = fakeStore();
    await seedHit(store, 'discogs', 'Etnica', { ...empty, members: [{ name: 'Max Lanfranconi' }] });

    const cap = capture();
    await runClosure(env, {
      root: 'Etnica in DUB',
      // "Etnica" is billed on its own elsewhere in the lineup — it renders the
      // cluster, and two streams sharing an ownRootKey would duplicate it.
      roots: ['Etnica in DUB', 'Etnica'],
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: cap.emit,
    });

    expect(cap.of('resolved')).toHaveLength(0);
    expect(isEmpty(cap.of('done')[0].merged)).toBe(true);
  });

  it('does not re-root when the root lookup ERRORED rather than missed', async () => {
    const store = fakeStore();
    await seedHit(store, 'discogs', 'Etnica', { ...empty, members: [{ name: 'Max Lanfranconi' }] });
    // The billed name's lookup fails at the wire. An empty result here means
    // "we don't know", not "absent" — substituting a different artist off a
    // transient 503 would be a confident wrong answer.
    const fetchFn = async (url) => {
      if (url.includes('/database/search')) throw new Error('upstream down');
      throw new Error(`unexpected fetch: ${url}`);
    };

    const cap = capture();
    await runClosure(env, {
      root: 'Etnica in DUB',
      roots: ['Etnica in DUB'],
      store,
      now: () => 1,
      fetchFn,
      emit: cap.emit,
    });

    expect(cap.of('resolved')).toHaveLength(0);
    // …and the failure is still reported rather than masked by a second walk.
    expect(cap.of('done')[0].errored).toContain('discogs');
  });

  it('does not re-root a combo billing the client already split', async () => {
    const store = fakeStore();
    const cap = capture();
    // The combo name resolves empty by design — lookupAll walks the parts. The
    // qualifier strip would otherwise burn a root-tier token on a nonsense name.
    await runClosure(env, {
      root: 'Mathew Jonson presents Freedom Engine Live',
      roots: ['Mathew Jonson presents Freedom Engine Live'],
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: cap.emit,
    });

    expect(cap.of('resolved')).toHaveLength(0);
    expect(cap.of('provider').map((p) => p.name)).toEqual([
      'Mathew Jonson presents Freedom Engine Live',
    ]);
  });

  it('lets only the first of two rows sharing a base name re-root', async () => {
    const store = fakeStore();
    await seedHit(store, 'discogs', 'Etnica', { ...empty, members: [{ name: 'Max Lanfranconi' }] });
    const roots = ['Etnica in DUB', 'Etnica Live'];

    const first = capture();
    await runClosure(env, {
      root: 'Etnica in DUB',
      roots,
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: first.emit,
    });
    const second = capture();
    await runClosure(env, {
      root: 'Etnica Live',
      roots,
      store,
      now: () => 1,
      fetchFn: benignFetch(),
      emit: second.emit,
    });

    // Both re-rooting would render the same artist as two nodes and draw an
    // edge between them.
    expect(first.of('resolved')).toHaveLength(1);
    expect(second.of('resolved')).toHaveLength(0);
  });

  it('gives the re-rooted lookup root-tier gate priority, not expand', async () => {
    const store = fakeStore();
    const ns = fakeRateLimiterNs([{ granted: true }]);
    // Both the billed name and the base name are cold, so each takes a token
    // and the tier is recorded per wire attempt. No walkable edges, so the
    // only gated calls are the two roots.
    const cap = capture();
    await runClosure(
      { DISCOGS_TOKEN: 'tok', RATE_LIMITER: ns },
      {
        root: 'Etnica in DUB',
        roots: ['Etnica in DUB'],
        store,
        now: () => 1,
        fetchFn: benignFetch(),
        emit: cap.emit,
      },
    );

    expect(cap.of('resolved')).toEqual([{ from: 'Etnica in DUB', to: 'Etnica' }]);
    const tiers = ns.urls.map((u) => new URL(u).searchParams.get('priority'));
    // The base-name lookup is this stream's root now: it must not queue behind
    // other streams' deep walks on the expand tier.
    expect(tiers).toEqual(['root', 'root']);
  });

  it('emits an error event when no graph substrate is available', async () => {
    const cap = capture();
    await runClosure({}, { root: 'X', roots: ['X'], emit: cap.emit });
    expect(cap.of('error')).toHaveLength(1);
    expect(cap.of('done')).toHaveLength(0);
  });
});
