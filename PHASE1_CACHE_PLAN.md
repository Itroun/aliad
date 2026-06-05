# Phase 1: Persistent provider-result cache

The goal: turn the in-run dedupe `Map` in `lookup.js` into a persistent, cross-session cache so we stop re-fetching artists we already know. No new UI surface, no graph model, no eviction policy beyond TTL. Strictly the smallest change that gives us "second run is fast."

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the broader context; this doc is the concrete plan for phase 1 only.

## Scope

**In:**

- Persist `provider.lookup(name)` results across page reloads.
- Wrap the existing `cachedLookup` in `src/core/lookup.js` so cache hits skip the rate-limit queue entirely.
- Keep the in-run `Map` as a synchronous write-through buffer so two artists in one run that hit the same node still dedupe with zero IDB round-trips.
- TTL-based expiry.
- Dev-probe surfacing of cache hit/miss/stale counts.
- Schema-version field so a result-shape change invalidates the cache without manual wipes.

**Out (deferred to later phases or follow-ups):**

- Graph / quad store (phase 2).
- User-facing cache UI: refresh buttons, "fetched N days ago" labels, manual invalidation.
- Eviction beyond TTL (LRU, quota-aware).
- Background refresh of soon-to-expire entries.
- Sharing cache across users / sync.

## Storage choice: IndexedDB

- localStorage's ~5 MB synchronous-API quota doesn't fit lineups that produce hundreds of cached entries plus their identity-closure walks.
- IndexedDB gives us async access, room to grow into the quad store in phase 2, and a keyed object-store that maps directly onto our access pattern.
- One database, one object store, keyed by `${provider}::${normalisedName}`.
- A thin wrapper module (`src/core/cache.js`) keeps the rest of the codebase ignorant of IDB specifics.

## Entry shape

```
key:   `${provider}::${normaliseName(name)}`
value: {
  schemaVersion: 1,
  provider,                    // "musicbrainz" | "discogs" | …
  nameKey,                     // normaliseName(name) — denormalised for debugging
  fetchedAt,                   // epoch ms
  isEmpty,                     // result has no aliases/groups/members/relatedProjects
  result: {
    aliases: [...],
    groups: [...],
    members: [...],
    relatedProjects: [...]
  }
}
```

- `isEmpty` is computed at write time so the read path doesn't have to inspect the shape to pick a TTL.
- We do **not** cache errors — failed lookups fall through to the live provider every time, with stale-on-error fallback as below.

## TTL policy

- **Non-empty results: 30 days.** Aliases, members, group memberships rarely change; 30 days captures almost all real updates while making most lookups local reads.
- **Empty results: 7 days.** Hedge against the artist getting added to MB/Discogs later. Re-fetch sooner so we notice.
- **Stale-on-error.** If a refresh fetch fails (network, 5xx, timeout), fall back to the stale cached value if one exists, rather than the empty result. This protects against transient outages turning a session into a dead-screen.
- TTLs are constants in `src/core/cache.js`; not configurable in UI for phase 1.

## Where the cache plugs in

Today, in `lookup.js:36-50`:

```js
const cache = new Map(); // per-run dedupe
const cachedLookup = (name, opts) => {
  const key = normaliseName(name);
  if (cache.has(key)) return { promise: cache.get(key), cached: true };
  const promise = queue.run(() => provider.lookup(name, opts));
  cache.set(key, promise);
  return { promise, cached: false };
};
```

After phase 1:

```js
const inRun = new Map(); // per-run dedupe (sync)
const cachedLookup = (name, opts) => {
  const key = normaliseName(name);
  if (inRun.has(key)) return inRun.get(key); // {promise, cached, fromPersistent}

  const entry = persistentCache.lookup(provider.name, key, opts.signal);
  inRun.set(key, entry);
  return entry;
};
```

`persistentCache.lookup` returns `Promise<{ result, cached, fromPersistent, stale }>`:

- **IDB hit, fresh:** resolve immediately with `{ result, cached: true, fromPersistent: true, stale: false }`. **Skip the queue.**
- **IDB hit, stale:** kick off a queued refresh; on success, write back and resolve with the new result; on failure, resolve with the stale value flagged `{ cached: true, fromPersistent: true, stale: true }`.
- **IDB miss:** queue a fresh fetch, write the result on success, resolve with `{ result, cached: false, fromPersistent: false }`.

The queue is only ever touched on miss or refresh — cache hits cost nothing rate-limit-wise.

### Interface change to existing call-sites

The current `cachedLookup` returns `{ promise, cached }` synchronously, and `runOnePipeline` awaits the promise. After phase 1 the shape collapses to a single `Promise<{ result, cached, ... }>`:

- `runOnePipeline` (`lookup.js:90-104`) — change `const { promise, cached } = cachedLookup(...)` plus `await promise` into one `await cachedLookup(...)`.
- `expandIdentityGraph` (`lookup.js:142-164`) — same pattern.
- Error-handling collapses too: the persistent layer never throws for a cache miss; it only throws if the underlying provider fetch fails _and_ there's no stale fallback. The `try/catch` in the call-sites stays, just with a flatter shape.

## Module layout

```
src/core/
├── cache.js          new — IDB wrapper, TTL policy, stale-on-error
├── lookup.js         modified — cachedLookup now delegates to cache.js
└── …
```

`cache.js` public surface (rough):

```js
export function createCache({ db = 'aka-cache', store = 'lookups' } = {});

cache.lookup(providerName, nameKey, { signal, fetch }) → Promise<{
  result, cached, fromPersistent, stale
}>

cache.stats() → { hits, misses, stale, writes }  // for dev probe
cache.clear()                                    // future use; safe to expose
```

The cache takes the bound provider lookup as the `fetch` argument (so the same module stays test-injectable). `lookup.js` constructs that closure once per provider:

```js
const fetchWithQueue = (name, opts) => queue.run(() => provider.lookup(name, opts));
```

## Schema versioning

- Top-level `schemaVersion: 1` on every entry.
- On read, if `schemaVersion` doesn't match the current build's constant, treat as a miss.
- No data migration code — we just re-fetch. Lazy invalidation is good enough at this scale.
- Bump the constant whenever the provider result shape changes.

## In-run buffer

Keep the `Map` in `lookup.js`. It serves two purposes after phase 1:

1. Sync access (zero IDB round-trips) for repeat names within a single run.
2. Promise dedupe — if two artists trigger the same lookup concurrently, only one IDB read fires.

The buffer stores the promise returned by `cache.lookup`, not the resolved result. Cleared per-run; never persisted.

## Dev-probe surfacing

The `dev-probe` infobox (`src/ui/devProbe.js`) is already present in `build:dev` and absent in production. Extend it with a cache-stats line so we can see the cache working without opening DevTools.

Plan:

- Add a `cache(stats)` method to the dev probe that renders a single `<li class="dev-probe-item state-info">` and updates it in place.
- `cache.stats()` returns `{ hits, misses, stale, writes }` running totals per session.
- `main.js` ticks `devProbe.cache(cache.stats())` on every `onProviderResult` callback.
- Rendered as e.g. `cache · hits=42 · misses=7 · stale=1 · writes=8`.

No production UI change. Phase 1 cache hits are invisible to end users; surfacing them properly is a follow-up once we know what's worth showing.

## Tests

- **`tests/cache.test.js`** — unit tests for the cache module, using [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb) so tests run in Vitest without a browser.
  - Miss → fetch → write → second read returns cached.
  - Fresh hit skips fetch entirely.
  - Stale hit triggers refresh; on success returns fresh; on failure returns stale.
  - Schema-version mismatch → treated as miss.
  - Empty-result TTL is 7 days, non-empty is 30.
  - Negative result not cached as error; fetch failures don't poison the cache.
- **`tests/lookup.test.js`** — extend existing orchestrator tests with a fake cache (injected) to verify:
  - `cached: true` flag propagates through `onProviderResult` for IDB hits.
  - Rate-limit queue is not invoked on cache hits.
  - In-run buffer still dedupes concurrent calls for the same name.
- No new tests for the dev probe — visual only.

## Open decisions / call-outs

- **Quota handling.** IDB quotas are large (typically GBs) but not infinite. Phase 1 ignores quota errors and lets them surface as cache-write failures (logged, non-fatal — the result is still returned to the caller). If we ever see this in practice, add LRU eviction in a follow-up.
- **Tab-concurrent writes.** Two tabs running the same lineup will both write the same entry; last-write-wins is fine — the data is the same.
- **`signal` semantics.** If the caller aborts mid-refresh, we should not write a partial result. The cache passes `signal` through to the underlying `fetch` and treats `AbortError` as "don't write." Stale fallback still returns the prior value if present.
- **Dev-only stats vs. always-on counters.** `cache.stats()` runs in production too — cheap — but is only rendered by the dev probe. Production gets the counters without the UI.

## Step-by-step build order

1. Add `fake-indexeddb` as a dev dependency; verify Vitest loads it.
2. Implement `src/core/cache.js` with the entry shape, TTLs, and `lookup` / `stats` / `clear` surface. Tests-first.
3. Wire `cache.js` into `lookup.js`. Collapse the call-site shape. Run existing tests; fix expectations around the now-async `cachedLookup` return.
4. Extend orchestrator tests to cover hit/miss/stale paths through the real cache module against `fake-indexeddb`.
5. Extend the dev probe with `cache(stats)` and tick it from `main.js`.
6. Manual verification: `npm run build:dev && npx wrangler pages dev dist`, run a lineup twice, confirm the second run finishes near-instantly and dev-probe shows hits.

Each step is a clean commit. If something feels load-bearing for phase 2 (graph model), resist adding it here — phase 1 wants to be boring and reversible.
