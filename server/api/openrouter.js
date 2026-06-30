import { checkRateLimit, checkDailyCeiling, incrementDailyCeiling } from '../_lib/kvLimit.js';
import { ALLOWED_MODELS } from '../../src/core/models.js';
import { ARTIST_SCHEMA, systemPromptFor } from '../../src/core/extractPrompt.js';

// Artist-extraction proxy. The client sends ONLY { model, kind, content } — the
// text to extract from plus which prompt/model tier. The server builds the whole
// OpenRouter request (system prompt + strict reply schema + token cap), so the
// endpoint can't be repurposed as a general-purpose LLM: it always returns a
// schema-caged artist list. We inject the key, enforce the model allowlist, and
// apply a per-IP minute rate limit, a per-IP daily sub-cap, and a global daily
// ceiling (the last two so no single client can drain the day's budget).
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOKENS_CAP = 4096;
// Loose guard against pathological blobs; sits above fetch-page's 1 MB page cap
// so a legitimately large scraped lineup page is never rejected.
const MAX_CONTENT_CHARS = 1_200_000;
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 60;
const DEFAULT_DAILY_REQUEST_LIMIT = 300;
const DAILY_COUNTER_KEY = 'openrouter:usage';
// Per-IP daily sub-cap under the global ceiling: no single source can eat the
// whole day's budget. Generous to tolerate shared NAT / CGNAT (many real users
// behind one IP). Tunable; well below the global DEFAULT_DAILY_REQUEST_LIMIT.
const PER_IP_DAILY_LIMIT = 40;
const DAY_SEC = 86_400;

// Pure request builder so the contract (and its security properties — no
// arbitrary messages, schema enforced, token cap) is unit-testable without env.
// Returns { payload } to forward, or { error: { status, message } }.
export function buildExtractionRequest(body) {
  const { model, kind, content } = body ?? {};
  if (!ALLOWED_MODELS.includes(model)) {
    return {
      error: {
        status: 400,
        message: `Model not allowed. Use one of: ${ALLOWED_MODELS.join(', ')}`,
      },
    };
  }
  if (kind !== 'html' && kind !== 'text') {
    return { error: { status: 400, message: 'Invalid kind (expected "html" or "text")' } };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { error: { status: 400, message: 'Missing or empty content' } };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return { error: { status: 413, message: 'Content too large' } };
  }
  return {
    payload: {
      model,
      max_tokens: MAX_TOKENS_CAP,
      response_format: ARTIST_SCHEMA,
      messages: [
        { role: 'system', content: systemPromptFor(kind) },
        { role: 'user', content },
      ],
    },
  };
}

export async function handle(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const rate = await checkRateLimit(env, {
    scope: 'openrouter',
    ip,
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!rate.allowed) {
    return new Response('Too many requests', { status: 429 });
  }

  const dailyLimit = Number(env.OPENROUTER_DAILY_REQUEST_LIMIT) || DEFAULT_DAILY_REQUEST_LIMIT;
  const ceiling = await checkDailyCeiling(env, { key: DAILY_COUNTER_KEY, limit: dailyLimit });
  if (!ceiling.allowed) {
    return new Response('Daily request budget exhausted', { status: 503 });
  }

  if (!env.OPENROUTER_API_KEY) {
    return new Response('OpenRouter API key not configured', { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const built = buildExtractionRequest(body);
  if (built.error) {
    return new Response(built.error.message, { status: built.error.status });
  }

  // Per-IP daily sub-cap (Lever C) — checked only for well-formed extraction
  // requests so a malformed one doesn't consume a client's daily allowance.
  const perIp = await checkRateLimit(env, {
    scope: 'openrouter:daily',
    ip,
    limit: PER_IP_DAILY_LIMIT,
    windowSec: DAY_SEC,
  });
  if (!perIp.allowed) {
    return new Response('Daily per-client request budget reached', { status: 429 });
  }

  const upstream = await fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      // OpenRouter attribution headers — surfaced on their dashboard / rankings.
      'HTTP-Referer': env.OPENROUTER_REFERER || 'https://aliad.app',
      'X-Title': 'aliad',
    },
    body: JSON.stringify(built.payload),
  });

  if (upstream.ok) {
    context.waitUntil?.(incrementDailyCeiling(env, ceiling.storageKey));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    },
  });
}
