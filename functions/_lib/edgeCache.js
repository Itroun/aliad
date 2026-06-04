// Shared L2 cache that sits in front of the upstream APIs, inside the proxy
// Functions. It caches raw upstream JSON keyed by upstream URL so the first
// visitor to look up an artist warms the cache for everyone. See
// PHASE1B_SHARED_CACHE_PLAN.md.

// Bump to invalidate every stored entry at once (old keys TTL out; no migration).
export const CACHE_VERSION = 1;

// Freshness windows, mirroring the Phase 1 browser cache. Aliases/members/groups
// are high-stability, so non-empty results live long; empties are re-checked
// sooner in case the artist gets added upstream. Each proxy supplies a `ttlFor`
// that picks between these based on its own no-result shape.
export const TTL_NONEMPTY_SEC = 30 * 24 * 3600;
export const TTL_EMPTY_SEC = 7 * 24 * 3600;

// How long past freshness we keep an entry around purely so it can be served
// STALE if the upstream is unreachable. The KV record lives for ttl + this.
const STALE_GRACE_SEC = 7 * 24 * 3600;

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cacheKey(provider, upstreamUrl) {
  return `httpcache:${CACHE_VERSION}:${provider}:${await sha256Hex(upstreamUrl)}`;
}

function toResponse(entry, label) {
  return new Response(entry.body, {
    status: entry.status,
    headers: { 'Content-Type': 'application/json', 'X-Cache': label },
  });
}

function withCacheHeader(response, label) {
  const headers = new Headers(response.headers);
  headers.set('X-Cache', label);
  return new Response(response.body, { status: response.status, headers });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Wrap an upstream fetch with the shared KV cache.
 *
 * @param env Cloudflare env (expects env.KV; degrades to pass-through if absent).
 * @param provider     short provider tag for the key namespace ('musicbrainz' | 'discogs').
 * @param upstreamUrl  full canonical upstream URL — the cache key input.
 * @param upstreamFn   () => Promise<Response>, called only on miss/expiry.
 * @param ttlFor       (parsedBody) => seconds; lets the proxy pick empty vs non-empty TTL.
 * @param now          injectable clock (ms) for testing.
 * @returns { response, cache: 'HIT' | 'MISS' | 'STALE' | 'BYPASS' }
 */
export async function cachedFetch(
  env,
  { provider, upstreamUrl, upstreamFn, ttlFor, now = Date.now },
) {
  // Degraded: no KV bound → behave as a pure pass-through, same posture as kvLimit.
  if (!env?.KV) {
    return { response: withCacheHeader(await upstreamFn(), 'BYPASS'), cache: 'BYPASS' };
  }

  const key = await cacheKey(provider, upstreamUrl);

  let stored = null;
  try {
    const raw = await env.KV.get(key);
    if (raw) {
      const parsed = safeParse(raw);
      if (parsed && parsed.v === CACHE_VERSION) stored = parsed;
    }
  } catch {
    // KV read failed — treat as a miss.
  }

  if (stored && now() < stored.expiresAt) {
    return { response: toResponse(stored, 'HIT'), cache: 'HIT' };
  }

  // Miss or expired: hit the upstream. On any failure, fall back to a stale
  // entry if we still have one.
  let upstream;
  try {
    upstream = await upstreamFn();
  } catch (err) {
    if (stored) return { response: toResponse(stored, 'STALE'), cache: 'STALE' };
    throw err;
  }

  if (!upstream.ok) {
    if (stored) return { response: toResponse(stored, 'STALE'), cache: 'STALE' };
    return { response: withCacheHeader(upstream, 'MISS'), cache: 'MISS' };
  }

  const body = await upstream.text();
  let ttl;
  try {
    ttl = ttlFor(safeParse(body));
  } catch {
    ttl = STALE_GRACE_SEC;
  }
  const fetchedAt = now();
  const entry = {
    v: CACHE_VERSION,
    status: upstream.status,
    body,
    fetchedAt,
    expiresAt: fetchedAt + ttl * 1000,
  };
  try {
    await env.KV.put(key, JSON.stringify(entry), { expirationTtl: ttl + STALE_GRACE_SEC });
  } catch {
    // Write failed (e.g. budget) — still serve the fresh body this request.
  }
  return { response: toResponse(entry, 'MISS'), cache: 'MISS' };
}
