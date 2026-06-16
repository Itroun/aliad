# Phase 3: Query-shaped traversal

> **Status: Phase 3a + 3b DONE.** The identity-graph walk now runs **server-side**
> as a query over the Phase 2 quad store. `src/core/closure.js` (`identityClosure`)
> reads a node's edges _across_ `source_key`s so MB + Discogs union into one
> cross-provider view; `functions/api/closure.js` drives cold/expired fetches
> (via `handleLookup`) and streams the walk back as SSE; `src/core/lookup.js`'s
> `lookupAll` is now a thin SSE client and the browser BFS is deleted. Decisions
> taken: progressive UI = **SSE**, collab splitting = **client-side**. See the
> "Phase 3b — what shipped" section below and TODO.md.

## Goal

`ARCHITECTURE.md` defines Phase 3 as retiring the recursive BFS in favour of typed
graph queries: `closure` / `via` / `viaChain` become query metadata, and the
hard-won expansion rules move from imperative control flow to query constraints.

Per the agreed scope this is split:

- **Phase 3a (this doc) — substrate query layer only**, mirroring how Phase 2 was
  "substrate only". Build and fully test the query; change no UX.
- **Phase 3b — server-side traversal**, which is user-facing and confronts cold
  fetches + the progressive-UI (streaming) decision. Deferred.

## Phase 3a — what shipped

### Cross-lookup read (`functions/_lib/quadStore.js`)

`makeD1Store(db)` gains `getQuadsTouching(key)`: every quad where `key` is the
subject **or** the object, across all `source_key`s, ordered by rowid. Backed by
the `idx_quads_subject` / `idx_quads_object` indexes created (unused) in Phase 2.
This is the first read that crosses lookups — both orientations matter because a
node is the subject of its `aka` / `member_of` (groups) / `related_project` edges
but the **object** of the reversed `member_of` edges that record its members.

### Pure traversal (`src/core/closure.js`)

`identityClosure(rootName, { neighbors, rootKeys, maxLookups, fanoutCap,
onBudgetExhausted })` → `{ merged, closure }` — the same shape `expandIdentityGraph`
returns. No I/O: it takes an injected async `neighbors(key)` accessor (the
`fetchFn`-injection convention), so tests drive it with an in-memory graph and
production wires:

```js
const neighbors = async (key) =>
  mergeResults(quadsToResult(key, await store.getQuadsTouching(key)));
```

`quadsToResult` (Phase 2) reconstitutes a node's mapped result from its quads;
`mergeResults` collapses duplicate edges from different providers. The traversal is
deliberately kept structurally identical to `expandIdentityGraph` /
`enqueueFromNode` so the two can be reconciled (and the BFS deleted) in 3b.

### Rules carried over (verbatim)

Transitive `aka` closure with `Search hint` / `Legal name` skip; alias fan-out cap
(15); `member_of` walked only from a group and only when not reached via an alias;
alias-with-members rejected as a group (attribution + bucket stripped, co-members
not walked); lineup-root union/skip; `groups`/`relatedProjects` not walked unless
the entry is itself a root; budget cap (25) as a pathology guard; cycle detection;
`via` / `viaChain` / `viaHadMemberStep` attribution.

### Cross-lookup, realised at read time

Phase 2 scoped reconstitution to one producing lookup. `getQuadsTouching` unions a
node's edges across providers and across the reversed `member_of` edges other
lookups wrote — so a member's lookup and the group's lookup now see each other.
**No new edges are written**; the Phase 2 write path is unchanged. A visible
consequence: a group walked into its members will see itself surfaced as those
members' group (the reverse edge). That is correct graph behaviour; root exclusion
is a rendering concern, handled downstream (and in 3b).

### Tests (`tests/closure.test.js`)

Seeds an in-memory graph via `resultToQuads` (exercising decompose → reconstitute →
traverse together) and mirrors the BFS scenarios from `tests/lookup.test.js`:
alias chains + `via`, transitive aliases, direct-over-via preference, cycles,
`Search hint`/`Legal name` skip, group-root member expansion, two-groups-via-member
union, person nodes not fanning out, multi-hop `viaChain`, alias-resolves-to-group
rejection, fan-out cap, root-skip union, budget exhaustion, and the new
cross-provider node union.

## Phase 3b — what shipped

### `/api/closure` SSE endpoint (`functions/api/closure.js`)

`runClosure(env, { root, roots, fetchFn, store, emit })` is the plumbing-free core
(mirroring `handleLookup`'s testability split). Its `neighbors(name)` accessor:

1. For each provider, `await handleLookup(env, { provider, name, store, … })` —
   reusing the entire Phase 2 cold/expired fetch + quad-write + HIT/MISS/STALE +
   stale-on-error path. No fetch/freshness logic is duplicated here. It `emit`s a
   `provider` SSE event per provider per node (carrying the cache label + that
   provider's result, so the dev-probe shows per-provider counts as before).
2. Reads the cross-provider union: `mergeResults(quadsToResult(key, await
store.getQuadsTouching(key)))` — the Phase 3a cross-lookup read, now live.

`identityClosure` then runs with an `onNode` hook that `emit`s `progress` (the
running merged) and an `onBudgetExhausted` hook that `emit`s `budget`; the final
`done` event carries `{ merged, closure, queried, errored }`. `onRequest` wraps
this in a `text/event-stream` `ReadableStream`, applies a per-IP `closure`
rate-limit scope, and propagates the client disconnect into upstream fetches.

`identityClosure` was adjusted minimally: `neighbors` now receives the
**original-cased** name (so the server can drive accurate MB/Discogs searches) and
normalises internally, plus the new `onNode` streaming hook. The expansion rules
are otherwise untouched.

### Browser side (`src/core/lookup.js`)

`lookupAll` keeps its public contract (same callbacks, same return shape) but its
per-name pipeline is now `streamClosure`: it `fetch`es `/api/closure`, parses the
SSE stream, and translates events back into `onProviderResult` / `onArtistDone` /
`onBudgetExhausted`. The browser BFS (`expandIdentityGraph` / `enqueueFromNode`)
and the per-provider rate-limit-queue + L1-cache machinery are **deleted** — the
walk and its rules live solely server-side now. Collab splitting stays client-side:
`splitCollab` rows open one stream per part + combo and merge here.

### Tests

`tests/closure-endpoint.test.js` drives `runClosure` with an in-memory D1 fake +
injected `fetchFn`, asserting the event sequence, cold-fetch substrate writes, and
cross-provider union. `tests/lookup.test.js` was reworked to stub `fetch` with a
fake SSE stream (the walk rules are covered by `tests/closure.test.js`).
`tests/lookupCache.test.js` was removed — it exercised the deleted L1-cache
integration in `lookupAll`.

## Still deferred (tracked in TODO.md)

- Sweep out the now-dead L1 (IndexedDB) lookup wiring still constructed in
  `main.js` and passed (ignored) to `lookupAll`.
- `/api/closure` rate-limit tuning against real lineup sizes.
- Physical GC of dead D1 rows (pre-existing Phase 2 item).
