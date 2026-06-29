import { checkRateLimit, checkDailyCeiling, incrementDailyCeiling } from '../_lib/kvLimit.js';
import { ALLOWED_MODELS } from '../../src/core/models.js';

// OpenAI-compatible chat-completions endpoint. The client sends an already
// OpenRouter-shaped body (model + messages incl. a system message); we inject
// the key, enforce the model allowlist, cap max_tokens, and per-IP rate-limit.
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOKENS_CAP = 4096;
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 60;
const DEFAULT_DAILY_REQUEST_LIMIT = 300;
const DAILY_COUNTER_KEY = 'openrouter:usage';

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

  if (!body.model || !Array.isArray(body.messages)) {
    return new Response('Missing required fields: model, messages', { status: 400 });
  }

  if (!ALLOWED_MODELS.includes(body.model)) {
    return new Response(`Model not allowed. Use one of: ${ALLOWED_MODELS.join(', ')}`, {
      status: 400,
    });
  }

  body.max_tokens = Math.min(body.max_tokens ?? MAX_TOKENS_CAP, MAX_TOKENS_CAP);

  const upstream = await fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      // OpenRouter attribution headers — surfaced on their dashboard / rankings.
      'HTTP-Referer': env.OPENROUTER_REFERER || 'https://aliad.app',
      'X-Title': 'aliad',
    },
    body: JSON.stringify(body),
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
