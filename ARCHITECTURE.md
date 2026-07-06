# Architecture

A snapshot of how **aliad** is built today, after the cache + graph rewrite. For the
product pitch and quick-start, see [README.md](./README.md). For _how it got
here_ — the staged migration from a browser-side recursive walk to a server-side
graph query — see git history; this file describes the destination, not the
journey.

## Data flow

```
Input ─▶ Extraction ─▶ Closure walk (server) ─▶ Graph view
 │          │                │                      │
 paste/     LLM via          /api/closure SSE,      identity graph +
 URL/file   /api/openrouter  one stream per act     connections panel
            (messy input     (+ per collab part)
            only)
```

1. **Input** (`src/ui/inputScreen.js`). Paste text, a URL, or a flyer/PDF/image.
2. **Extraction** (`src/core/extract.js`). Clean line-per-artist text passes
   through untouched; anything messier is sent to an LLM through the
   `/api/openrouter` proxy, which returns a clean list of act names. URLs are
   fetched server-side via `/api/fetch-page` (SSRF-guarded), HTML pre-cleaned by
   `src/core/cleanHTML.js`.
3. **Lookup + closure** (`src/core/lookup.js` → `/api/closure`). `lookupAll` is a
   thin **SSE client**: it splits collab names ("X vs Y") client-side and opens one
   `/api/closure` stream per act (and per part + combo), translating the streamed
   `provider` / `progress` / `budget` / `done` events back into the progressive
   callbacks the UI already consumes. The actual identity-graph walk runs on the
   server (see below).
4. **Display** (`src/ui/graphScreen.js`, `src/ui/graph/*`). Results stream into a
   live identity graph; a Lineup/Connections toggle (`viewTabs.js`) switches views.
   `devProbe.js` surfaces per-act cache/error tallies in dev builds.

## Layout

```
src/
├── core/
│   ├── lookup.js        SSE client: collab split + per-act /api/closure streams
│   ├── closure.js       identity-closure query (the walk) — runs server-side
│   ├── quads.js         pure: mapped result ⇄ typed quads (decompose/reconstitute)
│   ├── merge.js         normaliseName + bucket-wise, source-attributed dedupe
│   ├── graph.js         merged closure → graph view-model (edges, bridges, owners)
│   ├── extract.js       input-type detection + LLM lineup extraction (thin proxy client)
│   ├── cleanHTML.js     strip pages down before sending to the LLM
│   ├── fetchWithRetry.js  shared retry (honours Retry-After, capped 60s)
│   ├── tokenBucket.js   pure bucket math for the Discogs rate gate
│   ├── schemaVersion.js cache SCHEMA_VERSION (shared L2 invalidation key)
│   └── models.js        primary + fallback model ids (via OpenRouter)
├── providers/
│   ├── musicbrainz.map.js  pure search→pick→map mappers (pickMatch / mapDetails)
│   ├── discogs.map.js      "
│   └── provider.js         emptyResult() shape
├── ui/                  plain DOM, no framework (graph/, screens, viewTabs, devProbe)
├── main.js              wires screens + lookupAll together
└── style.css

server/                  Cloudflare Workers app (not Pages)
├── index.js             fetch() entry: router + ALLOWED_ORIGIN guard → /api/* handlers
├── api/
│   ├── lookup.js        search+pick+details+map; reads/writes the D1 quad cache
│   ├── closure.js       drives the walk per node, streams progress as SSE
│   ├── openrouter.js    LLM proxy via OpenRouter (key injection, rate + daily-ceiling caps)
│   └── fetch-page.js    URL fetch proxy (SSRF guard, challenge sniffing)
├── rateLimiter.js       RateLimiter Durable Object (global Discogs token bucket)
└── _lib/                binding adapters: quadStore (D1), kvLimit (KV daily
                         counters), ipLimit (native per-IP rate limits),
                         rateGate (DO), originCheck (origin allowlist)

migrations/0001_create_graph.sql   D1 schema (lookups + quads + indexes)
```

## The substrate: a D1 quad store

The rewrite's core idea: a cached lookup **is** a set of graph edges, so the cache
and the graph are one store. `/api/lookup` runs search → candidate-pick → details
→ map server-side (via the pure `*.map.js` mappers, with the Discogs token / MB
User-Agent injected), then **decomposes** the mapped result into typed quads
(`src/core/quads.js`) and stores them in D1 (`server/_lib/quadStore.js`), keyed by
`source_key = ${provider}:${normalisedName}`. A read **reconstitutes** the same
blob from that lookup's quads, so the `/api/lookup` JSON is byte-identical to the
pre-graph version.

- **Predicates** (see `quads.js` for the canonical set): `aka` (identity-
  equivalent), `member_of`, `related_project`, each carrying provenance
  (provider + `sourceUrl` + `fetchedAt`).
- **Freshness.** Non-empty results get a long TTL, empties a short one. D1 has no
  TTL of its own, so an expired row's quads simply linger — which is exactly what
  enables **stale-on-error** (serve the old edges when an upstream is down). The
  flip side is no automatic GC; see TODO.md.
- **Cross-provider union.** `getQuadsTouching(key)` reads a node's edges across
  every `source_key`, so MB + Discogs finally union per node instead of being two
  separate blobs. This is what makes the closure a real cross-source graph.

## The Discogs dump substrate

A fully-cold large lineup is Discogs-budget-bound: the measured 144-act run was
695 Discogs wire calls / 12.4 minutes, purely rate-gated. So the Discogs
"upstream" is consulted from a **read-only monthly snapshot** before the network.
A hit maps straight to a result with **no rate-gate token and no API call**, which
turns the gate into a guard over only the _fallback_ path (names the snapshot
doesn't know).

- **Rebuildable snapshot, not a source of truth.** `scripts/dump/build.js` ingests
  the monthly Discogs artists dump (line-delimited XML) into a SQLite file —
  `dump_names` (one collision winner per `norm_name`), `dump_edges` (identity
  relations by artist id), `dump_meta` — then `scripts/dump/upload.js` pushes it to
  a Turso database. The Worker reads it over the Turso `/v2/pipeline` protocol via
  `server/_lib/dumpStore.js` (a plain-`fetch` adapter, like every other binding).
  Nothing writes back; a rebuild fully replaces it.
- **Full name index.** _Every_ artist is indexed, namevariations included, even
  those with zero relations — presence with no edges is a "known empty" answer that
  keeps relation-less obscure roots (the bulk of festival bookings) off the API.
  Dump relations are reciprocal, so every edge target itself has ≥1 relation;
  trimming to relation-having artists would only ever hurt roots, never the walk.
- **Ingest-time tie-break.** Many artists share a `norm_name`
  (`normaliseName(stripDisambiguation(raw))`, the production identity key — the real
  `src/` functions, so keys match exactly). `scripts/dump/resolveWinner.js` picks
  one deterministic winner per name: primary name > namevariation → unsuffixed >
  `(N)`-suffixed → more edges > fewer → lowest artist id. Pure and unit-tested.
- **Degrade-open invariant.** `TURSO_DUMP_URL`/`TURSO_DUMP_TOKEN` unbound →
  `makeDumpStore` returns null; Turso unreachable → `getArtist` throws. Either way
  the lookup falls through to today's gated search+details path. The rate gate,
  HIT/MISS/STALE, TTLs, quad writes, and stale-on-error are all untouched — the gate
  simply idles when the dump answers. A dump hit still writes quads, so the next
  lookup of that name is a plain D1 HIT.
- **Refresh cadence.** A monthly snapshot, refreshed manually (runbook in
  CLAUDE.md). Mid-month edits to existing artists wait for the next dump; names
  absent from the snapshot fall back to the live API every time. MusicBrainz is out
  of scope — the gate change measures how MB behaves as the only thing on the wire,
  and any MB decision is a follow-up with data.

## The closure query, and its hard-won rules

`server/api/closure.js` drives the walk: for each node it calls `handleLookup`
(reusing the `/api/lookup` HIT/MISS/STALE + write path) to populate the substrate,
then reads the cross-provider union and runs `identityClosure`
(`src/core/closure.js`) — the BFS re-expressed as a pure query over the quads.

The expansion **rules** are the crown jewels — re-learned slowly if ever lost — and
live as documented code, not here. The summary, with pointers:

- **Identity-only traversal.** Follow `aka` edges, and `member_of` _only_ for nodes
  that are themselves groups. Never fan a person out through their `groups` /
  `related_project` (that's "people they play with," not "the same person") — except
  when the neighbour is itself a lineup root, which is registered without a lookup.
- **Fan-out + budget caps** (`ALIAS_FANOUT_CAP`, `maxLookups`). A prolific-pseudonym
  node registers its alias names for clustering but isn't walked into; a per-root
  budget contains pathological wrong-match explosions. See `src/core/closure.js`.
- **Foreign-identity guard.** A band-less alias stub that resolves to an unrelated
  (often prolific) artist is registered for clustering but not fanned into, so one
  poisoned alias edge can't drag a whole foreign discography into the cluster.
  Rationale inline in `closure.js`.
- **Collab attribution + edge reduction** (`src/core/graph.js`). `collectRelations`
  attributes each relation to the specific combo _part_ that hosts it (`rel.owners`,
  one hop per owning part); `buildEdge` drops bridge rows that are circular noise
  (a part already shown by its own node, or a hub that is itself another lineup
  node — triangle-reduces to a star). Rationale inline in `graph.js`.

## Invariants — what should not change

These compose cleanly and everything else leans on them:

- **The provider seam.** A source is a pure `*.map.js` mapper (`pickMatch` +
  `mapDetails`) returning `{ aliases, groups, members, relatedProjects }`. The
  orchestrator never branches on provider identity; adding Wikidata is a new
  mapper plus a one-line registration in `server/api/lookup.js`, nothing else.
- **`normaliseName` + source-attributed merge** (`merge.js`). The single canonical
  key, used everywhere; cached and live edges fold together with no special-casing.
- **Progressive SSE callbacks.** `provider` / `progress` / `budget` / `done` keep
  the graph filling as data arrives; the UI never waits on the slowest node.
- **Collab splitting stays client-side.** `/api/closure` is single-root by design;
  `lookupAll` owns the "X vs Y" split and stream-merge.
- **Bindings sit behind adapters** (`server/_lib/*`). The only Cloudflare-specific
  surface is KV, D1, and the RateLimiter DO — each behind one small module — so the
  WinterCG-standard `fetch()` handler stays portable.

## Deliberately retired — do not reintroduce

The rewrite removed these on purpose; resurrecting them would undo it:

- **The browser BFS.** `expandIdentityGraph` / `enqueueFromNode` and the per-run
  session `Map` cache are gone from `lookup.js` — the walk is server-side now, the
  expansion rules live solely in `src/core/closure.js`.
- **The L1 IndexedDB cache** (`src/core/cache.js`) — the shared D1 L2 superseded it;
  `SCHEMA_VERSION` is now a single-tier key.
- **The thin browser provider clients** (`providers/{musicbrainz,discogs}.js`) and
  `fetchJson.js` — only the pure `*.map.js` mappers remain.
- **Per-provider `createQueue` pacing** (`src/core/rateLimit.js`). Global Discogs
  pacing is now the RateLimiter DO; MB stays best-effort (cache only).

## External data sources

Both lookups go through `/api/lookup`, which injects credentials server-side
(tokens never reach the browser) and shares the D1 cache across visitors.

- **MusicBrainz.** No auth; rate limit 1 req/sec. The proxy sets the descriptive
  `User-Agent` MB wants (the browser forbids that header). MB's global 1/sec stays
  **best-effort** — the per-IP cap on `/api/lookup` is abuse protection, not MB's
  limit, so concurrent cold lookups can still stampede past 1/sec; we accept that
  (gating MB would serialise big cold runs into multi-minute crawls).
- **Per-IP abuse caps** (all `/api/*` endpoints) run on native Workers
  rate-limiting bindings (`[[ratelimits]]`, adapter `server/_lib/ipLimit.js`) —
  free and KV-less, but per-colo/eventually-consistent, which is fine for per-IP
  caps and disqualifying for global budgets. KV holds only the two OpenRouter
  daily counters (global call ceiling + per-IP daily sub-cap): they need a 24h
  window and one global truth. This split exists because a KV-counter limiter
  (1 read + 1 write per request against a 1k-writes/day free tier) capped the
  whole app at ~1k requests/day and let the cheap endpoints exhaust the write
  budget the LLM spend ceiling depends on — every KV guard degrades open, so
  budget exhaustion silently disarmed it.
- **Discogs.** Requires a personal access token; 60 req/min authenticated as a
  **rolling window**. Enforced globally by the RateLimiter DO token bucket, sized
  to the invariant `capacity + refill/min ≤ 60` (5 + 54 = 59): a cold run drains
  the burst plus a full minute's refill into Discogs's first window, and a 10+55
  sizing was measured to trip a sustained 429 spiral. Every **wire attempt**
  (retries included) consumes a token, so the outbound rate can never exceed the
  bucket rate even mid-incident; `fetchWithRetry` (honouring `Retry-After`, capped
  60 s) is the backstop. The bucket is **two-tier**: cold *root* lookups take
  tokens freely, while *expansion* lookups (`priority=expand`) only succeed above
  a reserve floor — so on a cold lineup every act's headline data lands before any
  act's deep walk, and the long tail of a big cold run is background enrichment
  rather than blocking. Denied waiters sleep with per-denial escalation (capped
  5 s root / 15 s expand) so parked waiters cost a few DO round-trips, not one
  per second. Wait budgets are sized past the measured cold-run phases (600 s
  root, 900 s expand — a fully-cold large lineup is Discogs-budget-bound
  wall-to-wall, ~12+ min, which is why scheduling, not throughput, is the
  lever): an expand waiter that outlives its budget is promoted to the root
  tier (still gated), and only a waiter that then also exhausts the root budget
  — meaning ~10+ minutes of continuous denial, i.e. a wedged DO, not a busy run
  — proceeds ungated as the last resort. Gate waits are **abort-aware**: the
  request's signal reaches the gate, so a disconnected client's walk stops at
  the next node and never consumes a token for a fetch nobody will read. The
  closure SSE stream sends a comment heartbeat every 15 s so a long gate park
  can't get the stream killed by idle-connection timeouts.
- **Transient errors.** 429 / 5xx retry with backoff + jitter; anything else
  surfaces as a provider failure — the node usually still has data from the other
  provider, and a warm re-run clears it.

## Principles & conventions

- **Scope discipline.** v1 is intentionally tight; features beyond the brief
  (accounts, Wikidata, graph viz, scraping) trigger a conversation before code.
- **One fetch per user action.** The extraction layer fetches once what the user
  explicitly asked for — no crawling, no background scraping, no robots.txt games.
- **Providers are leaves.** A mapper knows nothing about other providers, the
  cache, or the UI — see the provider-seam invariant above.
- **Progressive > complete.** First byte beats lowest latency to full results.
- **No framework.** Plain DOM, plain ES modules, plain CSS — readable within
  minutes of cloning.
- **Two themes, one class.** Dark "Constellation" and light "Nautical Chart"
  are pure CSS variable swaps keyed off a `.theme-dark` / `.theme-light` class
  on `<html>` (set by `ui/themeToggle.js`, persisted in localStorage, dark by
  default); structural differences (star field vs chart grid, solid vs dashed
  edges, node shapes) are theme-scoped rules. Keep new styling variable-driven
  so both themes stay in sync.
- **Chrome placement.** Persistent controls live in the top bar (view tabs +
  theme toggle), present on every screen. The footer (brand mark + external
  links) lives only on the lineup screen — footers belong on document-like,
  scrollable pages; the map view is a full-screen app canvas, so anything that
  must be reachable there goes in the top bar, not a footer.
- **Tests are pure + fast.** Cores are unit-tested with injected `fetchFn` / `sleep`
  and fixture captures under `tests/fixtures/` — no real timers or network. MB
  fixtures are real captures; Discogs fixtures are synthesised (tagged `_note`)
  pending a token.
