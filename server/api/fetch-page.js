import { fetchWithRetry } from '../../src/core/fetchWithRetry.js';
import { checkIpLimit } from '../_lib/ipLimit.js';

export { fetchWithRetry };

const MAX_RESPONSE_BYTES = 1_048_576;
const CHALLENGE_SNIFF_BYTES = 16_384;
const OVERALL_TIMEOUT_MS = 30_000;
const READER_TIMEOUT_MS = 15_000;
// Per-IP cap is 10/60s on the RL_FETCH_PAGE binding (wrangler.toml).
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const CHROME_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
};

const CHALLENGE_MARKERS = [
  '<title>Just a moment',
  '<title>Attention Required! | Cloudflare',
  '/cdn-cgi/challenge-platform',
  'cf-chl-opt',
  'DataDome.captchaUrl',
  'dd_cookie_test_',
  '<title>Access Denied',
  'Pardon Our Interruption',
  'This website is using a security service to protect itself',
  '<title>One moment, please',
  'Please wait while your request is being verified',
];

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

export function isBlockedHost(hostname) {
  if (!hostname) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host.includes(':')) return true;
  return false;
}

// Vet a redirect's Location against the SAME rules as the initial URL. The
// initial isBlockedHost/https check only covers the URL the user submitted; a
// permitted public host can answer with a 3xx pointing at an internal address
// (cloud metadata, localhost), so every hop has to be re-checked. Returns the
// resolved absolute URL string when allowed, or null when it must be blocked.
export function safeRedirectTarget(location, baseUrl) {
  if (!location) return null;
  let next;
  try {
    next = new URL(location, baseUrl);
  } catch {
    return null;
  }
  if (next.protocol !== 'https:') return null;
  if (isBlockedHost(next.hostname)) return null;
  return next.toString();
}

export function looksLikeChallenge(text) {
  if (!text) return false;
  for (const marker of CHALLENGE_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return false;
}

export async function handle(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkIpLimit(env, { binding: 'RL_FETCH_PAGE', ip });
  if (!rate.allowed) {
    return new Response('Too many requests', { status: 429 });
  }

  const incoming = new URL(request.url);
  const targetUrl = incoming.searchParams.get('url');
  const mode = incoming.searchParams.get('mode') || 'direct';

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

  if (isBlockedHost(parsed.hostname)) {
    return new Response('Internal URLs are not allowed', { status: 400 });
  }

  if (mode === 'reader') return handleReader(parsed);
  if (mode === 'direct') return handleDirect(parsed);
  return new Response('Invalid mode', { status: 400 });
}

function attemptsHeader(attempts) {
  return { 'X-Fetch-Attempts': JSON.stringify(attempts) };
}

async function handleDirect(parsed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);

  // Follow redirects by hand (`redirect: 'manual'`) so each hop's host is
  // re-validated by safeRedirectTarget. `redirect: 'follow'` would let an
  // allowed public host bounce us to an internal target unchecked. On Workers,
  // 'manual' surfaces the 3xx with a readable Location (not a browser-style
  // opaque redirect), so we can inspect and vet it.
  let current = parsed.toString();
  let result;
  let upstream;
  try {
    for (let hop = 0; ; hop++) {
      result = await fetchWithRetry(
        current,
        { headers: CHROME_HEADERS, redirect: 'manual' },
        { signal: controller.signal },
      );
      if (!result.ok) {
        clearTimeout(timeout);
        return new Response(result.reason, {
          status: 502,
          headers: { ...attemptsHeader(result.attempts), 'Content-Type': 'text/plain' },
        });
      }
      upstream = result.response;
      if (!REDIRECT_STATUSES.has(upstream.status)) break;

      const location = upstream.headers.get('Location');
      if (!location) break; // 3xx without a Location — treat as the final response.
      if (hop >= MAX_REDIRECTS) {
        clearTimeout(timeout);
        return new Response('Too many redirects', {
          status: 502,
          headers: { ...attemptsHeader(result.attempts), 'Content-Type': 'text/plain' },
        });
      }
      const next = safeRedirectTarget(location, current);
      if (!next) {
        clearTimeout(timeout);
        return new Response('Redirect to a disallowed URL', {
          status: 400,
          headers: { ...attemptsHeader(result.attempts), 'Content-Type': 'text/plain' },
        });
      }
      current = next;
    }
  } catch (err) {
    clearTimeout(timeout);
    return new Response(`Fetch aborted: ${err.message}`, {
      status: 504,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  clearTimeout(timeout);

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return new Response('Response too large', {
      status: 413,
      headers: attemptsHeader(result.attempts),
    });
  }

  const head = new TextDecoder('utf-8', { fatal: false }).decode(
    buf.slice(0, CHALLENGE_SNIFF_BYTES),
  );
  if (looksLikeChallenge(head)) {
    const flagged = result.attempts.map((a, idx) =>
      idx === result.attempts.length - 1 ? { ...a, challenge: true } : a,
    );
    return new Response('Bot challenge page detected', {
      status: 502,
      headers: { ...attemptsHeader(flagged), 'Content-Type': 'text/plain' },
    });
  }

  // Never echo the upstream's Content-Type. This endpoint proxies arbitrary
  // attacker-controlled pages, and the client only ever reads the body as a
  // string (cleanHTML parses it inertly). Returning the upstream `text/html`
  // would let `…/api/fetch-page?url=<evil-html>` render attacker script in OUR
  // origin if a victim navigates straight to it. Force inert text + nosniff so
  // the browser displays it, never executes it.
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment',
      ...attemptsHeader(result.attempts),
    },
  });
}

async function handleReader(parsed) {
  const readerUrl = `https://r.jina.ai/${parsed.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READER_TIMEOUT_MS);
  const attempts = [{ n: 1 }];

  let upstream;
  try {
    upstream = await fetch(readerUrl, {
      headers: {
        'User-Agent': CHROME_HEADERS['User-Agent'],
        Accept: 'text/plain, text/markdown, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timeout);
    attempts[0].error = String(err?.message || err);
    return new Response(`Reader fetch failed: ${err.message}`, {
      status: 502,
      headers: { ...attemptsHeader(attempts), 'Content-Type': 'text/plain' },
    });
  }
  clearTimeout(timeout);
  attempts[0].status = upstream.status;

  if (!upstream.ok) {
    return new Response(`Reader returned ${upstream.status}`, {
      status: 502,
      headers: { ...attemptsHeader(attempts), 'Content-Type': 'text/plain' },
    });
  }

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return new Response('Response too large', {
      status: 413,
      headers: attemptsHeader(attempts),
    });
  }

  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...attemptsHeader(attempts),
    },
  });
}
