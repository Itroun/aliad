import { describe, it, expect, vi } from 'vitest';
import { makeDumpStore } from '../server/_lib/dumpStore.js';

const ENV = {
  TURSO_DUMP_URL: 'https://db-org.aws-eu-west-1.turso.io/',
  TURSO_DUMP_TOKEN: 'ro-token',
};

// Build a Hrana /v2/pipeline response: one execute result per statement, plus
// the trailing close. `rows` is an array of cell-value arrays.
const okExecute = (rows) => ({
  type: 'ok',
  response: { type: 'execute', result: { cols: [], rows } },
});
const intCell = (n) => ({ type: 'integer', value: String(n) });
const textCell = (s) => ({ type: 'text', value: s });
const pipeline = (presenceRows, edgeRows) => ({
  results: [
    okExecute(presenceRows),
    okExecute(edgeRows),
    { type: 'ok', response: { type: 'close' } },
  ],
});

const fetchReturning = (payload, { ok = true, status = 200 } = {}) =>
  vi.fn(async () => ({ ok, status, json: async () => payload }));

describe('makeDumpStore', () => {
  it('returns null when the dump binding/token is unset (degrade-open)', () => {
    expect(makeDumpStore({})).toBeNull();
    expect(makeDumpStore({ TURSO_DUMP_URL: 'x' })).toBeNull();
    expect(makeDumpStore({ TURSO_DUMP_TOKEN: 'x' })).toBeNull();
  });

  it('maps a hit with edges into a Discogs details shape, grouped by kind', async () => {
    const fetchFn = fetchReturning(
      pipeline(
        [[intCell(12)]],
        [
          [textCell('a'), intCell(20), textCell('Sølo Act')],
          [textCell('g'), intCell(30), textCell('The Collective')],
          [textCell('m'), intCell(40), textCell('First Member')],
          [textCell('a'), intCell(21), textCell('Alter Ego')],
        ],
      ),
    );
    const store = makeDumpStore(ENV, { fetchFn });
    const details = await store.getArtist('mobius co');
    expect(details).toEqual({
      id: 12,
      aliases: [
        { id: 20, name: 'Sølo Act' },
        { id: 21, name: 'Alter Ego' },
      ],
      groups: [{ id: 30, name: 'The Collective' }],
      members: [{ id: 40, name: 'First Member' }],
    });
  });

  it('returns a known-empty details object for a present, relation-less artist', async () => {
    const fetchFn = fetchReturning(pipeline([[intCell(11)]], []));
    const store = makeDumpStore(ENV, { fetchFn });
    const details = await store.getArtist('lonely solo');
    expect(details).toEqual({ id: 11, aliases: [], groups: [], members: [] });
  });

  it('returns null for a name absent from the dump', async () => {
    const fetchFn = fetchReturning(pipeline([], []));
    const store = makeDumpStore(ENV, { fetchFn });
    expect(await store.getArtist('who dis')).toBeNull();
  });

  it('returns null for an absent name even if the edges result is missing (presence checked first)', async () => {
    // Truncated response: presence (empty) + close, no edges result.
    const fetchFn = fetchReturning({
      results: [okExecute([]), { type: 'ok', response: { type: 'close' } }],
    });
    const store = makeDumpStore(ENV, { fetchFn });
    expect(await store.getArtist('who dis')).toBeNull();
  });

  it('throws on a present row with a null/non-integer artist_id (bad response, not id:0)', async () => {
    const fetchFn = fetchReturning(pipeline([[{ type: 'null' }]], []));
    const store = makeDumpStore(ENV, { fetchFn });
    await expect(store.getArtist('weird')).rejects.toThrow(/bad artist_id/);
  });

  it('returns null for an empty name without hitting the network', async () => {
    const fetchFn = fetchReturning(pipeline([], []));
    const store = makeDumpStore(ENV, { fetchFn });
    expect(await store.getArtist('')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts one batched pipeline to /v2/pipeline with the bearer token', async () => {
    const fetchFn = fetchReturning(pipeline([[intCell(1)]], []));
    const store = makeDumpStore(ENV, { fetchFn });
    await store.getArtist('foo');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://db-org.aws-eu-west-1.turso.io/v2/pipeline'); // trailing slash collapsed
    expect(init.headers.Authorization).toBe('Bearer ro-token');
    const sent = JSON.parse(init.body);
    expect(sent.requests).toHaveLength(3); // two executes + close
    expect(sent.requests[0].stmt.args).toEqual([{ type: 'text', value: 'foo' }]);
    expect(sent.requests[1].stmt.args).toEqual([{ type: 'text', value: 'foo' }]);
    expect(sent.requests[2].type).toBe('close');
  });

  it('throws on an HTTP error so the caller falls through to the wire', async () => {
    const fetchFn = fetchReturning({}, { ok: false, status: 500 });
    const store = makeDumpStore(ENV, { fetchFn });
    await expect(store.getArtist('foo')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a SQL/stream error result', async () => {
    const fetchFn = fetchReturning({
      results: [{ type: 'error', error: { message: 'no such table' } }],
    });
    const store = makeDumpStore(ENV, { fetchFn });
    await expect(store.getArtist('foo')).rejects.toThrow(/no such table/);
  });

  it('forwards the abort signal to fetch', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      return { ok: true, status: 200, json: async () => pipeline([[intCell(1)]], []) };
    });
    const store = makeDumpStore(ENV, { fetchFn });
    await store.getArtist('foo', { signal: controller.signal });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
