import { parseLineup } from '../ui/inputScreen.js';
import { dedupeNames } from './merge.js';

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
    (line) => /^\s*[•\-\*]\s/.test(line) || /^\s*\d+[\.\)]\s/.test(line),
  );
  if (hasBullets) return 'messy';

  const hasProseLines = lines.filter((l) => l.trim().length > 80).length >= 2;
  if (hasProseLines) return 'messy';

  const avgLength = lines.reduce((sum, l) => sum + l.trim().length, 0) / lines.length;
  if (avgLength > 60) return 'messy';

  return 'clean';
}

// Resolve a chunk of input to a list of act names. Clean one-per-line text is
// parsed locally; anything messy (loose text or scraped HTML) goes to the
// extraction proxy. The proxy now owns model-tier selection — it tries the cheap
// model and escalates to the stronger one server-side — so we send only
// { kind, content } and read back the finished artist list plus per-call meta
// for the dev-probe.
export async function extractArtists(content, { type, signal, fetchFn = fetch, onCall } = {}) {
  if (type === 'clean-text') {
    return { artists: parseLineup(content) };
  }

  if (!content?.trim()) {
    return { artists: [] };
  }

  const kind = type === 'html' ? 'html' : 'text';
  const trimmed = content.trim();

  const { artists, meta } = await callExtract({ kind, content: trimmed }, { signal, fetchFn });

  // Surface each server-side model call to the dev-probe (0, 1, or 2 of them).
  if (onCall && Array.isArray(meta?.calls)) {
    for (const call of meta.calls) {
      onCall({
        model: call.model,
        inputChars: trimmed.length,
        outputArtists: call.outputArtists,
        durationMs: call.durationMs,
      });
    }
  }

  return { artists: Array.isArray(artists) ? artists : [] };
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

// POST the text to the extraction proxy and read back { artists, meta }. The
// server owns the system prompt, reply schema, model allowlist, token cap AND
// the cheap→expensive tier selection — we send only the prompt kind and the text
// to extract from. So the endpoint stays a narrow extractor (no arbitrary
// messages, no client-chosen model) and can't be abused as a free LLM.
export async function callExtract({ kind, content }, { signal, fetchFn = fetch } = {}) {
  const response = await fetchFn('/api/openrouter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ kind, content }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM proxy returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  return {
    artists: Array.isArray(data?.artists) ? data.artists : [],
    meta: data?.meta,
  };
}
