// Unified server lookup endpoint. GET /api/lookup?provider=&name=
//
// Does the full search + details + map server-side and caches ONE mapped result
// per (provider, normalisedName) — the same key shape and value shape as the L1
// browser cache (src/core/cache.js). L1 and L2 are two tiers of the same cache,
// governed by one SCHEMA_VERSION.
//
// Phase 2: the L2 value store is now a D1 quad graph rather than a single KV
// blob. On write the mapped result is decomposed into typed quads (src/core/
// quads.js) and stored via the D1 adapter (functions/_lib/quadStore.js); on read
// the blob is reconstituted from that lookup's quads. The returned JSON is
// byte-identical to before — only the backing store changed — so the browser
// walker and provider contract are untouched. This lays the shared, queryable
// substrate for Phase 3 (server-side closure queries). Per-IP abuse caps live
// on the native ratelimits bindings (ipLimit.js); KV holds only the OpenRouter
// daily counters. See ARCHITECTURE.md.

import { checkIpLimit } from '../_lib/ipLimit.js';
import { awaitDiscogsSlot, PRIORITY_ROOT } from '../_lib/rateGate.js';
import { makeD1Store } from '../_lib/quadStore.js';
import { makeDumpStore } from '../_lib/dumpStore.js';
import { SCHEMA_VERSION } from '../../src/core/schemaVersion.js';
import { normaliseName } from '../../src/core/merge.js';
import { fetchWithRetry } from '../../src/core/fetchWithRetry.js';
import { emptyResult } from '../../src/providers/provider.js';
import { resultToQuads, quadsToResult, sourceKeyFor } from '../../src/core/quads.js';
import * as mb from '../../src/providers/musicbrainz.map.js';
import * as discogs from '../../src/providers/discogs.map.js';

// MB wants a descriptive UA; the browser forbids setting it, which is one reason
// these calls are proxied server-side (see CLAUDE.md rate-limits note).
const USER_AGENT = 'aliad/0.1 (+https://aliad.app)';

const DAY = 24 * 3600;
// Freshness windows mirror the L1 browser cache: aliases/members/groups are
// high-stability so non-empty results live long; empties re-check sooner in
// case the artist gets added upstream.
const TTL_NONEMPTY_SEC = 30 * DAY;
const TTL_EMPTY_SEC = 7 * DAY;
// D1 has no TTL, so an expired entry's quads simply remain until rewritten —
// which is exactly what lets us serve them STALE when the upstream is down.

const PROVIDERS = {
  musicbrainz: {
    // Per-IP abuse cap (120/60s, see wrangler.toml), NOT MB's global 1/sec
    // (can't be enforced per-IP; left best-effort to the client queue). One
    // lineup run fans out many lookups via the identity-graph walk, so the
    // window has generous headroom.
    ipLimitBinding: 'RL_MB',
    requiresToken: false,
    headers: () => ({ 'User-Agent': USER_AGENT, Accept: 'application/json' }),
    searchUrl: (name) =>
      `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`,
    detailsUrl: (id) =>
      `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(id)}?inc=aliases+artist-rels&fmt=json`,
    pickMatch: mb.pickMatch,
    mapDetails: mb.mapDetails,
    retry: { maxAttempts: 5, backoffMs: [1000, 3000, 7000, 15000] },
  },
  discogs: {
    ipLimitBinding: 'RL_DISCOGS', // per-IP abuse cap 60/60s (wrangler.toml)
    // Gate upstream calls through the global RateLimiter DO. MB is left
    // best-effort (CLAUDE.md rate-limits note); only Discogs 429s in practice.
    gated: true,
    // Consult the Turso Discogs dump before the wire: a dump hit maps straight
    // to a result with no gate token and no API call. Only Discogs has a dump.
    dump: true,
    requiresToken: true,
    headers: (env) => ({
      Authorization: `Discogs token=${env.DISCOGS_TOKEN}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    }),
    searchUrl: (name) =>
      `https://api.discogs.com/database/search?q=${encodeURIComponent(name)}&type=artist`,
    detailsUrl: (id) => `https://api.discogs.com/artists/${encodeURIComponent(id)}`,
    pickMatch: discogs.pickMatch,
    mapDetails: discogs.mapDetails,
    retry: {},
  },
};

function isResultEmpty(result) {
  return (
    (result?.aliases?.length ?? 0) === 0 &&
    (result?.groups?.length ?? 0) === 0 &&
    (result?.members?.length ?? 0) === 0 &&
    (result?.relatedProjects?.length ?? 0) === 0
  );
}

// Fold one fetchWithRetry outcome into the per-lookup stats collector. Every
// attempt is one real upstream HTTP request — the unit both providers' rate
// limits count — so `calls` includes retries.
function recordAttempts(stats, attempts) {
  if (!stats || !Array.isArray(attempts)) return;
  stats.calls += attempts.length;
  stats.retries += Math.max(0, attempts.length - 1);
  for (const a of attempts) if (a.status === 429) stats.status429++;
}

async function getJson(url, { headers, fetchFn, retry, sleep, signal, stats }) {
  const result = await fetchWithRetry(
    url,
    { headers },
    { fetchFn, sleep, signal, ...(retry ?? {}) },
  );
  recordAttempts(stats, result.attempts);
  if (!result.ok) throw new Error(`upstream ${result.status ?? result.reason} for ${url}`);
  return result.response.json();
}

// The full pure pipeline: search → pick best candidate → details → map. Runs
// the same selection/mapping as the browser used to, now server-side.
// Mutates `stats` (calls/retries/429s/gate wait) as it goes so the collector is
// meaningful even when the pipeline throws mid-way (the STALE/502 paths).
async function lookupUpstream(
  cfg,
  env,
  name,
  { fetchFn, sleep, signal, stats, priority, dumpStore },
) {
  // Dump-first: a local Discogs-dump hit maps straight to a result — no gate
  // token, no wire call. `null` means the name is absent from the dump (fall
  // through to the live search); a thrown error means the dump is unreachable
  // (degrade to the wire). A present-but-relation-less artist still counts as a
  // hit (empty result), keeping obscure roots off the API.
  if (cfg.dump && dumpStore) {
    let details;
    try {
      // Key exactly as the dump was built: normaliseName(stripDisambiguation()).
      // Skipping the strip here would miss any "(N)"-suffixed name (build side is
      // scripts/dump/build.js stageName).
      details = await dumpStore.getArtist(normaliseName(discogs.stripDisambiguation(name)), {
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err; // client disconnect must stop the walk
      // Dump unreachable/broken → fall through to the wire, but leave a trace so a
      // persistent Turso failure doesn't masquerade as a normal cold run.
      stats.dumpError = 1;
      details = undefined;
    }
    if (details) {
      stats.dumpHit = 1;
      return cfg.mapDetails(details);
    }
  }

  // Past here we need the wire, which needs the Discogs token — checked lazily so
  // a dump hit above serves token-free (degrade-open).
  if (cfg.requiresToken && !env?.DISCOGS_TOKEN) {
    const err = new Error('Discogs token not configured');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const headers = cfg.headers(env);
  // Gate at the WIRE level, not per logical call: every attempt fetchWithRetry
  // fires — retries included — takes one token, so the outbound rate can never
  // exceed the bucket rate. Gating only the first attempt is how a run death-
  // spirals: once the upstream 429s, each granted lookup fires extra ungated
  // retries, holding the provider above its window exactly when the rate needs
  // to drop (measured: a cold lineup's Discogs side collapsed this way).
  // The signal reaches the gate too, so an abandoned request stops waiting —
  // and never takes a token — the moment the client goes away.
  const wireFetch = !cfg.gated
    ? fetchFn
    : async (url, init) => {
        stats.gateWaitMs += await awaitDiscogsSlot(env, { sleep, signal, priority });
        return fetchFn(url, init);
      };
  const fetchJson = (url) =>
    getJson(url, { headers, fetchFn: wireFetch, retry: cfg.retry, sleep, signal, stats });
  const searchData = await fetchJson(cfg.searchUrl(name));
  const match = cfg.pickMatch(searchData, name);
  if (!match) return emptyResult();
  return cfg.mapDetails(await fetchJson(cfg.detailsUrl(match.id)));
}

/**
 * Cached lookup core, separated from request plumbing for testability.
 * @returns { status, body, cache, stats } — body is a string; cache is the
 * X-Cache label. `stats` ({ calls, retries, status429, gateWaitMs }) is upstream
 * telemetry for the dev-probe's cold-run accounting; it is only present when the
 * upstream was actually consulted (MISS/STALE/BYPASS/502), never on a HIT.
 *
 * `priority` ('root' | 'expand', default 'root') is the rate-gate tier: the
 * closure walk marks its expansion lookups 'expand' so cold roots across all
 * concurrent streams get Discogs tokens first.
 *
 * `signal` aborts the upstream leg — including a gate wait in progress, so an
 * abandoned request never consumes a Discogs token.
 */
export async function handleLookup(
  env,
  {
    provider,
    name,
    fetchFn = fetch,
    sleep,
    now = Date.now,
    store,
    dumpStore,
    priority = PRIORITY_ROOT,
    signal,
  },
) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return { status: 400, body: 'Unknown provider', cache: null };
  // The Discogs token is required only for the WIRE path — a dump hit serves
  // token-free. lookupUpstream throws NO_TOKEN if it actually needs the wire and
  // the token is missing; both call sites below map that to the 500.

  const ok = (result, cache, stats) => ({
    status: 200,
    body: JSON.stringify(result),
    cache,
    stats,
  });
  const nameKey = normaliseName(name);
  if (!nameKey) return ok(emptyResult(), 'BYPASS');

  const stats = { calls: 0, retries: 0, status429: 0, gateWaitMs: 0, dumpHit: 0, dumpError: 0 };

  // Both stores are injectable for tests; default to the real adapters when
  // their bindings are present (each returns null / is null when unbound, so the
  // pipeline degrades to today's gated wire path).
  const graph = store ?? (env?.DB ? makeD1Store(env.DB) : null);
  const dump = dumpStore ?? (env ? makeDumpStore(env) : null);

  // Degraded: no D1 bound → straight upstream, no caching (same posture as kvLimit).
  if (!graph) {
    try {
      return ok(
        await lookupUpstream(cfg, env, name, {
          fetchFn,
          sleep,
          signal,
          stats,
          priority,
          dumpStore: dump,
        }),
        'BYPASS',
        stats,
      );
    } catch (err) {
      if (err?.code === 'NO_TOKEN') {
        return { status: 500, body: 'Discogs token not configured', cache: null };
      }
      throw err;
    }
  }

  const sourceKey = sourceKeyFor(provider, nameKey);
  let lookupRow = null;
  try {
    const row = await graph.getLookup(sourceKey);
    if (row && row.schema_version === SCHEMA_VERSION) lookupRow = row;
  } catch {
    // D1 read failed — treat as a miss.
  }

  const reconstitute = async () => quadsToResult(nameKey, await graph.getQuads(sourceKey));

  if (lookupRow && now() < lookupRow.expires_at) {
    try {
      return ok(await reconstitute(), 'HIT');
    } catch {
      // Reconstitution failed (e.g. D1 hiccup) — fall through to a fresh fetch.
    }
  }

  let result;
  try {
    result = await lookupUpstream(cfg, env, name, {
      fetchFn,
      sleep,
      signal,
      stats,
      priority,
      dumpStore: dump,
    });
  } catch (err) {
    // No Discogs token and the dump couldn't serve → the same hard 500 as before,
    // but only now that the wire is genuinely needed.
    if (err?.code === 'NO_TOKEN') {
      return { status: 500, body: 'Discogs token not configured', cache: null, stats };
    }
    // Stale-on-error: serve a prior (expired) entry's quads rather than failing.
    if (lookupRow) {
      try {
        return ok(await reconstitute(), 'STALE', stats);
      } catch {
        // fall through to the 502 below
      }
    }
    return { status: 502, body: 'Upstream lookup failed', cache: null, stats };
  }

  const isEmpty = isResultEmpty(result);
  const ttl = isEmpty ? TTL_EMPTY_SEC : TTL_NONEMPTY_SEC;
  const fetchedAt = now();
  const row = {
    sourceKey,
    provider,
    nameKey,
    schemaVersion: SCHEMA_VERSION,
    fetchedAt,
    isEmpty,
    expiresAt: fetchedAt + ttl * 1000,
  };
  try {
    await graph.putLookupWithQuads(row, resultToQuads(provider, nameKey, name, result));
  } catch {
    // Write failed — still serve the fresh result this request.
  }
  return ok(result, 'MISS', stats);
}

export async function handle(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get('provider');
  const name = url.searchParams.get('name');
  if (!name) return new Response('Missing name', { status: 400 });

  const cfg = PROVIDERS[provider];
  if (!cfg) return new Response('Unknown provider', { status: 400 });

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkIpLimit(env, { binding: cfg.ipLimitBinding, ip });
  if (!rate.allowed) return new Response('Too many requests', { status: 429 });

  const { status, body, cache } = await handleLookup(env, {
    provider,
    name,
    signal: request.signal,
  });
  const headers = {};
  if (status === 200) headers['Content-Type'] = 'application/json';
  if (cache) headers['X-Cache'] = cache;
  return new Response(body, { status, headers });
}
