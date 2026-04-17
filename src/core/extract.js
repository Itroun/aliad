import { parseLineup } from '../ui/input.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT_TEXT = `You extract artist and performer names from text related to music festivals or events.

Return a JSON object with:
- "artists": array of artist/performer name strings
- "discoveredAliases": array of { "artist": string, "aliases": string[] } for any alias, side-project, or group relationships mentioned

Rules:
- Include only artist/performer/DJ/band names — not venues, labels, cities, or event names
- For collaborative acts like "X vs Y", "X & Y", "X b2b Y", return the combined name as-is
- Strip set type annotations: "(DJ Set)", "(Live)", "(Producer Set)", etc.
- If a name appears in different forms, pick the most complete version
- Return valid JSON only, no markdown fencing`;

const SYSTEM_PROMPT_HTML = `You extract artist and performer names from text scraped from a music festival or event webpage.

Return a JSON object with:
- "artists": array of artist/performer name strings
- "discoveredAliases": array of { "artist": string, "aliases": string[] } for any alias, side-project, or group relationships mentioned in descriptions

Rules:
- Include only artist/performer/DJ/band names — not venues, labels, cities, or event names
- For collaborative acts like "X vs Y", "X & Y", "X b2b Y", return the combined name as-is
- Strip set type annotations: "(DJ Set)", "(Live)", "(Producer Set)", etc.
- If a name appears in different forms, pick the most complete version
- Pay close attention to descriptions that mention aliases, real names, side projects, or group memberships
- Return valid JSON only, no markdown fencing`;

export function detectInputType(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim());
  if (!lines.length) return 'clean';

  const hasCommaSeparatedNames = lines.some((line) => /,\s*[A-Z]/.test(line));
  if (hasCommaSeparatedNames) return 'messy';

  const hasBullets = lines.some((line) => /^\s*[\u2022\-\*]\s/.test(line) || /^\s*\d+[\.\)]\s/.test(line));
  if (hasBullets) return 'messy';

  const hasProseLines = lines.filter((l) => l.trim().length > 80).length >= 2;
  if (hasProseLines) return 'messy';

  const avgLength = lines.reduce((sum, l) => sum + l.trim().length, 0) / lines.length;
  if (avgLength > 60) return 'messy';

  return 'clean';
}

export async function extractArtists(content, { type, signal, fetchFn = fetch }) {
  if (type === 'clean-text') {
    return { artists: parseLineup(content), discoveredAliases: [] };
  }

  if (!content?.trim()) {
    return { artists: [], discoveredAliases: [] };
  }

  const systemPrompt = type === 'html' ? SYSTEM_PROMPT_HTML : SYSTEM_PROMPT_TEXT;

  const messages = [{ role: 'user', content: content.trim() }];

  let result = await callLLM(
    { system: systemPrompt, messages, model: HAIKU },
    { signal, fetchFn },
  );

  if (!result.artists?.length && content.trim().length > 20) {
    result = await callLLM(
      { system: systemPrompt, messages, model: SONNET },
      { signal, fetchFn },
    );
  }

  return {
    artists: Array.isArray(result.artists) ? result.artists : [],
    discoveredAliases: Array.isArray(result.discoveredAliases) ? result.discoveredAliases : [],
  };
}

export async function callLLM({ system, messages, model }, { signal, fetchFn = fetch }) {
  const response = await fetchFn('/api/anthropic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ model, max_tokens: 4096, system, messages }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM proxy returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = data?.content?.[0]?.text ?? '';

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
