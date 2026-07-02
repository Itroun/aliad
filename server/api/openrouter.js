import { checkRateLimit, checkDailyCeiling, incrementDailyCeiling } from '../_lib/kvLimit.js';
import { ARTIST_SCHEMA, systemPromptFor } from '../../src/core/extractPrompt.js';
import { parseArtists, runExtraction } from '../../src/core/extractCore.js';

// Artist-extraction proxy. The client sends ONLY { kind, content } — the text to
// extract from plus which prompt applies. The SERVER owns everything else: the
// system prompt, the strict reply schema, the token cap, AND the model tier. It
// runs the cheap model first and escalates to the expensive one only when the
// result looks weak (src/core/extractCore.js). So the endpoint can't be
// repurposed as a general-purpose LLM, and — unlike the old contract — a caller
// can't name the expensive model to dial up our spend: the reply is always a
// schema-caged artist list, produced cheap-first.
//
// We inject the key, apply a per-IP minute rate limit, a per-IP daily sub-cap,
// and a global daily ceiling. The ceiling counts actual upstream model CALLS
// (not requests), so an escalation correctly draws down two units of budget.
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOKENS_CAP = 4096;
// Upper bound on the text we'll hand the LLM. fetch-page caps a scraped page at
// 1 MB raw, and cleanHTML / reader output are smaller still, so real lineups sit
// far below this; the cap exists to bound per-call token cost against a caller
// posting a pathological blob straight to this endpoint. Well above the largest
// real bake-off sample (~101k chars).
const MAX_CONTENT_CHARS = 600_000;
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 60;
// Global per-day ceiling on upstream model CALLS (a cheap+fallback extraction is
// two). The env var keeps its historical name for compatibility.
const DEFAULT_DAILY_REQUEST_LIMIT = 300;
const DAILY_COUNTER_KEY = 'openrouter:usage';
// Per-IP daily sub-cap: no single source can eat the whole day's budget. Counts
// extraction REQUESTS (each up to two model calls). Generous to tolerate shared
// NAT / CGNAT; the global call-ceiling above is the real cost backstop.
const PER_IP_DAILY_LIMIT = 40;
const DAY_SEC = 86_400;

// Validate the client payload. Pure so the contract (only { kind, content }, size
// capped) is unit-testable without env. Returns { error } or { ok: true }.
export function validateExtractionInput(body) {
  const { kind, content } = body ?? {};
  if (kind !== 'html' && kind !== 'text') {
    return { error: { status: 400, message: 'Invalid kind (expected "html" or "text")' } };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { error: { status: 400, message: 'Missing or empty content' } };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return { error: { status: 413, message: 'Content too large' } };
  }
  return { ok: true };
}

// Build the caged OpenRouter payload for a given SERVER-chosen model. The model
// is never taken from the client (that's the point of server-side selection).
export function buildPayload(model, { kind, content }) {
  return {
    model,
    max_tokens: MAX_TOKENS_CAP,
    response_format: ARTIST_SCHEMA,
    messages: [
      { role: 'system', content: systemPromptFor(kind) },
      { role: 'user', content },
    ],
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

  const valid = validateExtractionInput(body);
  if (valid.error) {
    return new Response(valid.error.message, { status: valid.error.status });
  }
  const { kind, content } = body;

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

  // Run one upstream model call: cage the request, forward it, parse the reply.
  // Throws on a non-ok upstream (without echoing its body — we never leak the
  // provider's error detail to our client) or an unparseable completion, so
  // runExtraction treats it as a failed attempt and can escalate. A completion
  // that came back ok is billed regardless of parse outcome, so it counts.
  const meta = { calls: [] };
  let billedCalls = 0;
  const runModel = async (model) => {
    const start = Date.now();
    const upstream = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        // OpenRouter attribution headers — surfaced on their dashboard / rankings.
        'HTTP-Referer': env.OPENROUTER_REFERER || 'https://aliad.app',
        'X-Title': 'aliad',
      },
      body: JSON.stringify(buildPayload(model, { kind, content })),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    billedCalls += 1;
    const data = await upstream.json();
    const artists = parseArtists(data?.choices?.[0]?.message?.content ?? '');
    meta.calls.push({ model, outputArtists: artists.length, durationMs: Date.now() - start });
    return { artists };
  };

  let result;
  try {
    result = await runExtraction({ inputChars: content.length, runModel });
  } catch {
    // Every model attempt failed. Charge for any completions we were billed for,
    // then return a generic error — never the upstream's body.
    if (billedCalls > 0) {
      context.waitUntil?.(incrementDailyCeiling(env, ceiling.storageKey, billedCalls));
    }
    return new Response('Extraction failed', { status: 502 });
  }

  if (billedCalls > 0) {
    context.waitUntil?.(incrementDailyCeiling(env, ceiling.storageKey, billedCalls));
  }

  return Response.json({ artists: result.artists, meta });
}
