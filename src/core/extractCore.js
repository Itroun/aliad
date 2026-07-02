// Pure, UI-free extraction logic shared by the server endpoint
// (server/api/openrouter.js) and the tests. This is where the "try the cheap
// model first, escalate to the expensive one only when the result looks weak"
// tier selection lives now — it used to run in the browser (src/core/extract.js),
// which let a caller name the model directly. Moving it server-side means the
// client sends only { kind, content } and the SERVER decides the tier, so the
// expensive model can't be dialled up for free (see server/api/openrouter.js).
//
// Kept pure (no fetch, no env) by taking an injectable `runModel(model)` so both
// the Worker and unit tests drive the same selection logic.

import { PRIMARY, FALLBACK } from './models.js';

// Parse a model's raw completion text into a flat artist array. Throws when the
// text isn't JSON (a truncated max_tokens cutoff, or prose) so the caller treats
// it as a failed model attempt and can escalate. A parsed object without an
// `artists` array yields [] — an under-extraction, not a hard failure.
export function parseArtists(text) {
  const data = parseJSON(text);
  return Array.isArray(data?.artists) ? data.artists : [];
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1].trim());
    throw new Error('Failed to parse LLM response as JSON');
  }
}

// Heuristic: does an artist list look suspiciously short for its input size? A
// noisy page can make the cheap model truncate or bail early; when it does we
// escalate to the stronger model rather than shipping a half-empty lineup.
export function looksUnderExtracted(artists, inputChars) {
  const n = Array.isArray(artists) ? artists.length : 0;
  if (n === 0) return inputChars > 20;
  if (inputChars < 2000) return false;
  const expected = Math.min(20, Math.max(5, Math.floor(inputChars / 800)));
  return n < expected;
}

/**
 * Tier selection: run PRIMARY (cheap); escalate to FALLBACK (expensive) only if
 * the primary failed outright or under-extracted, keeping whichever yielded more
 * artists. `runModel(model)` resolves to `{ artists }` or throws on a failed
 * attempt (network / non-ok upstream / unparseable reply).
 *
 * Semantics (unchanged from the former client-side orchestration):
 *   - small input, few artists  → no escalation (one call)
 *   - primary under-extracts    → escalate; keep the larger of the two
 *   - primary throws            → escalate; propagate only if BOTH throw
 *   - fallback throws, primary ok→ keep the primary result
 *
 * @returns {{ artists: string[] }}
 */
export async function runExtraction({ inputChars, runModel }) {
  let primary = null;
  let primaryFailed = false;
  try {
    primary = await runModel(PRIMARY);
  } catch {
    primaryFailed = true;
  }

  const primaryArtists = Array.isArray(primary?.artists) ? primary.artists : [];
  const primaryCount = primaryArtists.length;

  if (primaryFailed || looksUnderExtracted(primaryArtists, inputChars)) {
    try {
      const fallback = await runModel(FALLBACK);
      const fallbackArtists = Array.isArray(fallback?.artists) ? fallback.artists : [];
      // On a primary failure any fallback wins; otherwise keep the larger list.
      if (primaryFailed || fallbackArtists.length >= primaryCount) {
        return { artists: fallbackArtists };
      }
    } catch (err) {
      // Fallback failed too. If the primary also failed, both are dead — surface
      // the error. If the primary succeeded, keep it.
      if (primaryFailed) throw err;
    }
  }

  return { artists: primaryArtists };
}
