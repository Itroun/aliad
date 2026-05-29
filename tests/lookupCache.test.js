import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { lookupAll } from '../src/core/lookup.js';
import { createCache } from '../src/core/cache.js';

const DAY = 24 * 60 * 60 * 1000;

let dbCounter = 0;
function freshDb() {
  return `aka-itest-${Date.now()}-${dbCounter++}`;
}

function makeProvider(name, table, { minIntervalMs } = {}) {
  const lookup = vi.fn(async (artist) => {
    return table[artist] ?? { aliases: [], groups: [], members: [], relatedProjects: [] };
  });
  return { provider: { name, lookup, minIntervalMs }, lookup };
}

describe('lookupAll with persistent cache', () => {
  it('second run of the same lineup is fully cached and skips the provider', async () => {
    const cache = createCache({ db: freshDb() });
    const { provider, lookup } = makeProvider('mb', {
      Foo: { aliases: [], groups: [], members: [], relatedProjects: [] },
    });

    await lookupAll(['Foo'], [provider], { cache });
    expect(lookup).toHaveBeenCalledTimes(1);

    const events = [];
    await lookupAll(['Foo'], [provider], {
      cache,
      onProviderResult: (artist, _p, outcome) =>
        events.push({ artist, ok: outcome.ok, cached: outcome.cached }),
    });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ artist: 'Foo', ok: true, cached: true }]);
  });

  it('cache covers expansion-walk targets, not just lineup roots', async () => {
    const cache = createCache({ db: freshDb() });
    const { provider, lookup } = makeProvider('mb', {
      Foo: { aliases: [{ name: 'Bar' }], groups: [], members: [], relatedProjects: [] },
      Bar: { aliases: [], groups: [{ name: 'Quux' }], members: [], relatedProjects: [] },
    });

    await lookupAll(['Foo'], [provider], { cache });
    // Foo + Bar (alias-walk). Quux is a group, not walked.
    expect(lookup).toHaveBeenCalledTimes(2);

    await lookupAll(['Foo'], [provider], { cache });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('in-run buffer dedupes when two roots walk into the same alias', async () => {
    const cache = createCache({ db: freshDb() });
    const { provider, lookup } = makeProvider('mb', {
      Foo: { aliases: [{ name: 'Shared' }], groups: [], members: [], relatedProjects: [] },
      Baz: { aliases: [{ name: 'Shared' }], groups: [], members: [], relatedProjects: [] },
      Shared: { aliases: [], groups: [], members: [], relatedProjects: [] },
    });

    await lookupAll(['Foo', 'Baz'], [provider], { cache });

    const sharedCalls = lookup.mock.calls.filter(([n]) => n === 'Shared').length;
    expect(sharedCalls).toBe(1);
  });

  it('expired entries trigger a refresh on the next run', async () => {
    let now = 1_700_000_000_000;
    const cache = createCache({ db: freshDb(), now: () => now });
    const { provider, lookup } = makeProvider('mb', {
      Foo: {
        aliases: [{ name: 'Bar' }],
        groups: [],
        members: [],
        relatedProjects: [],
      },
      Bar: { aliases: [], groups: [], members: [], relatedProjects: [] },
    });

    await lookupAll(['Foo'], [provider], { cache });
    expect(lookup).toHaveBeenCalledTimes(2); // Foo + Bar walk

    now += 31 * DAY;
    await lookupAll(['Foo'], [provider], { cache });
    expect(lookup).toHaveBeenCalledTimes(4); // both refreshed
  });

  it('cache hits bypass the rate-limit queue', async () => {
    const cache = createCache({ db: freshDb() });
    const { provider, lookup } = makeProvider(
      'mb',
      {
        Foo: { aliases: [], groups: [], members: [], relatedProjects: [] },
        Bar: { aliases: [], groups: [], members: [], relatedProjects: [] },
        Baz: { aliases: [], groups: [], members: [], relatedProjects: [] },
      },
      { minIntervalMs: 300 },
    );

    // Pre-warm; first run is gated by the queue (300ms between each call).
    await lookupAll(['Foo', 'Bar', 'Baz'], [provider], { cache });
    expect(lookup).toHaveBeenCalledTimes(3);

    const start = Date.now();
    await lookupAll(['Foo', 'Bar', 'Baz'], [provider], { cache });
    const elapsed = Date.now() - start;

    expect(lookup).toHaveBeenCalledTimes(3);
    // If the queue were involved, this would be 600ms+; cache-only path is well under.
    expect(elapsed).toBeLessThan(150);
  });
});
