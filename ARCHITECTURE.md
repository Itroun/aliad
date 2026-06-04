# Architecture: what we have, and where it should grow

This is a snapshot of the current architecture, what's working well and worth preserving, and the two specific places where the design wants to grow: **a persistent cache** and **a graph data model**. It is not a plan — it's the shared mental model the plan should be built on.

## What we have today

```
src/
├── providers/         lookup(name) → { aliases, groups, members, relatedProjects }
│   ├── musicbrainz.js
│   ├── discogs.js
│   └── provider.js    emptyResult() shape
├── core/
│   ├── lookup.js      orchestrator: per-provider queues, collab split, BFS expansion
│   ├── merge.js       name normalisation + bucket-wise dedupe with source attribution
│   ├── rateLimit.js   createQueue({ minIntervalMs })
│   ├── fetchJson.js
│   ├── fetchWithRetry.js
│   ├── extract.js     Anthropic-backed lineup extraction
│   ├── cleanHTML.js
│   ├── graph.js       merged-result → graph view-model
│   └── models.js
├── ui/                plain DOM, no framework
│   ├── inputScreen.js
│   ├── results.js
│   ├── graph/         graph view
│   ├── graphScreen.js
│   ├── emptyGraphScreen.js
│   ├── viewTabs.js
│   └── devProbe.js
├── main.js            wires everything together
└── style.css

functions/api/
├── discogs/[[path]].js   Pages Function: injects token, restricts paths
└── extract/…             Anthropic proxy for lineup extraction
```

## What works well together

These are the load-bearing pieces. They compose cleanly and shouldn't be disturbed by either of the proposed additions.

### 1. The provider contract

Each provider exports exactly:

```js
{
  name,
  minIntervalMs,
  lookup(name, { signal, fetchFn? }) → Promise<{ aliases, groups, members, relatedProjects }>
}
```

Why it works:

- **Uniform shape.** The orchestrator never branches on provider identity; it just collects results and hands them to `mergeResults`.
- **`fetchFn` injection.** Tests inject fakes without monkey-patching globals. Real captures live under `tests/fixtures/`.
- **Adding a source is local.** A Wikidata or ListenBrainz provider is a new file, a one-line registration, and nothing else changes.
- **The natural cache seam.** Wrapping `lookup` with a cache layer is the cleanest interception point in the whole codebase.

### 2. Merge layer (`src/core/merge.js`)

Tiny and pure:

- `normaliseName` — lowercase, NFKD-strip diacritics, collapse non-letter/digit runs. This is the canonical key used everywhere.
- `mergeResults` — bucket-wise dedupe by normalised name, preserving `sourceUrl`s as an aggregated `sources: []` per entry.
- `dedupeNames` — input-side dedupe for lineup rows.

It's associative enough that cached results and live results can be folded together with no special-casing.

### 3. Per-provider rate-limit queues + per-run dedupe cache

In `lookup.js`:

```js
const queue = createQueue({ minIntervalMs: provider.minIntervalMs });
const cache = new Map();
const cachedLookup = (name, opts) => {
  const key = normaliseName(name);
  if (cache.has(key)) return { promise: cache.get(key), cached: true };
  const promise = queue.run(() => provider.lookup(name, opts));
  cache.set(key, promise);
  return { promise, cached: false };
};
```

- Queues are **per-provider, shared across all artists in one run** — MB and Discogs respect their own limits without blocking each other.
- The `Map` is a **session-scoped lookup cache.** Two artists in the same lineup that reach the same node (alias, member) only hit the network once.
- The `cached` flag is already plumbed through `onProviderResult`, so the UI can distinguish fresh vs. cached at the callback layer.

**This is the shape a persistent cache should slot into** — same interface, wider scope.

### 4. The expansion walker (`expandIdentityGraph`)

BFS over the alias / member graph, with rules learned the hard way:

- **Budget cap** (`MAX_EXPANSION_LOOKUPS = 25`) — bounds worst-case fan-out.
- **Alias fan-out cap** (`ALIAS_FANOUT_CAP = 15`) — prolific artists register names in the closure for clustering but don't burn budget walking each pseudonym.
- **`visited` set** — cycle protection, keyed on normalised names.
- **Don't walk members of an alias-reached node** — otherwise collaborators leak in as apparent aliases of the root. Encoded as `parentKind !== 'alias'`.
- **Alias-with-members is a group, not an identity** — `looksLikeGroup` check rejects the alias attribution and strips it from `accumulated.aliases` so downstream graph-building doesn't bridge the root through a duo-project to the other member's bands.
- **Skip walking into another lineup root** — register in `visited` so the cluster-union step still merges the two roots, but don't re-fetch.
- **`via` / `viaChain` / `viaHadMemberStep`** attribution threaded through every accumulated entry — the graph view uses this to render "aka Filteria" rather than "aka X vs Filteria".

**These rules are the crown jewels.** A ground-up rewrite would re-learn them slowly. Whatever data model replaces the recursive loop, the rules need to survive.

### 5. Collab splitting

`splitCollab(name)` handles `X vs Y`, `X b2b Y`, `X & Y`. The orchestrator runs the full pipeline for the combo _and_ each part, then merges them with attribution preserved in `sources`. Providers stay dumb about festival naming conventions.

### 6. Progressive callbacks

`onProviderResult` / `onArtistDone` / `onArtistComplete` / `onBudgetExhausted` — the UI updates as data arrives instead of waiting for the slowest provider. A cache layer must preserve this: cached hits fire the same callbacks with `cached: true`.

### 7. Discogs proxy (`functions/api/discogs/[[path]].js`)

Pages Function injects the token server-side and restricts paths to `database/` and `artists/`. Token never reaches the browser. Any future authenticated provider should follow this pattern.

### 8. UI shell

Plain DOM, no framework, one `style.css`. `ui/graph/` is already separate from `ui/results.js`, so changes underneath `lookup.js` are invisible to the views. The interface is the part you want to keep — the architecture already supports that.

---

## Where caching should be added

> **Note (post-phase-1).** The section below describes the _browser_ cache (L1),
> which Phase 1 shipped. It is per-browser and per-origin — it does **not** share
> fetches between visitors. A shared server-side tier (L2) is added in Phase 1b
> and consolidated in Phase 2b; see the Phasing list at the end of this doc and
> the linked plan files. Read this section as "L1 design," not the whole story.

**The problem.** The session-scoped `Map` in `lookup.js` is thrown away on reload. Every run re-fetches every artist, every alias, every member, even when the underlying data hasn't changed in months. MB and Discogs rate limits then dominate wall-clock time.

**The principle.** Aliases, members, and group memberships are _high-stability_ data. An artist's MusicBrainz aliases don't change between lunchtime and dinner. A 30-day TTL would capture almost all real updates while turning most lookups into local-storage reads.

### The cache seam: wrap `provider.lookup`

The cleanest place to add caching is **between the queue and the provider**, not above the queue:

```
queue.run( cache.get_or_fetch( () => provider.lookup(name) ) )
```

- Cache hits skip the queue entirely (no rate-limit cost).
- Cache misses go through the queue as today.
- `cachedLookup` in `lookup.js` collapses to delegating to the persistent layer, and the in-run `Map` becomes a small write-through buffer to dedupe within a single run.

### What to cache

Keyed by `(provider.name, normaliseName(name))`:

- The raw provider result: `{ aliases, groups, members, relatedProjects }`.
- A timestamp (`fetchedAt`).
- The schema version (so a result-shape change can invalidate the cache without a manual wipe).

Not keyed by raw input casing — `normaliseName` is already the canonical key everywhere else.

### Storage

**IndexedDB**, not localStorage:

- Lineups can produce hundreds of cached entries; localStorage's ~5 MB quota and synchronous API don't fit.
- IndexedDB gives us a simple keyed store, async access, and room to grow into the graph model later (which will want indexed queries).
- A thin wrapper (`src/core/cache.js`) keeps the rest of the codebase ignorant of IndexedDB specifics.

### TTL policy

- Default 30 days for `{ aliases, groups, members, relatedProjects }`.
- Stale-on-error: if a refresh fetch fails, fall back to the stale cached value rather than the empty result.
- Manual "refresh this artist" affordance later (out of scope for v1 of the cache).

### Callback semantics

`onProviderResult` already accepts `{ cached: boolean }`. The persistent cache should set this `true` for any hit not served from the in-run buffer. The UI can choose whether to surface this (subtle indicator, "fetched 12 days ago", etc.) — the data is already plumbed.

### What does _not_ change

- Provider modules (they still just return `{ aliases, groups, members, relatedProjects }`).
- `mergeResults` (cached + live results merge identically).
- Rate-limit queues (still needed for misses).
- The expansion walker (still BFS, still budget-capped — though see next section).
- The UI shell.

---

## Where the graph model should be added

**The problem.** The current pipeline rebuilds the same graph from scratch every time. Even with a result cache, the _traversal_ still runs as a recursive walk with a hop budget. The budget exists because each hop was a network round-trip; once hops are local, the budget concept is the wrong shape.

**The deeper problem.** `closure: Set<normalisedName>` is an ad-hoc graph. `via` / `viaChain` / `viaHadMemberStep` is an ad-hoc edge-attribute system. The hard rules in `enqueueFromNode` (don't walk members of an alias-reached node, alias-with-members is a group, etc.) are graph-shape rules expressed as imperative control flow. The data model wants to be a graph; right now it's pretending to be a tree of merged result blobs.

### The shape

A small, local triple/quad store keyed on normalised names, with edges typed:

```
(subject, predicate, object, provenance)

aka(person, person)         — identity-equivalent
member_of(person, group)
related_project(person, project)
```

Quads (with `provenance` carrying provider + sourceUrl + fetchedAt) preserve the source-attribution that `mergeResults` builds today.

### Why a real graph helps

- **Traversal becomes a query, not a recursion.** "What's the identity closure of X?" is a transitive query over `aka` edges. The fan-out cap and budget become rendering concerns, not fetching concerns.
- **The hard-won rules become edge-typing rules.** "Don't walk members of an alias-reached node" is just "don't traverse `member_of` after traversing `aka` in this query." That's enforceable in one place instead of as scattered guards.
- **Cluster union is free.** Two lineup rows that turn out to be the same identity share nodes by construction; no special closure-merging step.
- **The cache and the graph become the same thing.** A cached MB lookup _is_ a set of edges with a `fetchedAt` timestamp. The result-blob cache and the graph store collapse into one substrate.
- **New providers add edges, not blobs.** Wikidata's `same_as` becomes another `aka` edge with different provenance.

### What to use

Probably **not** a full SPARQL engine — the overhead and bundle size aren't justified for the query shapes we actually run. More likely:

- IndexedDB-backed quad store with a small handful of indexes (`by-subject`, `by-predicate-object`).
- A tiny query layer that covers our actual needs: transitive `aka` closure, bounded `member_of` walks, "is X a lineup root?".
- Keep SPARQL/RDF terminology for predicates and serialisation (so we can export, and so the conceptual model stays clean), without taking on a query engine.

### Phasing

The graph model is **strictly downstream** of the cache. Caching itself grew a
second axis once we realised a _shared_ cache was wanted (one visitor warming the
cache for the next), which the original phase 1 — a per-browser IndexedDB cache —
does not provide. So the cache track now has sub-phases before the graph work:

1. **Phase 1 — browser cache (done).** Wrap `provider.lookup`, persist results in
   per-browser IndexedDB (L1), keep the current walker. Minimal disruption;
   immediate per-user UX win. See [PHASE1_CACHE_PLAN.md](./PHASE1_CACHE_PLAN.md).
2. **Phase 1b — server-side shared cache (HTTP-level) (done).** A shared L2 cache
   in KV at the proxy boundary (`functions/_lib/edgeCache.js`), keyed by upstream
   URL, so fetches are shared across visitors. MusicBrainz is now proxied
   (`functions/api/musicbrainz/[[path]].js`); Discogs's proxy wraps the same
   helper. Browser mapping unchanged; the dev-probe shows a `server-cache` tally.
   See [PHASE1B_SHARED_CACHE_PLAN.md](./PHASE1B_SHARED_CACHE_PLAN.md).
3. **Phase 2b — mapped-result consolidation.** Move mapping server-side and cache
   the mapped `(provider, normalisedName)` result, collapsing L1 and L2 into one
   key space and one `SCHEMA_VERSION`. This is the server-side precondition for a
   _shared_ graph store. See
   [PHASE2B_MAPPED_CACHE_PLAN.md](./PHASE2B_MAPPED_CACHE_PLAN.md).
4. **Phase 2 — graph substrate.** Replace the cache's value store with a quad
   store. Provider results decompose into quads on write. The walker still runs
   but reads from the graph instead of from blobs. With 2b done, this happens
   server-side and the graph is shared by construction; D1 (SQLite) becomes the
   likely backing once indexed quad queries are needed.
5. **Phase 3 — query-shaped traversal.** Retire the BFS loop in favour of typed
   graph queries. `closure`, `via`, `viaChain` either disappear or become query
   metadata. The expansion _rules_ survive — they just move from control flow to
   query constraints.

Each phase is shippable on its own. Each preserves the provider contract, the UI
shell, the rate-limit queues, and the merge primitives.

---

## What should not change (summary)

- Provider contract.
- `normaliseName` and source-attributed merging.
- Per-provider rate-limit queues (still needed for cache misses).
- Progressive callbacks.
- The expansion rules — even if the loop dissolves into a graph query.
- Collab splitting in the orchestrator.
- Discogs / extract Pages Function proxies.
- The UI.

## What is naturally rethought along the way

- The in-run `Map` cache collapses into the persistent cache.
- `closure: Set<name>` is subsumed by the graph itself.
- `via` / `viaChain` / `viaHadMemberStep` become typed edge attributes.
- The `MAX_EXPANSION_LOOKUPS` budget stops being about politeness and starts being about render scope.
- The recursive walker in `expandIdentityGraph` becomes a query against the graph store.
