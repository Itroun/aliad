# aliad

Paste a festival lineup, get every artist's aliases, side projects, and group
memberships. Built for when you're scanning a 200-name poster and want to know
which of those unfamiliar names is secretly your favourite producer's alter ego.

Live data comes from [MusicBrainz](https://musicbrainz.org) and
[Discogs](https://www.discogs.com) at lookup time — nothing is stored about you,
no accounts, no tracking.

## How it works

```
  Input  →  Extraction  →  Lookup  →  Graph
```

1. **Input.** Paste text, drop in a URL, or upload a flyer / PDF / image.
2. **Extraction.** A clean line-per-artist list passes straight through; anything
   messier (prose, HTML, a photo of a poster) is handed to Claude, which returns a
   tidy list plus any alias hints it spotted.
3. **Lookup.** Every name is looked up across MusicBrainz and Discogs in parallel,
   then the connections behind alternate names — aliases, band members, side
   projects — are followed outward to build an identity graph.
4. **Graph.** Results stream in as they arrive and render as a live graph: who is
   secretly who, and which acts on the bill share members.

It runs as a small Cloudflare Worker with a vanilla-JS frontend (no framework).
For how it's actually built, see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Quick start

```bash
npm install
npm run dev    # Vite UI on http://localhost:5173
```

`npm run dev` serves the interface, but lookups and extraction run through the
Worker, so for the full app you need the wrangler stack:

```bash
# .dev.vars (gitignored)
DISCOGS_TOKEN=your-discogs-personal-token
ANTHROPIC_API_KEY=sk-ant-...        # only needed for the extraction layer

npm run build:dev
npx wrangler dev                    # full stack on http://localhost:8787
```

First run only, create the local cache database:
`npx wrangler d1 migrations apply aliad-graph --local`. Rebuild after code changes
when running the wrangler stack. See ARCHITECTURE.md for the bindings and
deploy-time setup.

## Tests

```bash
npm test            # one-shot (Vitest)
npm run test:watch  # watch mode
```

## Contributing

The project is early and the scope is intentionally tight (see _Principles_ in
ARCHITECTURE.md). Good first changes:

- Replace the synthesised Discogs fixtures with real captures (`tests/fixtures/`).
- Improve extraction for a specific lineup format you have on hand.
- Add a new provider — Wikidata is the obvious candidate (a new `*.map.js` mapper
  plus a one-line registration; see ARCHITECTURE.md).

For larger changes, open an issue first so we can agree on scope.

## License

TBD — will be set before first public release.
