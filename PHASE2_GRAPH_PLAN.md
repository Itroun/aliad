# Phase 2: Graph substrate (D1 quad store)

> **Status: DONE.** The L2 cache value store is now a D1 quad graph. Mapped
> results decompose into typed quads on write (`src/core/quads.js`) and are stored
> via `functions/_lib/quadStore.js`; reads reconstitute the same blob from the
> producing lookup's quads. Substrate-only — the `/api/lookup` contract, the
> browser walker (`src/core/lookup.js`), and the L1 IndexedDB cache are unchanged.
> Next up is **Phase 3 — query-shaped traversal** (see ARCHITECTURE.md). This doc
> is the design record.

## Goal

`ARCHITECTURE.md` defines Phase 2 as replacing the cache's _value store_ with a
quad/graph store. Phase 2b had moved mapping server-side and cached one mapped
blob per `(provider, normalisedName)` in KV. Phase 2 keeps that key shape but
swaps the value store: a mapped result is now a set of typed edges, which is
exactly what the graph wants — laying the shared, queryable substrate for Phase 3
(server-side closure queries that retire the browser BFS).

Two decisions taken up front:

- **Backing: D1 (SQLite).** Real indexed quad queries (`by-subject`,
  `by-predicate-object`) — the natural fit and what Phase 3 needs. KV stays, but
  only for rate limiting + the Anthropic ceiling.
- **Scope: substrate only.** Decompose → store → reconstitute the _same_ blob,
  scoped to the producing lookup. No reverse/cross-lookup edges yet (Phase 3).

## Quad model (`src/core/quads.js`)

A mapped result for subject `s = normaliseName(name)` decomposes into directed
quads. Buckets map to predicates by direction:

| bucket              | quad                                |
| ------------------- | ----------------------------------- |
| `aliases[]`         | `aka(s, alias)`                     |
| `groups[]`          | `member_of(s, group)`               |
| `members[]`         | `member_of(member, s)` _(reversed)_ |
| `relatedProjects[]` | `related_project(s, project)`       |

Each quad carries provenance: producing `source_key`, original-cased
`subjectLabel` / `objectLabel`, `entryType`, `sourceUrl`. `fetchedAt` lives on the
per-lookup row, not the quad.

`resultToQuads(provider, nameKey, name, result)` decomposes; `quadsToResult(nameKey,
quads)` re-buckets by predicate + orientation. Reconstitution scopes to one
`source_key`'s quads, so the blob round-trips exactly and no edges leak in from
other lookups — that wider view is deliberately Phase 3.

## Storage (`migrations/0001_create_graph.sql`, `functions/_lib/quadStore.js`)

`lookups(source_key PK, provider, name_key, schema_version, fetched_at, is_empty,
expires_at)` — one freshness row per lookup. `quads(source_key, subject, predicate,
object, subject_label, object_label, entry_type, source_url)` with indexes
`idx_quads_source` (reconstitution), `idx_quads_subject(subject,predicate)` and
`idx_quads_object(predicate,object)` (Phase 3).

`makeD1Store(db)` is the only place raw SQL lives: `getLookup`, `getQuads`
(ordered by rowid to preserve per-bucket order), and `putLookupWithQuads` (a
`db.batch` that upserts the lookups row and delete-then-inserts its quads). Tests
inject an in-memory fake implementing the same three methods, mirroring the old
`fakeKV`.

D1 has no TTL: expiry is **logical** (`expires_at` / `schema_version` checked on
read). An expired row's quads simply remain until rewritten — which is what lets
us serve them STALE when the upstream is down. Dead rows accumulate until a future
cleanup job (tracked in TODO.md).

## Endpoint flow (`functions/api/lookup.js`)

`handleLookup` takes an injectable `store` (defaulting to `makeD1Store(env.DB)`):

1. No store (no `DB` bound) → straight upstream, `X-Cache: BYPASS`.
2. `getLookup(sourceKey)`; fresh + matching `schema_version` → reconstitute → `HIT`.
3. Miss/expired → `lookupUpstream` → `resultToQuads` → `putLookupWithQuads` (TTL by
   `is_empty`) → `MISS`.
4. Upstream error with a prior row → reconstitute its quads → `STALE`; else `502`.

## Tests

- `tests/quads.test.js` — round-trip, member reversal, empties, name-normalisation
  skips, ordering, foreign-quad isolation.
- `tests/lookupEndpoint.test.js` — same MISS→HIT / empty-TTL / STALE / 502 /
  version-bump / BYPASS coverage, now against the in-memory fake store and the
  `source_key` shape.

## Local dev / deploy

- `wrangler.toml` gains a `DB` D1 binding (placeholder id). Local dev uses
  wrangler's filesystem SQLite; apply the schema once with
  `npx wrangler d1 migrations apply aka-graph --local`.
- Deploy time (deferred, see TODO.md): `npx wrangler d1 create aka-graph`, paste
  the id, then `npx wrangler d1 migrations apply aka-graph --remote`.

## Out of scope (Phase 3+)

Reverse/cross-lookup edges, server-side transitive `aka` closure queries, retiring
the browser BFS, physical GC of dead D1 rows.
