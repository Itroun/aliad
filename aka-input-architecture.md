# aka — Input Parsing Architecture

This document extends the original project brief with the architecture for handling various input types. The basic app (paste plain text, one artist per line, look up via MusicBrainz + Discogs) is already working. This is the next phase.

## Core Architecture

The app has four layers with clean boundaries:

### 1. Input Layer
Accepts input from the user and fetches/reads the content. Determines what kind of content it is. Three input modes:

- **Pasted text** — could be clean (one per line) or messy (comma-separated, copied from a website with extra formatting, a paragraph from a social media post, etc.)
- **URL** — user provides a link. Could lead to an HTML page, an image, or a PDF. The app fetches it and determines the content type.
- **File upload** — user uploads a file. Could be an image (flyer/poster screenshot), PDF, or other format. Detect file type and pass content along.

### 2. Extraction Layer
Takes the raw content from the input layer and returns structured data:

```javascript
{
  artists: ["Artist Name 1", "Artist Name 2", ...],
  discoveredAliases: [
    { artist: "Artist Name", aliases: ["Alias 1", "Alias 2"], source: "page content" },
    ...
  ]
}
```

- For clean plain text (one artist per line): simple text parsing, no LLM needed.
- For everything else (messy text, HTML page content, images, PDFs): send to LLM (Anthropic API) for extraction.
- The LLM prompt should ask for both artist names AND any alias/relationship information mentioned in the source material.
- `discoveredAliases` will be empty for simple inputs like flyer images, but rich for pages like ZNA Gathering that describe artist histories in prose.

### 3. Lookup Layer
Takes artist names, queries providers (MusicBrainz, Discogs), merges results. This already exists.

The `discoveredAliases` from the extraction layer are treated as another provider source — "festival page" sits alongside MusicBrainz and Discogs in the merge step.

### 4. Display Layer
Shows the results progressively. This already exists.

## LLM Integration Details

### API Choice
Anthropic API (Claude) — consistent with the rest of the project tooling.

### Proxy Requirement
The Anthropic API key must be kept server-side, same pattern as Discogs. Add another route to the Cloudflare Worker proxy (or a separate Worker) that handles LLM requests. The browser sends content to the proxy, the proxy adds the API key and forwards to the Anthropic API.

### What the LLM Handles
The LLM is the universal parser. It handles:
- Messy pasted text → extract artist names
- HTML page content → extract artist names + alias info from descriptions
- Images (flyers, posters, screenshots of social media) → extract artist names via vision
- PDF content → extract artist names

### Prompt Design
The LLM should be prompted to:
- Return structured JSON (artist names + discovered aliases)
- Distinguish artist/performer names from label names, venue names, set type annotations ("Producer Set", "DJ Set"), and other non-artist text
- For collaborative acts like "Artist A vs Artist B" or "Artist A & Artist B", return the combined name as-is (the lookup layer handles splitting)
- Extract any alias, side project, or group membership information mentioned in surrounding text
- Be genre-aware enough to understand psytrance scene conventions (though the tool should work for any genre)

### Cost Considerations
- For a hobby project, the owner absorbs the (tiny) API cost
- Add rate limiting on the Worker to prevent abuse
- A single festival page or image is a small amount of tokens — fractions of a cent per extraction

## Real-World Input Examples

These examples informed the architecture:

### Easy: Sizigia Eclipse (https://sizigiaeclipse.com/origen/)
Clean grid of artist names as h2 headings. Could almost be parsed without an LLM, but the LLM handles it trivially and keeps the architecture simple.

### Hard: ZNA Gathering (https://znagathering.com/program/dancefloor/)
Artist names buried in long prose descriptions. Descriptions mention aliases, real names, label names, and related projects extensively. This is where the LLM extraction shines — it pulls out both the performing name AND the alias info from descriptions. Example: "Dado vs Dino Psaras" description mentions Deedrah, Transwave, Cypher, Cydonia, Synthetic, Tortured Brain, Ayahuasca, Phreaky, Tripster, Human Energy.

### Image: Festival flyers (e.g. Union of Freaks 2026)
Flyer images shared on Discord, Instagram, etc. Need LLM vision to read artist names from the image. Must distinguish artist names (large text) from label names (smaller text above), set type annotations, and decorative text.

### Walled gardens: Facebook reels, Instagram posts, private Discord
Content behind logins can't be fetched. The practical solution is screenshot upload (feeds into the image path) or manual text paste. No special architecture needed — these are just image or text inputs.

## Implementation Order

Suggested order for building this out:

1. **Anthropic API proxy** — add LLM proxy route to the Cloudflare Worker, same pattern as the Discogs proxy
2. **Messy text input** — accept pasted text that isn't cleanly one-per-line, send to LLM for extraction when simple parsing fails
3. **URL input** — accept a URL, fetch the page content, send to LLM for extraction (HTML pages first)
4. **Alias extraction from page content** — enhance the LLM prompt to also return discovered aliases, wire into the merge step as another provider
5. **Image input** — accept uploaded images (or image URLs), send to LLM vision for extraction
6. **PDF input** — accept uploaded PDFs, extract text or render as image, send to LLM

## Technical Notes

- The LLM extraction step should return the standard provider shape for discovered aliases so they merge cleanly with MusicBrainz/Discogs results
- For URL input, need to handle: HTML pages (extract text content, strip nav/footer/scripts), direct image URLs, PDFs
- Consider a simple heuristic to decide if pasted text needs LLM extraction: if it's cleanly one item per line with no extra formatting, use simple parsing; otherwise use LLM. Or just always use LLM since the cost is negligible.
- Image uploads use the Anthropic API's vision capability (send base64 image in the messages array)
- Rate limiting on the LLM proxy is important since LLM calls cost real money, unlike the free MusicBrainz API
