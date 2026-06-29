import { parseLineup } from '../ui/inputScreen.js';
import { dedupeNames } from './merge.js';
import { PRIMARY, FALLBACK } from './models.js';

export const SYSTEM_PROMPT_TEXT = `You extract artist and performer names from text related to music festivals or events.

Return a JSON object with:
- "artists": array of artist/performer name strings

Rules:
- Include only artist/performer/DJ/band names — not venues, labels, cities, or event names
- For collaborative acts like "X vs Y", "X & Y", "X b2b Y", return the combined name as-is
- Strip set type annotations: "(DJ Set)", "(Live)", "(Producer Set)", etc.
- If a name appears in different forms, pick the most complete version
- Return valid JSON only, no markdown fencing`;

// Force the reply into { artists: string[] }. Without this, larger/noisier pages
// pushed mistral-nemo into a prose preamble + markdown fence and, worse, echoing
// a {name,url} object per artist — bloating output past max_tokens so the JSON
// truncated and parsing threw (silently dropping the page). A strict schema keeps
// it to a flat string array, which both fixes the shape and stops the bloat.
export const ARTIST_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'artist_list',
    strict: true,
    schema: {
      type: 'object',
      properties: { artists: { type: 'array', items: { type: 'string' } } },
      required: ['artists'],
      additionalProperties: false,
    },
  },
};

export const SYSTEM_PROMPT_HTML = `You extract artist and performer names from text scraped from a music festival or event webpage.

Return a JSON object with:
- "artists": array of artist/performer name strings

Rules:
- Include only artist/performer/DJ/band names — not venues, labels, cities, or event names
- For collaborative acts like "X vs Y", "X & Y", "X b2b Y", return the combined name as-is
- Strip set type annotations: "(DJ Set)", "(Live)", "(Producer Set)", etc.
- If a name appears in different forms, pick the most complete version
- Return valid JSON only, no markdown fencing`;

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

  const systemPrompt = type === 'html' ? SYSTEM_PROMPT_HTML : SYSTEM_PROMPT_TEXT;
  const trimmed = content.trim();
  const messages = [{ role: 'user', content: trimmed }];

  // The primary can fail outright — a noisy page makes it truncate past
  // max_tokens, leaving unparseable JSON that throws here. Treat that the same as
  // a weak result: retry with the stronger model rather than dropping the page
  // (the caller skips a thrown extraction). Only when BOTH fail do we propagate.
  let result = null;
  let primaryFailed = false;
  try {
    result = await timedCall(
      PRIMARY,
      systemPrompt,
      messages,
      { signal, fetchFn },
      onCall,
      trimmed.length,
    );
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    primaryFailed = true;
  }

  const primaryCount = Array.isArray(result?.artists) ? result.artists.length : 0;
  if (primaryFailed || looksUnderExtracted(result?.artists, trimmed.length)) {
    try {
      const fallbackResult = await timedCall(
        FALLBACK,
        systemPrompt,
        messages,
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

async function timedCall(model, system, messages, { signal, fetchFn }, onCall, inputChars) {
  const start = Date.now();
  const result = await callLLM({ system, messages, model }, { signal, fetchFn });
  onCall?.({
    model,
    inputChars,
    outputArtists: Array.isArray(result?.artists) ? result.artists.length : 0,
    durationMs: Date.now() - start,
  });
  return result;
}

export async function callLLM({ system, messages, model }, { signal, fetchFn = fetch }) {
  // OpenRouter uses the OpenAI chat-completions shape: the system prompt is a
  // leading message (not a top-level `system` field), and the reply text lives
  // at choices[0].message.content (not Anthropic's content[0].text).
  const response = await fetchFn('/api/openrouter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      response_format: ARTIST_SCHEMA,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
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
