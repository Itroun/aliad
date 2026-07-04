# About aliad

aliad finds all the acts playing more than once in a festival lineup.

## How it works

1. **You give it a lineup** by pasting it or sharing a link.

2. **It identifies the acts** from what you pasted or by reading them off the page you linked.

3. **It looks each one up** in MusicBrainz and Discogs.

4. **It maps the connections** visually and as a list.

Results stream in act by act as it works.

## Your data

aliad has no accounts and no login. These services are used to process the lookups:

- **Cloudflare** hosts aliad and caches the artist data it looks up. It collects visitor analytics at its edge servers: ([Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/), [privacy policy](https://www.cloudflare.com/privacypolicy/)).

- **An LLM** (via OpenRouter) processes your submitted lineup to extract artist names.

- **MusicBrainz & Discogs** receive the artist names being looked up. They are the source of the aliases and connections.

- **Turso** hosts aliad's monthly copy of the Discogs data.

- **jina** (r.jina.ai) is the fallback if aliad can't fetch a pasted URL directly.

Aside from Cloudflare (the host) these services receive requests from aliad's servers, not from your browser or IP.

## Open source

You can find aliad's [source on GitHub](https://github.com/Itroun/aliad).
