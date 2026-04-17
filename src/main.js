import './style.css';
import { createInput } from './ui/input.js';
import { createResults } from './ui/results.js';
import { lookupAll } from './core/lookup.js';
import { detectInputType, extractArtists } from './core/extract.js';
import { createExtractionProvider } from './core/extractionProvider.js';
import * as musicbrainz from './providers/musicbrainz.js';
import * as discogs from './providers/discogs.js';

const providers = [musicbrainz, discogs];

const app = document.querySelector('#app');

const header = document.createElement('header');
const h1 = document.createElement('h1');
h1.textContent = 'aka';
const tagline = document.createElement('p');
tagline.className = 'tagline';
tagline.textContent = 'Paste a festival lineup and discover each artist\u2019s aliases, side projects, and group memberships.';
header.append(h1, tagline);

const resultsEl = document.createElement('div');
resultsEl.className = 'results';

const results = createResults(resultsEl);

const statusEl = document.createElement('p');
statusEl.className = 'extraction-status';

let activeController = null;

function cancelActive() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  statusEl.textContent = '';
}

const form = createInput({
  onCancel: cancelActive,
  onSubmit: async (input) => {
    cancelActive();
    activeController = new AbortController();
    const signal = activeController.signal;

    results.clear();

    try {
      const { artists, discoveredAliases } = await resolveInput(input, signal);
      if (!artists.length) {
        statusEl.textContent = 'No artist names found.';
        return;
      }
      statusEl.textContent = '';

      const activeProviders = discoveredAliases.length
        ? [createExtractionProvider(discoveredAliases), ...providers]
        : providers;

      results.start(artists, activeProviders.map((p) => p.name));

      await lookupAll(artists, activeProviders, {
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
      if (err?.name === 'AbortError') return;
      if (signal.aborted) return;
      console.error(err);
      statusEl.textContent = err.message || 'Something went wrong.';
    }
  },
});

app.append(header, form, statusEl, resultsEl);

async function resolveInput(input, signal) {
  if (input.type === 'url') {
    statusEl.textContent = 'Fetching page\u2026';
    const html = await fetchPage(input.value, signal);
    const cleaned = cleanHTML(html);
    if (cleaned.trim().length < 80) {
      throw new Error('Could not read useful content from that page (it may require a browser login or have bot protection). Try copying the text and pasting it instead.');
    }
    statusEl.textContent = 'Extracting artist names\u2026';
    return extractArtists(cleaned, { type: 'html', signal });
  }

  if (input.type === 'paste-html') {
    const cleaned = cleanHTML(input.html);
    if (cleaned.trim().length < 20) {
      return resolveText(input.value, signal);
    }
    statusEl.textContent = 'Extracting artist names from pasted content\u2026';
    return extractArtists(cleaned, { type: 'html', signal });
  }

  return resolveText(input.value, signal);
}

function resolveText(text, signal) {
  const inputType = detectInputType(text);
  if (inputType === 'clean') {
    return extractArtists(text, { type: 'clean-text', signal });
  }
  statusEl.textContent = 'Extracting artist names\u2026';
  return extractArtists(text, { type: 'messy-text', signal });
}

async function fetchPage(url, signal) {
  const response = await fetch(`/api/fetch-page?url=${encodeURIComponent(url)}`, { signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Could not fetch that URL: ${text || response.statusText}. Try copying the text from the page and pasting it instead.`);
  }
  return response.text();
}

function cleanHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const tag of doc.querySelectorAll('script, style, noscript, svg, iframe, link, meta')) {
    tag.remove();
  }
  return doc.body?.innerHTML ?? '';
}
