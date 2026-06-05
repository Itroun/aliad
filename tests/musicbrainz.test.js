import { describe, it, expect } from 'vitest';
import { lookup } from '../src/providers/musicbrainz.js';

// Phase 2b: the provider is a thin client over /api/lookup, which returns the
// already-mapped result. Search/pick/map are tested in musicbrainz.map.test.js
// and lookupEndpoint.test.js; here we only check the client plumbing.

function fakeFetch(payload, { status = 200, ok = true, cache } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return {
      ok,
      status,
      headers: { get: (h) => (h === 'X-Cache' ? (cache ?? null) : null) },
      json: async () => payload,
    };
  };
  return { fetchFn, calls };
}

const MAPPED = { aliases: [{ name: 'I.M.' }], groups: [], members: [], relatedProjects: [] };

describe('musicbrainz.lookup (thin client)', () => {
  it('requests /api/lookup with provider and url-encoded name', async () => {
    const { fetchFn, calls } = fakeFetch(MAPPED);
    const result = await lookup('Infected Mushroom', { fetchFn });
    expect(calls[0]).toBe('/api/lookup?provider=musicbrainz&name=Infected%20Mushroom');
    expect(result).toEqual(MAPPED);
  });

  it('surfaces the server X-Cache header via recordMeta', async () => {
    const { fetchFn } = fakeFetch(MAPPED, { cache: 'HIT' });
    const seen = [];
    await lookup('x', { fetchFn, recordMeta: (m) => seen.push(m) });
    expect(seen).toContainEqual({ serverCache: 'HIT' });
  });

  it('throws on a non-ok response', async () => {
    const { fetchFn } = fakeFetch({}, { ok: false, status: 502 });
    await expect(lookup('x', { fetchFn, sleep: () => {} })).rejects.toThrow(/502/);
  });

  it('propagates network errors', async () => {
    const fetchFn = async () => {
      throw new Error('offline');
    };
    await expect(lookup('x', { fetchFn, sleep: () => {} })).rejects.toThrow('offline');
  });
});
