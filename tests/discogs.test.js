import { describe, it, expect } from 'vitest';
import { lookup } from '../src/providers/discogs.js';

// Phase 2b: the provider is a thin client over /api/lookup. Mapping logic is
// tested in discogs.map.test.js and lookupEndpoint.test.js.

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

describe('discogs.lookup (thin client)', () => {
  it('requests /api/lookup with provider and url-encoded name', async () => {
    const { fetchFn, calls } = fakeFetch(MAPPED);
    const result = await lookup('Infected Mushroom', { fetchFn });
    expect(calls[0]).toBe('/api/lookup?provider=discogs&name=Infected%20Mushroom');
    expect(result).toEqual(MAPPED);
  });

  it('surfaces the server X-Cache header via recordMeta', async () => {
    const { fetchFn } = fakeFetch(MAPPED, { cache: 'MISS' });
    const seen = [];
    await lookup('x', { fetchFn, recordMeta: (m) => seen.push(m) });
    expect(seen).toContainEqual({ serverCache: 'MISS' });
  });

  it('throws on a non-ok response', async () => {
    const { fetchFn } = fakeFetch({}, { ok: false, status: 429 });
    await expect(lookup('x', { fetchFn, sleep: () => {} })).rejects.toThrow(/429/);
  });
});
