import { checkRateLimit } from '../../_lib/kvLimit.js';

const ALLOWED_PREFIXES = ['database/', 'artists/'];
const DISCOGS_BASE = 'https://api.discogs.com';
const USER_AGENT = 'aka/0.1 (+https://alsoknownas.music)';
const RATE_LIMIT = 60;
const RATE_WINDOW_SEC = 60;

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env, {
    scope: 'discogs',
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

  if (!env.DISCOGS_TOKEN) {
    return new Response('Discogs token not configured', { status: 500 });
  }

  const incoming = new URL(request.url);
  const target = new URL(`${DISCOGS_BASE}/${subPath}`);
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const upstream = await fetch(target.toString(), {
    headers: {
      Authorization: `Discogs token=${env.DISCOGS_TOKEN}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });

  const headers = {
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
  };
  const retryAfter = upstream.headers.get('Retry-After');
  if (retryAfter) headers['Retry-After'] = retryAfter;

  return new Response(upstream.body, { status: upstream.status, headers });
}
