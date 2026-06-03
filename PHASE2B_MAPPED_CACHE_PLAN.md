# Phase 2b: Mapped-result consolidation (server cache)

The goal: collapse the two independent cache tiers — L1 (browser IndexedDB, mapped
results) and L2 (server KV, raw HTTP responses from Phase 1b) — into **one shared
key space** keyed by `(provider, normalisedName)`, storing the *mapped* result
shape. After this, L1 and L2 are two tiers of the *same* cache, and the server
becomes the natural home for the Phase 2 graph substrate.

This is the consolidation step that Phase 1b deliberately deferred. It is **not**
required for "shared across visitors" — Phase 1b already delivers that. 2b is
about unification, fewer cache entries, and setting up the graph model.

See [PHASE1B_SHARED_CACHE_PLAN.md](./PHASE1B_SHARED_CACHE_PLAN.md) for the HTTP-level
cache this supersedes, [PHASE1_CACHE_PLAN.md](./PHASE1_CACHE_PLAN.md) for the L1
browser cache, and [ARCHITECTURE.md](./ARCHITECTURE.md) for how this dovetails
into the graph store (the canonical "Phase 2").

## Relationship to Phase 2 (graph substrate)

`ARCHITECTURE.md` defines Phase 2 as replacing the cache's *value store* with a
quad/graph store (still client-side in the original framing). Phase 2b is the
**server-side precondition** for doing that *shared*:

- 2b moves result-mapping server-side and caches mapped results per
  `(provider, normalisedName)`. A mapped result is already "a set of edges with a
  `fetchedAt`" — exactly the unit the graph store wants.
- Once the server holds mapped results, decomposing them into quads (Phase 2
  proper) is a server-side change to the value store, and the graph becomes
  shared by construction.

Sequencing: **Phase 1b → Phase 2b → Phase 2 (graph) → Phase 3 (query traversal).**
2b is the bridge between "shared HTTP cache" and "shared graph substrate."

## What changes

### 1. Mappers become shared modules

Today the pure mappers run only in the browser (`mapDetails` in
`src/providers/musicbrainz.js`, the Discogs equivalent). They are already pure and
side-effect-free. Extract the mapping logic so the **same code** is importable by
both the browser and the Pages Functions:

```
src/providers/musicbrainz.map.js   pure: upstream JSON → { aliases, groups, members, relatedProjects }
src/providers/discogs.map.js       pure: upstream JSON → result shape
```

Pages Functions are esbuild-bundled by Wrangler and can import shared ES modules,
so no duplication. Provider modules and Functions both import the mappers.

### 2. A single lookup endpoint

```
functions/api/lookup.js   GET /api/lookup?provider=<p>&name=<raw name>
```

Server flow:

1. `key = lookup:${SCHEMA_VERSION}:${provider}:${normaliseName(name)}` — the
   **same key shape as the L1 IndexedDB cache**.
2. `KV.get(key)` → hit: return mapped JSON, `X-Cache: HIT`.
3. Miss: rate-limited upstream fetch(es) (reusing `checkRateLimit`, token
   injection, MB User-Agent) → run the shared mapper → `KV.put` with TTL → return
   mapped JSON, `X-Cache: MISS`.
4. Stale-on-error identical to Phase 1/1b.

This replaces the Phase 1b raw-HTTP `edgeCache` entries with one mapped entry per
artist per provider — **far fewer writes** (one per artist, not one per upstream
HTTP call), which directly eases the KV write-budget pressure flagged in 1b.

### 3. Browser providers become thin clients

`src/providers/musicbrainz.js` / `discogs.js` collapse to:

```js
lookup(name, { signal }) => fetch(`/api/lookup?provider=…&name=…`).then(r => r.json())
```

The mapping they used to do now happens server-side via the shared mapper. The
provider contract (`{ name, minIntervalMs, lookup }`) is preserved, so the
orchestrator, merge, and expansion walker are untouched.

### 4. L1/L2 unification

- L1 (IndexedDB) keeps its `(provider, normalisedName)` → mapped-result entries,
  unchanged in shape — it now mirrors L2 exactly, just per-browser.
- `src/core/cache.js` and the new server entry share `SCHEMA_VERSION`. One bump
  invalidates both tiers coherently.
- Lookup order in the orchestrator: L1 (IndexedDB) → `/api/lookup` (which is L2 KV
  → upstream). A clean two-tier read-through.

## Storage: KV now, D1 if write/query pressure demands

- **KV is sufficient for 2b** and benefits immediately from the write reduction
  (one mapped entry per artist).
- **Revisit D1 when Phase 2 (graph) lands.** A quad store wants indexed queries
  (`by-subject`, `by-predicate-object`) that KV's single-key access can't serve.
  D1 (SQLite) is the natural backing for the graph and for write-heavy cold fills.
  Decision deferred to the Phase 2 graph work — don't migrate storage in 2b unless
  the KV write budget forces it sooner.

## Trade-offs vs. staying on Phase 1b

**For:**
- One key space; L1 and L2 unify; one `SCHEMA_VERSION` governs both.
- Fewer KV writes (per-artist, not per-HTTP-call).
- Mapping lives in one place; the server owns rate-limit + map + cache.
- Sets up the shared graph substrate cleanly.

**Against / cost:**
- Bigger refactor: mappers extracted, providers rewritten as thin clients, a new
  endpoint, more server logic to test.
- Mapping now runs in the Workers runtime — keep mappers pure and dependency-free
  (they already are).
- Plain `npm run dev` already can't do MB after 1b; 2b makes *all* lookups require
  the Functions runtime locally. No additional DX regression beyond 1b's.

## Tests

- **`tests/musicbrainz.map.test.js` / `discogs.map.test.js`** — move the existing
  fixture-based mapping assertions onto the extracted pure mappers (mostly a
  relocation of current provider tests).
- **`tests/lookupEndpoint.test.js`** — the `/api/lookup` Function against fake KV +
  injected upstream `fetch`: miss→map→store→hit, stale-on-error, empty TTL,
  version bump.
- **Orchestrator tests** — unchanged; providers still satisfy the same contract.

## Step-by-step build order

1. Extract pure mappers into `*.map.js`; repoint current provider code at them
   (no behaviour change yet). Tests green.
2. Add `functions/api/lookup.js`: KV-cached, shared-mapper, rate-limited. Verify
   with curl.
3. Switch browser providers to thin `/api/lookup` clients. Run the full suite.
4. Confirm L1 (IndexedDB) and L2 (KV) share key + `SCHEMA_VERSION`; one bump
   invalidates both.
5. Retire the Phase 1b raw-HTTP `edgeCache` entries (let them TTL out; remove the
   helper once the proxies no longer need it, or keep it if the proxies still
   serve non-lookup paths).
6. Manual verification across two browsers, as in 1b.

Defer the quad-store decomposition and any D1 migration to the Phase 2 graph work
in `ARCHITECTURE.md`. Phase 2b should land as a clean unification, not a graph
rewrite.
