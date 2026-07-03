// Artist-extraction prompts + the strict reply schema, isolated in a UI-free
// module so the Worker (server/api/openrouter.js) can own prompt construction
// without importing the browser extractor — src/core/extract.js pulls in UI code
// (inputScreen.js) that can't run in a Worker. The browser extractor and the
// bake-off (scripts/bakeoff.mjs) re-export / import these, so there's one source
// of truth for the prompts the server applies and the bake-off scores.

export const SYSTEM_PROMPT_TEXT = `You extract artist and performer names from text related to music festivals or events.

Return a JSON object with:
- "artists": array of artist/performer name strings

Rules:
- Include only artist/performer/DJ/band names — not venues, cities, or event names
- Exclude record labels and label showcases, even when billed like acts (e.g. "Something Rec", "Something Records")
- For collaborative acts like "X vs Y", "X & Y", "X b2b Y", return the combined name as-is
- Strip set type annotations: "(DJ Set)", "(Live)", "(Producer Set)", etc.
- Strip country/label tags glued onto a name: "Some Artist_DE" → "Some Artist"
- If a name appears in different forms, pick the most complete version
- Return valid JSON only, no markdown fencing`;

export const SYSTEM_PROMPT_HTML = `You extract artist and performer names from text scraped from a music festival or event webpage.

Return a JSON object with:
- "artists": array of artist/performer name strings

Rules:
- Include only artist/performer/DJ/band names — not venues, cities, or event names
- Exclude record labels and label showcases, even when billed like acts (e.g. "Something Rec", "Something Records")
- For collaborative acts like "X vs Y", "X & Y", "X b2b Y", return the combined name as-is
- Strip set type annotations: "(DJ Set)", "(Live)", "(Producer Set)", etc.
- Strip country/label tags glued onto a name: "Some Artist_DE" → "Some Artist"
- If a name appears in different forms, pick the most complete version
- Return valid JSON only, no markdown fencing`;

// Force the reply into { artists: string[] }. Without this, larger/noisier pages
// pushed the extraction model into a prose preamble + markdown fence and, worse,
// echoing a {name,url} object per artist — bloating output past max_tokens so the
// JSON truncated and parsing threw (silently dropping the page). A strict schema
// keeps it to a flat string array, which both fixes the shape and stops the bloat.
// It's also what makes the proxy safe to expose: the reply is caged to an artist
// list, so the endpoint can't be repurposed as a general-purpose LLM.
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

// kind: 'html' for text scraped from a webpage, 'text' for pasted/messy lineup
// text. Any other value falls back to the text prompt.
export function systemPromptFor(kind) {
  return kind === 'html' ? SYSTEM_PROMPT_HTML : SYSTEM_PROMPT_TEXT;
}
