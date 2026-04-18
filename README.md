# aka

Paste a festival lineup, get every artist's aliases, side projects, and group memberships. Built for when you're scanning a 200-name poster and want to know which of those unfamiliar names is secretly your favourite producer's alter ego.

Live data comes from [MusicBrainz](https://musicbrainz.org) and [Discogs](https://www.discogs.com) at lookup time — nothing is stored, no accounts, no tracking.

## How it works

```
  Input  →  Extraction  →  Lookup (providers)  →  Display
```

1. **Input.** Paste text, drop in a URL, or upload a flyer/PDF/image.
2. **Extraction.** Clean line-per-artist text goes straight through. Anything messier (comma-separated, prose, HTML, images, PDFs) is sent to Claude via a Cloudflare Pages Function that returns a clean list plus any alias hints mentioned in the source.
3. **Lookup.** Each artist name is queried against every provider in parallel. Providers share an interface (`lookup(name) → { aliases, groups, members, relatedProjects }`), so adding Wikidata or a custom source is a new file, not a refactor. After the first round, the orchestrator follows alias chains recursively so groups hiding behind alternate names surface too.
4. **Display.** Results stream in as they arrive — you're not waiting for the slowest lookup to see the fastest one.

## Quick start

```bash
npm install
npm run dev        # Vite on http://localhost:5173
```

MusicBrainz works directly from the dev server. Discogs and the LLM extraction layer require the Pages Functions to be running, which needs a production-ish build:

```bash
# .dev.vars (gitignored)
DISCOGS_TOKEN=your-discogs-personal-token
ANTHROPIC_API_KEY=sk-ant-...   # only needed for the extraction layer

npm run build
npx wrangler pages dev dist    # full stack on http://localhost:8788
```

Rebuild after code changes when running the wrangler stack.

## Tests

```bash
npm test            # one-shot
npm run test:watch  # watch mode
```

All providers have fixture-based unit tests in `tests/`. MusicBrainz fixtures are real API captures; Discogs fixtures are currently synthesised (tagged `_note`) — replacing them with real captures is a good first contribution.

## Project layout

```
src/
  providers/
    provider.js          interface + empty-result shape
    musicbrainz.js       MusicBrainz artist lookup
    discogs.js           Discogs artist lookup (via proxy)
  core/
    lookup.js            orchestrator — runs providers in parallel, follows alias chains
    merge.js             dedupes entries across providers by normalised name
    rateLimit.js         per-provider queue so rate limits survive concurrent artists
    retry.js             fetch-with-retry, honours Retry-After on 429/5xx
    extract.js           input-type detection + plain-text parsing
    extractionProvider.js LLM extraction client
  ui/
    input.js             textarea / URL / file input
    results.js           progressive rendering
    devProbe.js          dev-only debugging affordances
  main.js                wires it all up
  style.css              single stylesheet, no CSS tooling

functions/api/
  discogs/[[path]].js    Pages Function: injects Discogs token, whitelists paths
  anthropic.js           Pages Function: proxies Claude requests for extraction
  fetch-page.js          Pages Function: fetches URLs for the extraction layer

tests/                   vitest, fixture-driven
```

## External APIs — what you need to know

**MusicBrainz.** No auth required. Rate limit 1 req/sec; we pace at 1200 ms. We intentionally don't set a custom `User-Agent` from the browser — it's a forbidden header there (silently stripped), and including it triggers a CORS preflight on every request, which cascades badly when MusicBrainz's load balancer returns 503. If MB ever flags the app for UA, the right fix is to route lookups through a Pages Function proxy.

**Discogs.** Requires a personal access token. 60 req/min authenticated; we pace at 1500 ms. Token lives in `.dev.vars` / Cloudflare secrets and is injected server-side by the proxy Function — it never reaches the browser. The proxy whitelists `database/` and `artists/` paths only.

**Transient errors.** Both providers wrap requests in a retry layer (3 attempts, exponential backoff + jitter, honouring upstream `Retry-After` up to 60 s). 429 / 502 / 503 / 504 all retry; everything else surfaces as a provider failure — the orchestrator skips it and the UI marks that artist as partial.

## Design principles

- **Scope lives in the project brief.** v1 is deliberately small — no accounts, no caching layer, no graph viz, no database. Features beyond the brief should trigger a conversation before code.
- **Providers are leaves.** They don't know about each other, about caching, or about the UI. Add a provider by writing one file.
- **Progressive > complete.** First byte wins over lowest latency to full results.
- **No framework.** Plain DOM, plain ES modules, plain CSS. A new contributor should be reading code within five minutes of cloning.
- **One fetch per user action.** The extraction layer deliberately does not crawl; it fetches once what the user explicitly asked for. No robots.txt games, no background scraping.

## Contributing

The project is in early v1 and the scope is intentionally tight. Good places to start:

- Replace synthesised Discogs fixtures with real captures (see `tests/fixtures/`).
- Improve the extraction prompt's handling of a specific lineup format you have on hand.
- Add a new provider — Wikidata is the obvious candidate.

For larger changes, open an issue first so we can agree on scope before you spend time.

## For Claude Code sessions

If you're an AI assistant reading this to get your bearings: the "Design principles" section above is authoritative on scope. Key things that are easy to get wrong:

- The rate-limit intervals exist for a reason. Don't lower them without reading the notes in `src/providers/*.js`.
- Don't re-add a `User-Agent` header to the browser-side MusicBrainz client (see the "External APIs" section above).
- Provider modules must return the full `{ aliases, groups, members, relatedProjects }` shape — use `emptyResult()` from `provider.js`.
- Tests use injected `fetchFn` and `sleep` to stay fast and deterministic. Don't reach for real timers or network.

## License

TBD — will be set before first public release.
