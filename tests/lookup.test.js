import { describe, it, expect, afterEach, vi } from 'vitest';
import { lookupAll, splitCollab } from '../src/core/lookup.js';

// Phase 3b: lookupAll is now a thin SSE client over /api/closure — the walk
// itself runs server-side and is tested in tests/closure.test.js +
// tests/closure-endpoint.test.js. Here we stub fetch with a fake SSE stream and
// assert lookupAll translates events back into callbacks, merges collab parts,
// and dedupes/trims its input.

const empty = { aliases: [], groups: [], members: [], relatedProjects: [] };

// Build a fetch-like Response carrying the given SSE events as a byte stream.
function sse(events) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const [event, data] of events) {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

// Install a fetch stub that routes by the ?root= param to a per-name event list.
// `eventsByRoot` maps a root name to its SSE events (or a function returning them).
function stubFetch(eventsByRoot) {
  const calls = [];
  const fn = vi.fn(async (url) => {
    const parsed = new URL(url, 'http://localhost');
    const root = parsed.searchParams.get('root');
    calls.push({ url, root, roots: parsed.searchParams.getAll('roots') });
    const events = eventsByRoot[root];
    if (!events) return sse([['done', { merged: empty, closure: [], queried: [], errored: [] }]]);
    return sse(typeof events === 'function' ? events() : events);
  });
  globalThis.fetch = fn;
  return { fn, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('lookupAll', () => {
  it('trims, dedupes and opens one stream per unique name', async () => {
    const { calls } = stubFetch({});
    await lookupAll(['  Foo  ', 'foo', '', 'Bar', 'BAR']);
    expect(calls.map((c) => c.root)).toEqual(['Foo', 'Bar']);
  });

  it('passes the full deduped lineup as roots params', async () => {
    const { calls } = stubFetch({});
    await lookupAll(['Foo', 'Bar']);
    expect(calls[0].roots).toEqual(['Foo', 'Bar']);
  });

  it('routes provider/progress/done events into the matching callbacks', async () => {
    const merged = { ...empty, groups: [{ name: 'A Band' }] };
    stubFetch({
      Foo: [
        [
          'provider',
          { provider: 'musicbrainz', ok: true, result: { ...empty }, serverCache: 'MISS' },
        ],
        ['provider', { provider: 'discogs', ok: true, result: { ...empty }, serverCache: 'HIT' }],
        ['progress', { merged }],
        ['done', { merged, closure: ['foo'], queried: ['musicbrainz', 'discogs'], errored: [] }],
      ],
    });

    const providerCalls = [];
    const doneCalls = [];
    let complete = null;
    const [result] = await lookupAll(['Foo'], [], {
      onProviderResult: (artist, provider, outcome) =>
        providerCalls.push({ artist, provider, serverCache: outcome.serverCache, ok: outcome.ok }),
      onArtistDone: (artist, m) => doneCalls.push({ artist, groups: m.groups.length }),
      onArtistComplete: (artist, m, summary) => {
        complete = { artist, summary };
      },
    });

    expect(providerCalls).toEqual([
      { artist: 'Foo', provider: 'musicbrainz', serverCache: 'MISS', ok: true },
      { artist: 'Foo', provider: 'discogs', serverCache: 'HIT', ok: true },
    ]);
    expect(doneCalls).toEqual([{ artist: 'Foo', groups: 1 }]);
    expect(complete.summary.queried).toEqual(['musicbrainz', 'discogs']);
    expect(complete.summary.closure).toBeInstanceOf(Set);
    expect(complete.summary.closure.has('foo')).toBe(true);
    expect(result.merged.groups).toHaveLength(1);
  });

  it('fires onBudgetExhausted from a budget event', async () => {
    stubFetch({
      Root: [
        ['budget', { skipped: 7 }],
        ['done', { merged: empty, closure: [], queried: [], errored: [] }],
      ],
    });
    const budget = [];
    await lookupAll(['Root'], [], {
      onBudgetExhausted: (artist, info) => budget.push({ artist, skipped: info.skipped }),
    });
    expect(budget).toEqual([{ artist: 'Root', skipped: 7 }]);
  });

  it('reports provider errors via onProviderResult without failing the artist', async () => {
    stubFetch({
      Foo: [
        ['provider', { provider: 'musicbrainz', ok: false }],
        ['provider', { provider: 'discogs', ok: true, result: { ...empty } }],
        ['done', { merged: empty, closure: [], queried: ['discogs'], errored: ['musicbrainz'] }],
      ],
    });
    const outcomes = [];
    const [result] = await lookupAll(['Foo'], [], {
      onProviderResult: (_a, provider, o) => outcomes.push({ provider, ok: o.ok }),
    });
    expect(outcomes).toContainEqual({ provider: 'musicbrainz', ok: false });
    expect(result.name).toBe('Foo');
  });

  it('splits "X vs Y" collab acts and merges constituents into the combo entry', async () => {
    const filteria = { ...empty, groups: [{ name: 'Suntrip' }] };
    stubFetch({
      'Skizologic vs Filteria': [
        ['done', { merged: empty, closure: ['skizologic vs filteria'], queried: [], errored: [] }],
      ],
      Skizologic: [['done', { merged: empty, closure: ['skizologic'], queried: [], errored: [] }]],
      Filteria: [['done', { merged: filteria, closure: ['filteria'], queried: [], errored: [] }]],
      Ultravibe: [['done', { merged: empty, closure: ['ultravibe'], queried: [], errored: [] }]],
    });

    const [combo] = await lookupAll(['Skizologic vs Filteria', 'Ultravibe'], []);
    expect(combo.parts).toEqual(['Skizologic', 'Filteria']);
    // The combo absorbs the constituents' data and closures.
    expect(combo.merged.groups.map((g) => g.name)).toContain('Suntrip');
    expect(combo.closure.has('filteria')).toBe(true);
    expect(combo.closure.has('skizologic')).toBe(true);
    // sources attributes each relation back to its hosting sub-name.
    expect(combo.sources.map((s) => s.name)).toEqual([
      'Skizologic vs Filteria',
      'Skizologic',
      'Filteria',
    ]);
  });

  it('rejects when the stream emits an error event', async () => {
    stubFetch({ Foo: [['error', { message: 'Graph substrate unavailable' }]] });
    await expect(lookupAll(['Foo'], [])).rejects.toThrow('Graph substrate unavailable');
  });

  it('rejects when the stream ends without a done event', async () => {
    stubFetch({ Foo: [['progress', { merged: empty }]] });
    await expect(lookupAll(['Foo'], [])).rejects.toThrow('without a result');
  });
});

describe('splitCollab', () => {
  it('splits on " vs " (case-insensitive, optional period)', () => {
    expect(splitCollab('Skizologic vs Filteria')).toEqual(['Skizologic', 'Filteria']);
    expect(splitCollab('The Infinity Project VS Excess Head')).toEqual([
      'The Infinity Project',
      'Excess Head',
    ]);
    expect(splitCollab('A vs. B')).toEqual(['A', 'B']);
  });

  it('splits on " b2b " and " & "', () => {
    expect(splitCollab('Astrix b2b Vini Vici')).toEqual(['Astrix', 'Vini Vici']);
    expect(splitCollab('Antidot & DICA')).toEqual(['Antidot', 'DICA']);
  });

  it('keeps "&" intact when "vs" also present (vs takes priority)', () => {
    expect(splitCollab('Drop & Dash vs Germinator')).toEqual(['Drop & Dash', 'Germinator']);
  });

  it('returns null for non-collab names', () => {
    expect(splitCollab('Infected Mushroom')).toBe(null);
    expect(splitCollab('')).toBe(null);
    expect(splitCollab(null)).toBe(null);
  });
});
