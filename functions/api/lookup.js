// Unified server lookup endpoint (Phase 2b). GET /api/lookup?provider=&name=
//
// Supersedes the per-HTTP-call edge cache (Phase 1b): instead of caching raw
// upstream JSON keyed by URL, this does the full search + details + map
// server-side and caches ONE mapped result per (provider, normalisedName) — the
// same key shape and value shape as the L1 browser cache (src/core/cache.js).
// L1 and L2 are now two tiers of the same cache, governed by one SCHEMA_VERSION.
//
// Far fewer KV writes than 1b (one per artist, not one per upstream HTTP call),
// which directly eases the write-budget pressure flagged in PHASE1B.
// See PHASE2B_MAPPED_CACHE_PLAN.md.

import { checkRateLimit } from '../_lib/kvLimit.js';
import { SCHEMA_VERSION } from '../../src/core/schemaVersion.js';
import { normaliseName } from '../../src/core/merge.js';
import { fetchWithRetry } from '../../src/core/fetchWithRetry.js';
import { emptyResult } from '../../src/providers/provider.js';
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
// Extra lifetime past freshness so an expired entry can still be served STALE
// when the upstream is unreachable. KV record lives for ttl + this.
const STALE_GRACE_SEC = 7 * DAY;

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

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
  const searchData = await getJson(cfg.searchUrl(name), headers, fetchFn, cfg.retry, sleep);
  const match = cfg.pickMatch(searchData, name);
  if (!match) return emptyResult();
  const details = await getJson(cfg.detailsUrl(match.id), headers, fetchFn, cfg.retry, sleep);
  return cfg.mapDetails(details);
}

/**
 * Cached lookup core, separated from request plumbing for testability.
 * @returns { status, body, cache } — body is a string; cache is the X-Cache label.
 */
export async function handleLookup(
  env,
  { provider, name, fetchFn = fetch, sleep, now = Date.now },
) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return { status: 400, body: 'Unknown provider', cache: null };
  if (cfg.requiresToken && !env?.DISCOGS_TOKEN) {
    return { status: 500, body: 'Discogs token not configured', cache: null };
  }

  const ok = (result, cache) => ({ status: 200, body: JSON.stringify(result), cache });
  const nameKey = normaliseName(name);
  if (!nameKey) return ok(emptyResult(), 'BYPASS');

  // Degraded: no KV bound → straight upstream, no caching (same posture as kvLimit).
  if (!env?.KV) {
    return ok(await lookupUpstream(cfg, env, name, fetchFn, sleep), 'BYPASS');
  }

  const key = `lookup:${SCHEMA_VERSION}:${provider}:${nameKey}`;
  let stored = null;
  try {
    const raw = await env.KV.get(key);
    if (raw) {
      const parsed = safeParse(raw);
      if (parsed && parsed.v === SCHEMA_VERSION) stored = parsed;
    }
  } catch {
    // KV read failed — treat as a miss.
  }

  if (stored && now() < stored.expiresAt) {
    return ok(stored.result, 'HIT');
  }

  let result;
  try {
    result = await lookupUpstream(cfg, env, name, fetchFn, sleep);
  } catch (err) {
    // Stale-on-error: serve a prior (expired) entry rather than failing.
    if (stored) return ok(stored.result, 'STALE');
    return { status: 502, body: 'Upstream lookup failed', cache: null };
  }

  const isEmpty = isResultEmpty(result);
  const ttl = isEmpty ? TTL_EMPTY_SEC : TTL_NONEMPTY_SEC;
  const fetchedAt = now();
  const entry = {
    v: SCHEMA_VERSION,
    result,
    isEmpty,
    fetchedAt,
    expiresAt: fetchedAt + ttl * 1000,
  };
  try {
    await env.KV.put(key, JSON.stringify(entry), { expirationTtl: ttl + STALE_GRACE_SEC });
  } catch {
    // Write failed (e.g. budget) — still serve the fresh result this request.
  }
  return ok(result, 'MISS');
}

export async function onRequest(context) {
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
