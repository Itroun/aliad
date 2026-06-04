import { describe, it, expect } from 'vitest';
import { cachedFetch, CACHE_VERSION } from '../functions/_lib/edgeCache.js';

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

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseArgs = {
  provider: 'musicbrainz',
  upstreamUrl: 'https://musicbrainz.org/ws/2/artist?query=x',
  ttlFor: () => 100, // 100 seconds
};

describe('cachedFetch', () => {
  it('miss → calls upstream, stores, and second call is a HIT without upstream', async () => {
    const KV = fakeKV();
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      return jsonResponse({ artists: [{ name: 'x' }] });
    };
    const now = () => 1_000_000;

    const first = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now });
    expect(first.cache).toBe('MISS');
    expect(first.response.headers.get('X-Cache')).toBe('MISS');
    expect(calls).toBe(1);

    const second = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now });
    expect(second.cache).toBe('HIT');
    expect(second.response.headers.get('X-Cache')).toBe('HIT');
    expect(calls).toBe(1); // upstream not called again
    expect(await second.response.text()).toContain('artists');
  });

  it('fresh hit skips upstream entirely', async () => {
    const KV = fakeKV();
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      return jsonResponse({ artists: [{ name: 'x' }] });
    };
    let t = 1_000_000;
    await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    t += 50_000; // still within 100s TTL
    const hit = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    expect(hit.cache).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('expired entry triggers a refetch (MISS) and restores the entry', async () => {
    const KV = fakeKV();
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      return jsonResponse({ artists: [{ name: 'x', call: calls }] });
    };
    let t = 1_000_000;
    await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    t += 200_000; // past the 100s TTL
    const refetch = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    expect(refetch.cache).toBe('MISS');
    expect(calls).toBe(2);
    // now fresh again
    const hit = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    expect(hit.cache).toBe('HIT');
    expect(calls).toBe(2);
  });

  it('serves STALE on upstream network error when a prior entry exists', async () => {
    const KV = fakeKV();
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      if (calls === 1) return jsonResponse({ artists: [{ name: 'stored' }] });
      throw new Error('network down');
    };
    let t = 1_000_000;
    await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    t += 200_000; // expired
    const stale = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    expect(stale.cache).toBe('STALE');
    expect(stale.response.headers.get('X-Cache')).toBe('STALE');
    expect(await stale.response.text()).toContain('stored');
  });

  it('serves STALE on upstream 5xx when a prior entry exists', async () => {
    const KV = fakeKV();
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      if (calls === 1) return jsonResponse({ artists: [{ name: 'stored' }] });
      return new Response('upstream boom', { status: 503 });
    };
    let t = 1_000_000;
    await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    t += 200_000;
    const stale = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => t });
    expect(stale.cache).toBe('STALE');
    expect(await stale.response.text()).toContain('stored');
  });

  it('does not cache an error and passes it through when no prior entry exists', async () => {
    const KV = fakeKV();
    const upstreamFn = async () => new Response('nope', { status: 503 });
    const res = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => 1 });
    expect(res.response.status).toBe(503);
    expect(KV.store.size).toBe(0);
  });

  it('applies the ttlFor-chosen TTL (empty shorter than non-empty)', async () => {
    const KV = fakeKV();
    const ttlFor = (body) => (body?.artists?.length ? 100 : 10);
    const upstreamFn = async () => jsonResponse({ artists: [] });
    let t = 1_000_000;
    await cachedFetch({ KV }, { ...baseArgs, ttlFor, upstreamFn, now: () => t });
    t += 20_000; // past the 10s empty TTL
    let calls = 0;
    const upstream2 = async () => {
      calls++;
      return jsonResponse({ artists: [] });
    };
    const res = await cachedFetch(
      { KV },
      { ...baseArgs, ttlFor, upstreamFn: upstream2, now: () => t },
    );
    expect(res.cache).toBe('MISS'); // empty entry already expired
    expect(calls).toBe(1);
  });

  it('treats an entry from a different cache version as a miss', async () => {
    const KV = fakeKV();
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      return jsonResponse({ artists: [{ name: 'x' }] });
    };
    const now = () => 1_000_000;
    // Prime the cache, then corrupt the stored version.
    await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now });
    const [[key, raw]] = KV.store.entries();
    KV.store.set(key, JSON.stringify({ ...JSON.parse(raw), v: CACHE_VERSION + 99 }));
    const res = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now });
    expect(res.cache).toBe('MISS');
    expect(calls).toBe(2);
  });

  it('degrades to pure pass-through when env.KV is missing', async () => {
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      return jsonResponse({ artists: [] });
    };
    const res = await cachedFetch({}, { ...baseArgs, upstreamFn });
    expect(res.cache).toBe('BYPASS');
    expect(calls).toBe(1);
    expect(res.response.headers.get('X-Cache')).toBe('BYPASS');
  });

  it('never throws when KV.get throws (treats as miss)', async () => {
    const KV = {
      get: async () => {
        throw new Error('kv down');
      },
      put: async () => {},
    };
    let calls = 0;
    const upstreamFn = async () => {
      calls++;
      return jsonResponse({ artists: [] });
    };
    const res = await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now: () => 1 });
    expect(res.cache).toBe('MISS');
    expect(calls).toBe(1);
  });

  it('keys distinct upstream URLs separately', async () => {
    const KV = fakeKV();
    const upstreamFn = async () => jsonResponse({ artists: [{ name: 'x' }] });
    const now = () => 1_000_000;
    await cachedFetch({ KV }, { ...baseArgs, upstreamFn, now });
    await cachedFetch(
      { KV },
      { ...baseArgs, upstreamUrl: 'https://musicbrainz.org/ws/2/artist?query=y', upstreamFn, now },
    );
    expect(KV.store.size).toBe(2);
  });
});
