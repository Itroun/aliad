import { checkRateLimit, checkDailyCeiling, incrementDailyCeiling } from '../_lib/kvLimit.js';
import { ALLOWED_MODELS } from '../../src/core/models.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS_CAP = 4096;
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 60;
const DEFAULT_DAILY_REQUEST_LIMIT = 300;
const DAILY_COUNTER_KEY = 'anthropic:usage';

export async function handle(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const rate = await checkRateLimit(env, {
    scope: 'anthropic',
    ip,
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!rate.allowed) {
    return new Response('Too many requests', { status: 429 });
  }

  const dailyLimit = Number(env.ANTHROPIC_DAILY_REQUEST_LIMIT) || DEFAULT_DAILY_REQUEST_LIMIT;
  const ceiling = await checkDailyCeiling(env, { key: DAILY_COUNTER_KEY, limit: dailyLimit });
  if (!ceiling.allowed) {
    return new Response('Daily request budget exhausted', { status: 503 });
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
    return new Response(`Model not allowed. Use one of: ${ALLOWED_MODELS.join(', ')}`, {
      status: 400,
    });
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
