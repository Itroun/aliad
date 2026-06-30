import { parseLineup } from '../ui/inputScreen.js';
import { dedupeNames } from './merge.js';
import { PRIMARY, FALLBACK } from './models.js';

// Prompts + reply schema live in a UI-free module so the Worker can apply the
// same prompt server-side (it builds the LLM request now, not the client).
// Re-exported here for the bake-off (scripts/bakeoff.mjs) and tests.
export { SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_HTML, ARTIST_SCHEMA } from './extractPrompt.js';

export function detectInputType(text) {
  const lines = String(text ?? '')
    .split('\n')
    .filter((l) => l.trim());
  if (!lines.length) return 'clean';

  const hasCommaSeparatedNames = lines.some((line) => /,\s*[A-Z]/.test(line));
  if (hasCommaSeparatedNames) return 'messy';

  const hasBullets = lines.some(
    (line) => /^\s*[\u2022\-\*]\s/.test(line) || /^\s*\d+[\.\)]\s/.test(line),
  );
  if (hasBullets) return 'messy';

  const hasProseLines = lines.filter((l) => l.trim().length > 80).length >= 2;
  if (hasProseLines) return 'messy';

  const avgLength = lines.reduce((sum, l) => sum + l.trim().length, 0) / lines.length;
  if (avgLength > 60) return 'messy';

  return 'clean';
}

export async function extractArtists(content, { type, signal, fetchFn = fetch, onCall } = {}) {
  if (type === 'clean-text') {
    return { artists: parseLineup(content) };
  }

  if (!content?.trim()) {
    return { artists: [] };
  }

  const kind = type === 'html' ? 'html' : 'text';
  const trimmed = content.trim();

  // The primary can fail outright — a noisy page makes it truncate past
  // max_tokens, leaving unparseable JSON that throws here. Treat that the same as
  // a weak result: retry with the stronger model rather than dropping the page
  // (the caller skips a thrown extraction). Only when BOTH fail do we propagate.
  let result = null;
  let primaryFailed = false;
  try {
    result = await timedCall(PRIMARY, kind, trimmed, { signal, fetchFn }, onCall, trimmed.length);
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    primaryFailed = true;
  }

  const primaryCount = Array.isArray(result?.artists) ? result.artists.length : 0;
  if (primaryFailed || looksUnderExtracted(result?.artists, trimmed.length)) {
    try {
      const fallbackResult = await timedCall(
        FALLBACK,
        kind,
        trimmed,
        { signal, fetchFn },
        onCall,
        trimmed.length,
      );
      const fallbackCount = Array.isArray(fallbackResult.artists)
        ? fallbackResult.artists.length
        : 0;
      if (primaryFailed || fallbackCount >= primaryCount) result = fallbackResult;
    } catch (err) {
      if (isAbort(err, signal) || primaryFailed) throw err;
      // Fallback failed but the primary succeeded — keep the primary result.
    }
  }

  return {
    artists: Array.isArray(result?.artists) ? result.artists : [],
  };
}

// Merge the artist lists from several extractions (e.g. one festival lineup page
// per stage) into one flat, de-duplicated lineup. `dedupeNames` is the same
// identity-normalised, trim-aware primitive `parseLineup` uses, so a name
// appearing on two pages (even spelled with different punctuation) collapses to
// one node downstream.
export function combineExtractions(lists) {
  const names = (lists ?? []).flatMap((r) => (Array.isArray(r?.artists) ? r.artists : []));
  return { artists: dedupeNames(names) };
}

// A user-cancelled run must propagate immediately, never be retried/swallowed.
function isAbort(err, signal) {
  return err?.name === 'AbortError' || !!signal?.aborted;
}

export function looksUnderExtracted(artists, inputChars) {
  const n = Array.isArray(artists) ? artists.length : 0;
  if (n === 0) return inputChars > 20;
  if (inputChars < 2000) return false;
  const expected = Math.min(20, Math.max(5, Math.floor(inputChars / 800)));
  return n < expected;
}

async function timedCall(model, kind, content, { signal, fetchFn }, onCall, inputChars) {
  const start = Date.now();
  const result = await callLLM({ model, kind, content }, { signal, fetchFn });
  onCall?.({
    model,
    inputChars,
    outputArtists: Array.isArray(result?.artists) ? result.artists.length : 0,
    durationMs: Date.now() - start,
  });
  return result;
}

export async function callLLM({ model, kind, content }, { signal, fetchFn = fetch }) {
  // The server (server/api/openrouter.js) owns the system prompt, reply schema,
  // model allowlist and token cap — we send only the model tier, the prompt kind
  // ('html' | 'text') and the text to extract from. That keeps the proxy a narrow
  // extractor (no arbitrary-message passthrough), so it can't be abused as a
  // free general-purpose LLM. The reply is still the OpenAI chat-completions
  // shape: text at choices[0].message.content.
  const response = await fetchFn('/api/openrouter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model, kind, content }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM proxy returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';

  return parseJSON(raw);
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1].trim());
    throw new Error('Failed to parse LLM response as JSON');
  }
}
