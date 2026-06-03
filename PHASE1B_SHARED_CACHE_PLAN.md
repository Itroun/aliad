# Phase 1b: Server-side shared cache (HTTP-level)

The goal: stop every visitor from re-fetching artists that *another* visitor has
already fetched. Phase 1 gave each browser its own IndexedDB cache (L1, private,
per-origin). Phase 1b adds a **shared L2 cache in front of the upstream APIs**, so
the first person to look up an artist warms the cache for everyone.

This is deliberately the smallest change that delivers "shared across visitors."
It caches **raw upstream JSON at the proxy boundary**, keyed by upstream URL. The
browser keeps doing all result-mapping exactly as it does today. Collapsing L1/L2
into a single `(provider, normalisedName)` key space is a later step — see
[PHASE2B_MAPPED_CACHE_PLAN.md](./PHASE2B_MAPPED_CACHE_PLAN.md).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the broader context;
[PHASE1_CACHE_PLAN.md](./PHASE1_CACHE_PLAN.md) for the browser cache this sits behind.

## Why HTTP-level, and why now

- **Lowest risk.** The cache lives entirely inside the Pages Functions. The
  server controls what gets stored (it's whatever upstream returned), so there is
  no client-trust / cache-poisoning surface.
- **No browser refactor.** Provider modules keep returning
  `{ aliases, groups, members, relatedProjects }`. The only browser change is
  pointing MusicBrainz at a proxy URL.
- **Covers the expensive provider.** The dominant wall-clock cost is MusicBrainz
  (1.2 s min interval, 1 req/sec). MB is currently called *direct from the
  browser* (`src/providers/musicbrainz.js`), so it cannot be server-cached until
  it is proxied. Proxying MB is the keystone of this phase — and it also lets us
  set a proper `User-Agent` server-side, which MB wants and which the browser
  forbids (see the rate-limits note in `CLAUDE.md`).

## Storage choice: KV (already bound)

- `wrangler.toml` already binds a `KV` namespace, already used by
  `functions/_lib/kvLimit.js` for rate-limiting and the Anthropic daily ceiling.
  We reuse it; no new binding.
- Cache values are small JSON blobs; KV's 25 MB value / 512 B key limits are not a
  concern. KV's eventual consistency (writes propagate within ~60 s globally) is
  fine for a cache.
- **Write budget is the constraint to watch.** Free tier is ~1,000 KV writes/day.
  A first all-miss run of a large lineup is ~one write per upstream request. The
  whole point of the cache is that writes collapse once popular artists are warm,
  so steady state is read-heavy — but a cold launch can exceed the free budget.
  Mitigations, in order: (1) accept it for now, (2) upgrade to the paid Workers
  plan (1M writes/day), (3) migrate to D1 (deferred — see Phase 2b call-out).

## What gets cached, and the key

One KV entry per **upstream request URL** (not per artist — MB does a search call
*and* a details call per artist; each is cached separately).

```
key:   `httpcache:${version}:${provider}:${sha256(upstreamUrl)}`
value: {
  v: <cacheVersion>,        // bump to invalidate all entries (server analog of schemaVersion)
  status: <upstream status>,
  body: <upstream response text>,
  fetchedAt: <epoch ms>,
}
```

- Key uses a hash of the full upstream URL (query params included, in canonical
  order) so different searches/details don't collide and keys stay under 512 B.
- `version` is a constant in `edgeCache.js`. Bumping it orphans every old entry
  (they TTL out); no migration code, matching Phase 1's lazy invalidation.
- We do **not** cache 5xx/network failures. We *do* cache successful empties (so a
  not-found artist isn't re-fetched constantly) under a shorter TTL.

## TTL policy (mirrors Phase 1)

- **Non-empty 2xx: 30 days.** Aliases/members/groups are high-stability.
- **Empty 2xx: 7 days.** Re-check sooner in case the artist gets added upstream.
  "Empty" at the HTTP layer is detected by parsing the JSON and checking for the
  provider's no-result shape (MB: empty `artists`/no relations; Discogs: empty
  `results`). Detection lives next to each proxy; `edgeCache` just takes the
  chosen `ttl`.
- **Stale-on-error.** If an upstream refresh fails (5xx, network, timeout) and a
  prior entry exists, serve the stale body rather than an error. Set
  `X-Cache: STALE`.
- TTLs are constants in `functions/_lib/edgeCache.js`; not configurable in UI.

## Where it plugs in

A shared helper wraps the upstream `fetch` inside each proxy Function:

```
functions/_lib/edgeCache.js   new — KV get/put, TTL, stale-on-error, X-Cache header
```

Rough surface:

```js
// upstreamFn: () => Promise<Response>
// ttlFor:     (parsedBody) => seconds   (lets the proxy pick empty vs non-empty TTL)
export async function cachedFetch(env, { provider, upstreamUrl, upstreamFn, ttlFor });
// → { response, cache: 'HIT' | 'MISS' | 'STALE' }   (response is a fresh Response to return)
```

- **Hit, fresh:** return stored `{status, body}` as a `Response`, `X-Cache: HIT`.
  No upstream call.
- **Miss / expired:** `await upstreamFn()`; on 2xx, store with `ttlFor(body)`;
  return `X-Cache: MISS`.
- **Upstream error with prior entry:** return stale, `X-Cache: STALE`, don't write.
- If `env.KV` is absent (degraded), behave as pure pass-through — same defensive
  posture as `kvLimit.js`.

### Proxy changes

1. **`functions/api/musicbrainz/[[path]].js` (new).** Mirrors the Discogs proxy:
   - Method/`GET`-only, path allow-list (`artist`), reject everything else.
   - Per-IP rate-limit via the existing `checkRateLimit` (MB = 1/sec).
   - Sets `User-Agent: aka/0.1 (+https://alsoknownas.music)` and `Accept: json`.
   - Wraps the upstream fetch in `cachedFetch`.
2. **`functions/api/discogs/[[path]].js` (modify).** Wrap its existing upstream
   fetch in `cachedFetch`. ~5 lines; everything else (token injection, path
   allow-list, rate-limit, `Retry-After` passthrough) stays.

### Browser change (one line of substance)

- **`src/providers/musicbrainz.js`** — change `BASE` from
  `https://musicbrainz.org/ws/2` to `/api/musicbrainz/ws/2`. `fetchFn` injection
  is untouched, so provider unit tests don't change behaviour (only update any
  fixture/expectation that asserts on the absolute URL string).
- Discogs already goes through `/api/discogs/...`; no browser change.

### Client rate-limit queues

Keep them. With MB proxied, the client queue now mostly paces calls to our own
origin while the Function enforces the real upstream limit per-IP. We can relax
the client `minIntervalMs` for cache-friendly behaviour in a follow-up, but it's
out of scope here — don't touch timing in this phase.

## Dev-probe surfacing

Extend the dev-probe so server-cache outcomes are visible next to the existing
IndexedDB line:

- Proxies already set `X-Cache: HIT|MISS|STALE`. Thread that header back through
  `fetchJson`/`callProxy` and into the `onProviderResult` callback as
  `serverCache: 'HIT'|...`.
- Render a rolling tally, e.g. `server-cache · HIT=42 · MISS=7 · STALE=1`.
- `build:dev` only; no production UI. This is how we'll *prove* the shared cache
  works (run in two different browsers; the second should see server HITs).

## Local dev impact (update CLAUDE.md)

Moving MB behind the proxy means **MB no longer works under plain `npm run dev`**
(Vite alone doesn't run Functions). `npm run build:dev && npx wrangler pages dev
dist` becomes required for *all* lookups, not just Discogs. Update the Commands
section of `CLAUDE.md` accordingly.

## Tests

- **`tests/edgeCache.test.js` (new).** Map-backed fake KV (same spirit as
  `fake-indexeddb`):
  - Miss → upstream called → stored → second call is a HIT, upstream not called.
  - Fresh hit skips upstream entirely.
  - Expired entry → refetch → restore.
  - Upstream error with prior entry → STALE returned, no write.
  - Empty-result TTL shorter than non-empty.
  - `version` bump → old entry ignored (treated as miss).
  - Degraded (no `env.KV`) → pure pass-through, never throws.
- **Provider tests** — unchanged in behaviour; update only URL-string
  expectations for the new MB base path.
- No new tests for the dev-probe (visual only).

## Open decisions / call-outs

- **Write budget.** Flagged above. Decision for launch: start on KV free tier,
  watch the `MISS`/write rate via the dev-probe and CF dashboard, upgrade the plan
  if a cold lineup routinely blows 1k/day. D1 migration is Phase 2b, not now.
- **Stampede.** KV has no locking; N users hitting the same cold artist all fetch
  upstream and last-write-wins. Same data, harmless — accepted, not mitigated.
- **Privacy.** Keys are public artist names / upstream URLs; no PII. The server
  already proxies Discogs + extract, so this adds no new exposure axis.
- **Deploy prerequisite.** `wrangler.toml`'s KV `id` is still the placeholder.
  Before this does anything in production, run
  `npx wrangler kv namespace create aka-kv` and swap the real id in (already
  required by the existing rate-limiter).
- **Combining with L1.** L1 (IndexedDB, mapped) and L2 (KV, raw HTTP) are
  independent tiers with different granularity. That's fine for Phase 1b — a
  browser L1 hit skips the network entirely; an L1 miss hits L2 at the proxy. They
  unify in Phase 2b.

## Step-by-step build order

1. Implement `functions/_lib/edgeCache.js` with the entry shape, TTL/empty TTL,
   stale-on-error, `version`, and degraded pass-through. Tests-first against a
   fake KV.
2. Add `functions/api/musicbrainz/[[path]].js` (proxy + UA + rate-limit), wired
   through `edgeCache`. Don't change the browser yet — verify the proxy with curl.
3. Point `src/providers/musicbrainz.js` `BASE` at `/api/musicbrainz/ws/2`. Run
   provider tests; fix URL expectations.
4. Wrap the Discogs proxy upstream fetch in `edgeCache`.
5. Thread `X-Cache` through to the dev-probe; add the `server-cache` tally line.
6. Update `CLAUDE.md` (dev workflow) and this repo's docs.
7. Manual verification: `build:dev && wrangler`, run a lineup in browser A, then
   the same lineup in a fresh browser/profile B — B should show `server-cache
   HIT`s and finish fast despite an empty IndexedDB.

Each step is a clean commit. Resist pulling Phase 2b (mapped-result unification,
mapper-sharing, D1) into this phase — 1b wants to stay boring and reversible.
