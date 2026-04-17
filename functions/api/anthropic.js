const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514'];
const MAX_TOKENS_CAP = 4096;
const RATE_LIMIT = 20;
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
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return new Response('Too many requests', { status: 429 });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response('Anthropic API key not configured', { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!body.model || !Array.isArray(body.messages)) {
    return new Response('Missing required fields: model, messages', { status: 400 });
  }

  if (!ALLOWED_MODELS.includes(body.model)) {
    return new Response(`Model not allowed. Use one of: ${ALLOWED_MODELS.join(', ')}`, { status: 400 });
  }

  body.max_tokens = Math.min(body.max_tokens ?? MAX_TOKENS_CAP, MAX_TOKENS_CAP);

  const upstream = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    },
  });
}
