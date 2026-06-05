import { describe, it, expect } from 'vitest';
import { handleLookup } from '../functions/api/lookup.js';
import { SCHEMA_VERSION } from '../src/core/schemaVersion.js';

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v);
    },
  };
}

// fetch-like fake: routes by URL substring, returns a response with .ok/.status/.json.
function fakeFetch(routes) {
  return async (url) => {
    for (const [match, payload] of routes) {
      if (url.includes(match)) return { ok: true, status: 200, json: async () => payload };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const MB_SEARCH = { artists: [{ id: 'mb1', name: 'Test Artist', score: 100 }] };
const MB_DETAILS = { id: 'mb1', aliases: [{ name: 'TA' }], relations: [] };
const mbFetch = (counter) => async (url) => {
  if (counter) counter.n++;
  if (url.includes('/artist?')) return { ok: true, status: 200, json: async () => MB_SEARCH };
  if (url.includes('/artist/mb1')) return { ok: true, status: 200, json: async () => MB_DETAILS };
  throw new Error(`unexpected fetch: ${url}`);
};

const parse = (r) => JSON.parse(r.body);

describe('handleLookup', () => {
  it('miss → fetches, maps, stores; second call is a HIT without upstream', async () => {
    const KV = fakeKV();
    const counter = { n: 0 };
    const now = () => 1_000_000;
    const args = { provider: 'musicbrainz', name: 'Test Artist', fetchFn: mbFetch(counter), now };

    const first = await handleLookup({ KV }, args);
    expect(first.status).toBe(200);
    expect(first.cache).toBe('MISS');
    expect(parse(first).aliases.map((a) => a.name)).toEqual(['TA']);
    expect(counter.n).toBe(2); // search + details

    const second = await handleLookup({ KV }, args);
    expect(second.cache).toBe('HIT');
    expect(counter.n).toBe(2); // no further upstream calls
    expect(parse(second).aliases.map((a) => a.name)).toEqual(['TA']);
  });

  it('uses the unified (provider, normalisedName) key shape', async () => {
    const KV = fakeKV();
    await handleLookup(
      { KV },
      { provider: 'musicbrainz', name: 'Test Artist', fetchFn: mbFetch(), now: () => 1 },
    );
    const [key] = [...KV.store.keys()];
    expect(key).toBe(`lookup:${SCHEMA_VERSION}:musicbrainz:test artist`);
  });

  it('caches an empty result (no search match) and serves it as a HIT', async () => {
    const KV = fakeKV();
    const counter = { n: 0 };
    const empty = async () => {
      counter.n++;
      return { ok: true, status: 200, json: async () => ({ artists: [] }) };
    };
    const now = () => 1_000_000;
    const args = { provider: 'musicbrainz', name: 'Nobody', fetchFn: empty, now };
    const first = await handleLookup({ KV }, args);
    expect(first.cache).toBe('MISS');
    expect(parse(first)).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
    expect(counter.n).toBe(1); // only the search call; no match → no details
    const second = await handleLookup({ KV }, args);
    expect(second.cache).toBe('HIT');
    expect(counter.n).toBe(1);
  });

  it('expires an empty entry sooner than a non-empty one', async () => {
    const KV = fakeKV();
    const search = async () => ({ ok: true, status: 200, json: async () => ({ artists: [] }) });
    let t = 1_000_000;
    await handleLookup(
      { KV },
      { provider: 'musicbrainz', name: 'Nobody', fetchFn: search, now: () => t },
    );
    t += 8 * 24 * 3600 * 1000; // 8 days: past the 7-day empty TTL
    let calls = 0;
    const search2 = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ artists: [] }) };
    };
    const res = await handleLookup(
      { KV },
      { provider: 'musicbrainz', name: 'Nobody', fetchFn: search2, now: () => t },
    );
    expect(res.cache).toBe('MISS');
    expect(calls).toBe(1);
  });

  it('serves STALE from a prior entry when the upstream fails', async () => {
    const KV = fakeKV();
    let t = 1_000_000;
    await handleLookup(
      { KV },
      { provider: 'musicbrainz', name: 'Test Artist', fetchFn: mbFetch(), now: () => t },
    );
    t += 40 * 24 * 3600 * 1000; // past the 30-day non-empty TTL
    const failing = async () => {
      throw new Error('network down');
    };
    const res = await handleLookup(
      { KV },
      {
        provider: 'musicbrainz',
        name: 'Test Artist',
        fetchFn: failing,
        sleep: () => {},
        now: () => t,
      },
    );
    expect(res.cache).toBe('STALE');
    expect(parse(res).aliases.map((a) => a.name)).toEqual(['TA']);
  });

  it('returns 502 on upstream failure with no prior entry', async () => {
    const KV = fakeKV();
    const failing = async () => {
      throw new Error('network down');
    };
    const res = await handleLookup(
      { KV },
      {
        provider: 'musicbrainz',
        name: 'Test Artist',
        fetchFn: failing,
        sleep: () => {},
        now: () => 1,
      },
    );
    expect(res.status).toBe(502);
    expect(res.cache).toBeNull();
    expect(KV.store.size).toBe(0);
  });

  it('treats an entry from a different schema version as a miss', async () => {
    const KV = fakeKV();
    const counter = { n: 0 };
    const now = () => 1_000_000;
    const args = { provider: 'musicbrainz', name: 'Test Artist', fetchFn: mbFetch(counter), now };
    await handleLookup({ KV }, args);
    const [[key, raw]] = KV.store.entries();
    KV.store.set(key, JSON.stringify({ ...JSON.parse(raw), v: SCHEMA_VERSION + 99 }));
    const res = await handleLookup({ KV }, args);
    expect(res.cache).toBe('MISS');
    expect(counter.n).toBe(4); // 2 (first) + 2 (re-fetch on version mismatch)
  });

  it('degrades to pass-through (BYPASS) when env.KV is missing', async () => {
    const counter = { n: 0 };
    const res = await handleLookup(
      {},
      { provider: 'musicbrainz', name: 'Test Artist', fetchFn: mbFetch(counter), now: () => 1 },
    );
    expect(res.cache).toBe('BYPASS');
    expect(parse(res).aliases.map((a) => a.name)).toEqual(['TA']);
    expect(counter.n).toBe(2);
  });

  it('rejects an unknown provider', async () => {
    const res = await handleLookup({ KV: fakeKV() }, { provider: 'spotify', name: 'x' });
    expect(res.status).toBe(400);
  });

  it('refuses Discogs when no token is configured', async () => {
    const res = await handleLookup({ KV: fakeKV() }, { provider: 'discogs', name: 'x' });
    expect(res.status).toBe(500);
  });

  it('runs the Discogs pipeline when a token is present', async () => {
    const KV = fakeKV();
    const search = { results: [{ id: 7, title: 'Test Artist' }] };
    const details = { id: 7, aliases: [{ id: 8, name: 'TA' }], groups: [], members: [] };
    const fetchFn = fakeFetch([
      ['/database/search', search],
      ['/artists/7', details],
    ]);
    const res = await handleLookup(
      { KV, DISCOGS_TOKEN: 'tok' },
      { provider: 'discogs', name: 'Test Artist', fetchFn, now: () => 1 },
    );
    expect(res.cache).toBe('MISS');
    expect(parse(res).aliases.map((a) => a.name)).toEqual(['TA']);
  });
});
