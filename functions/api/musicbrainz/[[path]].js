import { checkRateLimit } from '../../_lib/kvLimit.js';
import { cachedFetch, TTL_NONEMPTY_SEC, TTL_EMPTY_SEC } from '../../_lib/edgeCache.js';

// Only the web-service v2 artist endpoints are reachable (search + details).
const ALLOWED_PREFIXES = ['ws/2/artist'];
const MB_BASE = 'https://musicbrainz.org';
// MB wants a descriptive UA; the browser forbids setting it, which is the whole
// reason MB is proxied here (see CLAUDE.md rate-limits note).
const USER_AGENT = 'aka/0.1 (+https://alsoknownas.music)';
// Per-IP abuse cap, NOT MB's global 1 req/sec — that can't be enforced per-IP
// and is best-effort-honoured by the client queue + this cache. One lineup run
// legitimately bursts ~1.7 MB calls/sec (each lookup fires a search + a details
// back-to-back), so a literal 1/sec cap would 429 the details half of every
// lookup. A per-minute window with headroom caps a runaway client without
// breaking normal traffic. Cache HITs are counted too (the limit precedes the
// cache), so the ceiling is generous on purpose.
const RATE_LIMIT = 120;
const RATE_WINDOW_SEC = 60;

// MB returns `{ artists: [...] }` for a search and an artist object (with
// `aliases` / `relations`) for a details lookup. An empty result is no search
// hits, or a details record with neither aliases nor relations.
function ttlFor(body) {
  if (!body) return TTL_NONEMPTY_SEC;
  const empty = Array.isArray(body.artists)
    ? body.artists.length === 0
    : (body.aliases?.length ?? 0) === 0 && (body.relations?.length ?? 0) === 0;
  return empty ? TTL_EMPTY_SEC : TTL_NONEMPTY_SEC;
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env, {
    scope: 'musicbrainz',
    ip,
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!rate.allowed) {
    return new Response('Too many requests', { status: 429 });
  }

  const subPath = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '');
  if (!ALLOWED_PREFIXES.some((prefix) => subPath.startsWith(prefix))) {
    return new Response('Forbidden', { status: 403 });
  }

  const incoming = new URL(request.url);
  const target = new URL(`${MB_BASE}/${subPath}`);
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  const upstreamUrl = target.toString();

  const { response } = await cachedFetch(env, {
    provider: 'musicbrainz',
    upstreamUrl,
    ttlFor,
    upstreamFn: () =>
      fetch(upstreamUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      }),
  });
  return response;
}
