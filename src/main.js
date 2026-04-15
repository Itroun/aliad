import './style.css';
import { createInput } from './ui/input.js';
import { createResults } from './ui/results.js';
import { lookupAll } from './core/lookup.js';
import * as musicbrainz from './providers/musicbrainz.js';
import * as discogs from './providers/discogs.js';

const providers = [musicbrainz, discogs];

const app = document.querySelector('#app');

const header = document.createElement('header');
const h1 = document.createElement('h1');
h1.textContent = 'aka';
const tagline = document.createElement('p');
tagline.className = 'tagline';
tagline.textContent = 'Paste a festival lineup and discover each artist’s aliases, side projects, and group memberships.';
header.append(h1, tagline);

const resultsEl = document.createElement('div');
resultsEl.className = 'results';

const results = createResults(resultsEl);

let activeController = null;

const form = createInput({
  onSubmit: async (names) => {
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const signal = activeController.signal;
    results.start(names, providers.map((p) => p.name));
    try {
      await lookupAll(names, providers, {
        signal,
        onProviderResult: (artist, provider, outcome) => {
          if (signal.aborted) return;
          results.onProviderResult(artist, provider, outcome);
        },
        onArtistDone: (artist, merged) => {
          if (signal.aborted) return;
          results.onArtistDone(artist, merged);
        },
      });
    } catch (err) {
      if (err?.name !== 'AbortError') console.error(err);
    }
  },
});

app.append(header, form, resultsEl);
