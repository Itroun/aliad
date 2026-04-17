const MAX_RESPONSE_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = 'aka/0.1 (+https://alsoknownas.music)';
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    hits.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return new Response('Too many requests', { status: 429 });
  }

  const incoming = new URL(request.url);
  const targetUrl = incoming.searchParams.get('url');

  if (!targetUrl) {
    return new Response('Missing url parameter', { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  if (parsed.protocol !== 'https:') {
    return new Response('Only HTTPS URLs are allowed', { status: 400 });
  }

  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local')) {
    return new Response('Internal URLs are not allowed', { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html, application/xhtml+xml, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Failed to fetch URL: ${err.message}`, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    return new Response(`Upstream returned ${upstream.status}`, { status: 502 });
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'text/html';
  const contentLength = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
  if (contentLength > MAX_RESPONSE_BYTES) {
    return new Response('Response too large', { status: 413 });
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    return new Response('Response too large', { status: 413 });
  }

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}
