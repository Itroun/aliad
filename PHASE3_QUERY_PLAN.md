# Phase 3: Query-shaped traversal

> **Status: Phase 3a DONE (substrate query layer). Phase 3b deferred.** The
> identity-graph walk now exists as a pure query over the Phase 2 quad store
> (`src/core/closure.js`), reading a node's edges _across_ `source_key`s so MB +
> Discogs finally union into one cross-provider view. It ships **dormant** — the
> browser BFS in `src/core/lookup.js` is untouched and still drives the live app.
> The server endpoint, cold-fetch driving, and retiring the BFS are **Phase 3b**
> (see the deferred section below and TODO.md).

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

## Deferred to Phase 3b (tracked in TODO.md)

- **`/api/closure` endpoint** that drives cold/expired-node fetches server-side
  (the part `identityClosure` deliberately doesn't do — it queries whatever the
  substrate holds), then runs the query and returns the expanded merged result.
- **Freshness/expiry** integration during traversal (skip-or-refetch expired
  nodes; stale-on-error), reusing the `lookups` row TTL fields.
- **Retire the browser BFS** (`expandIdentityGraph`); the browser calls the
  endpoint once per root.
- **Progressive-UI decision**: SSE/streaming to preserve live per-node
  `onProviderResult` / `onArtistDone` updates, vs. a single end-of-closure
  response. This is the main UX fork — settle before building 3b.
- **Collab splitting** (`splitCollab`) interplay once traversal is server-side.
- Physical GC of dead D1 rows (pre-existing TODO item).
