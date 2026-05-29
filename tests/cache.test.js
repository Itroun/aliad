import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { createCache, SCHEMA_VERSION } from '../src/core/cache.js';

const DAY = 24 * 60 * 60 * 1000;

function nonEmptyResult() {
  return {
    aliases: [{ name: 'Foo' }],
    groups: [],
    members: [],
    relatedProjects: [],
  };
}

function emptyResult() {
  return { aliases: [], groups: [], members: [], relatedProjects: [] };
}

let dbCounter = 0;
function freshDb() {
  return `aka-test-${Date.now()}-${dbCounter++}`;
}

describe('cache', () => {
  it('miss → fetch → write → next read returns cached without re-fetching', async () => {
    const fetch = vi.fn().mockResolvedValue(nonEmptyResult());
    const cache = createCache({ db: freshDb() });

    const first = await cache.lookup('mb', 'foo', { fetch });
    expect(first.cached).toBe(false);
    expect(first.fromPersistent).toBe(false);
    expect(first.result.aliases).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const second = await cache.lookup('mb', 'foo', { fetch });
    expect(second.cached).toBe(true);
    expect(second.fromPersistent).toBe(true);
    expect(second.stale).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keys are scoped by provider name', async () => {
    const fetchMb = vi.fn().mockResolvedValue(nonEmptyResult());
    const fetchDc = vi.fn().mockResolvedValue(emptyResult());
    const cache = createCache({ db: freshDb() });

    await cache.lookup('mb', 'foo', { fetch: fetchMb });
    await cache.lookup('discogs', 'foo', { fetch: fetchDc });

    expect(fetchMb).toHaveBeenCalledTimes(1);
    expect(fetchDc).toHaveBeenCalledTimes(1);
  });

  it('non-empty results use a 30-day TTL', async () => {
    let now = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValue(nonEmptyResult());
    const cache = createCache({ db: freshDb(), now: () => now });

    await cache.lookup('mb', 'foo', { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 29 * DAY;
    await cache.lookup('mb', 'foo', { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 2 * DAY; // 31 days → stale
    await cache.lookup('mb', 'foo', { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('empty results use a 7-day TTL', async () => {
    let now = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValue(emptyResult());
    const cache = createCache({ db: freshDb(), now: () => now });

    await cache.lookup('mb', 'foo', { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 6 * DAY;
    await cache.lookup('mb', 'foo', { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 2 * DAY; // 8 days → stale
    await cache.lookup('mb', 'foo', { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stale + fetch failure returns the stale value flagged stale:true', async () => {
    let now = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValueOnce(nonEmptyResult());
    const cache = createCache({ db: freshDb(), now: () => now });

    await cache.lookup('mb', 'foo', { fetch });
    now += 31 * DAY;
    fetch.mockRejectedValueOnce(new Error('network down'));

    const out = await cache.lookup('mb', 'foo', { fetch });
    expect(out.result.aliases).toHaveLength(1);
    expect(out.stale).toBe(true);
    expect(out.cached).toBe(true);
    expect(out.fromPersistent).toBe(true);
  });

  it('fetch failure on miss propagates', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('boom'));
    const cache = createCache({ db: freshDb() });

    await expect(cache.lookup('mb', 'foo', { fetch })).rejects.toThrow('boom');
  });

  it('does not cache failures', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(nonEmptyResult());
    const cache = createCache({ db: freshDb() });

    await expect(cache.lookup('mb', 'foo', { fetch })).rejects.toThrow('boom');
    const out = await cache.lookup('mb', 'foo', { fetch });
    expect(out.result.aliases).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('schema-version mismatch is treated as a miss', async () => {
    const dbName = freshDb();
    const fetch = vi.fn().mockResolvedValue(nonEmptyResult());
    const cache = createCache({ db: dbName });
    await cache.lookup('mb', 'foo', { fetch });

    // Tamper directly with the stored entry to fake a schema bump.
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('lookups', 'readwrite');
      const store = tx.objectStore('lookups');
      const getReq = store.get('mb::foo');
      getReq.onsuccess = () => {
        const v = getReq.result;
        v.schemaVersion = SCHEMA_VERSION + 99;
        store.put(v, 'mb::foo');
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const out = await cache.lookup('mb', 'foo', { fetch });
    expect(out.cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('AbortError during refresh does not write; stale value returned', async () => {
    let now = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValueOnce(nonEmptyResult());
    const cache = createCache({ db: freshDb(), now: () => now });

    await cache.lookup('mb', 'foo', { fetch });
    now += 31 * DAY;

    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetch.mockRejectedValueOnce(abortErr);

    const out = await cache.lookup('mb', 'foo', { fetch });
    expect(out.stale).toBe(true);
    expect(out.result.aliases).toHaveLength(1);

    // Next call should still see the same stale entry — abort didn't poison it.
    fetch.mockResolvedValueOnce(nonEmptyResult());
    const out2 = await cache.lookup('mb', 'foo', { fetch });
    expect(out2.stale).toBe(false);
    expect(out2.result.aliases).toHaveLength(1);
  });

  it('stats tracks hits, misses, stale, writes', async () => {
    let now = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValue(nonEmptyResult());
    const cache = createCache({ db: freshDb(), now: () => now });

    expect(cache.stats()).toEqual({ hits: 0, misses: 0, stale: 0, writes: 0 });

    await cache.lookup('mb', 'foo', { fetch });
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, stale: 0, writes: 1 });

    await cache.lookup('mb', 'foo', { fetch });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, stale: 0, writes: 1 });

    now += 31 * DAY;
    await cache.lookup('mb', 'foo', { fetch });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, stale: 1, writes: 2 });
  });

  it('clear() empties the store', async () => {
    const fetch = vi.fn().mockResolvedValue(nonEmptyResult());
    const cache = createCache({ db: freshDb() });

    await cache.lookup('mb', 'foo', { fetch });
    await cache.clear();
    await cache.lookup('mb', 'foo', { fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
