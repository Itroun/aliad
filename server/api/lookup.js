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
// substrate for Phase 3 (server-side closure queries). KV stays, but now only
// for rate limiting + the Anthropic ceiling. See ARCHITECTURE.md.

import { checkRateLimit } from '../_lib/kvLimit.js';
import { awaitDiscogsSlot } from '../_lib/rateGate.js';
import { makeD1Store } from '../_lib/quadStore.js';
import { SCHEMA_VERSION } from '../../src/core/schemaVersion.js';
import { normaliseName } from '../../src/core/merge.js';
import { fetchWithRetry } from '../../src/core/fetchWithRetry.js';
import { emptyResult } from '../../src/providers/provider.js';
import { resultToQuads, quadsToResult, sourceKeyFor } from '../../src/core/quads.js';
import * as mb from '../../src/providers/musicbrainz.map.js';
import * as discogs from '../../src/providers/discogs.map.js';

// MB wants a descriptive UA; the browser forbids setting it, which is one reason
// these calls are proxied server-side (see CLAUDE.md rate-limits note).
const USER_AGENT = 'aka/0.1 (+https://alsoknownas.music)';

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
    // Per-IP abuse cap, NOT MB's global 1/sec (can't be enforced per-IP; left
    // best-effort to the client queue). One lineup run fans out many lookups
    // via the identity-graph walk, so the window has generous headroom.
    rateLimit: { scope: 'musicbrainz', limit: 120, windowSec: 60 },
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
    rateLimit: { scope: 'discogs', limit: 60, windowSec: 60 },
    // Gate upstream calls through the global RateLimiter DO. MB is left
    // best-effort (CLAUDE.md rate-limits note); only Discogs 429s in practice.
    gated: true,
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

async function getJson(url, headers, fetchFn, retry, sleep) {
  const result = await fetchWithRetry(url, { headers }, { fetchFn, sleep, ...(retry ?? {}) });
  if (!result.ok) throw new Error(`upstream ${result.status ?? result.reason} for ${url}`);
  return result.response.json();
}

// The full pure pipeline: search → pick best candidate → details → map. Runs
// the same selection/mapping as the browser used to, now server-side.
async function lookupUpstream(cfg, env, name, fetchFn, sleep) {
  const headers = cfg.headers(env);
  // Each upstream HTTP request consumes one slot from the global gate, so the
  // budget tracks what Discogs actually counts (search AND details).
  const gate = () => (cfg.gated ? awaitDiscogsSlot(env, { sleep }) : undefined);
  await gate();
  const searchData = await getJson(cfg.searchUrl(name), headers, fetchFn, cfg.retry, sleep);
  const match = cfg.pickMatch(searchData, name);
  if (!match) return emptyResult();
  await gate();
  const details = await getJson(cfg.detailsUrl(match.id), headers, fetchFn, cfg.retry, sleep);
  return cfg.mapDetails(details);
}

/**
 * Cached lookup core, separated from request plumbing for testability.
 * @returns { status, body, cache } — body is a string; cache is the X-Cache label.
 */
export async function handleLookup(
  env,
  { provider, name, fetchFn = fetch, sleep, now = Date.now, store },
) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return { status: 400, body: 'Unknown provider', cache: null };
  if (cfg.requiresToken && !env?.DISCOGS_TOKEN) {
    return { status: 500, body: 'Discogs token not configured', cache: null };
  }

  const ok = (result, cache) => ({ status: 200, body: JSON.stringify(result), cache });
  const nameKey = normaliseName(name);
  if (!nameKey) return ok(emptyResult(), 'BYPASS');

  // store is injectable for tests; default to the D1-backed adapter when bound.
  const graph = store ?? (env?.DB ? makeD1Store(env.DB) : null);

  // Degraded: no D1 bound → straight upstream, no caching (same posture as kvLimit).
  if (!graph) {
    return ok(await lookupUpstream(cfg, env, name, fetchFn, sleep), 'BYPASS');
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
    result = await lookupUpstream(cfg, env, name, fetchFn, sleep);
  } catch (err) {
    // Stale-on-error: serve a prior (expired) entry's quads rather than failing.
    if (lookupRow) {
      try {
        return ok(await reconstitute(), 'STALE');
      } catch {
        // fall through to the 502 below
      }
    }
    return { status: 502, body: 'Upstream lookup failed', cache: null };
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
  return ok(result, 'MISS');
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
  const rate = await checkRateLimit(env, { ...cfg.rateLimit, ip });
  if (!rate.allowed) return new Response('Too many requests', { status: 429 });

  const { status, body, cache } = await handleLookup(env, { provider, name });
  const headers = {};
  if (status === 200) headers['Content-Type'] = 'application/json';
  if (cache) headers['X-Cache'] = cache;
  return new Response(body, { status, headers });
}
