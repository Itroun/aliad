import { fetchWithRetry } from '../../src/core/fetchWithRetry.js';
import { checkRateLimit } from '../_lib/kvLimit.js';

export { fetchWithRetry };

const MAX_RESPONSE_BYTES = 1_048_576;
const CHALLENGE_SNIFF_BYTES = 16_384;
const OVERALL_TIMEOUT_MS = 30_000;
const READER_TIMEOUT_MS = 15_000;
const RATE_LIMIT = 10;
const RATE_WINDOW_SEC = 60;

export const CHROME_HEADERS = {
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

export function looksLikeChallenge(text) {
  if (!text) return false;
  for (const marker of CHALLENGE_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env, {
    scope: 'fetch-page',
    ip,
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
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

  let result;
  try {
    result = await fetchWithRetry(
      parsed.toString(),
      { headers: CHROME_HEADERS, redirect: 'follow' },
      { signal: controller.signal },
    );
  } catch (err) {
    clearTimeout(timeout);
    return new Response(`Fetch aborted: ${err.message}`, {
      status: 504,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  clearTimeout(timeout);

  if (!result.ok) {
    return new Response(result.reason, {
      status: 502,
      headers: { ...attemptsHeader(result.attempts), 'Content-Type': 'text/plain' },
    });
  }

  const upstream = result.response;
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

  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'text/html',
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
