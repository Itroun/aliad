import './style.css';
import { createInput } from './ui/input.js';
import { createResults } from './ui/results.js';
import { createDevProbe } from './ui/devProbe.js';
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

const devProbe = createDevProbe();

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
    devProbe.reset();
    if (input.pasteFormat) devProbe.note(`paste format: ${input.pasteFormat}`);

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

app.append(header, form, statusEl);
if (devProbe.el) app.append(devProbe.el);
app.append(resultsEl);

function extract(content, type, signal) {
  return extractArtists(content, {
    type,
    signal,
    onCall: ({ model, inputChars, outputArtists, durationMs }) => {
      devProbe.note(
        `extract \u00b7 ${model} \u00b7 in=${inputChars}ch \u00b7 out=${outputArtists} artists \u00b7 ${durationMs}ms`,
      );
    },
  });
}

async function resolveInput(input, signal) {
  if (input.type === 'url') {
    statusEl.textContent = 'Fetching page\u2026';
    const { kind, body } = await fetchWithFallbacks(input.value, {
      signal,
      onAttempt: devProbe.onAttempt,
    });
    statusEl.textContent = 'Extracting artist names\u2026';
    return extract(body, kind === 'html' ? 'html' : 'messy-text', signal);
  }

  if (input.type === 'paste-html') {
    const cleaned = cleanHTML(input.html);
    if (cleaned.trim().length < 20) {
      return resolveText(input.value, signal);
    }
    statusEl.textContent = 'Extracting artist names from pasted content\u2026';
    return extract(cleaned, 'html', signal);
  }

  return resolveText(input.value, signal);
}

function resolveText(text, signal) {
  const inputType = detectInputType(text);
  if (inputType === 'clean') {
    return extract(text, 'clean-text', signal);
  }
  statusEl.textContent = 'Extracting artist names\u2026';
  return extract(text, 'messy-text', signal);
}

const MIN_USEFUL_CHARS = 80;

async function fetchWithFallbacks(url, { signal, onAttempt }) {
  onAttempt({ path: 'direct', state: 'start' });
  const direct = await callProxy(url, 'direct', signal);
  if (direct.ok) {
    const cleaned = cleanHTML(direct.body);
    if (cleaned.trim().length >= MIN_USEFUL_CHARS) {
      onAttempt({ path: 'direct', state: 'ok', attempts: direct.attempts });
      return { kind: 'html', body: cleaned };
    }
    onAttempt({
      path: 'direct',
      state: 'fail',
      attempts: direct.attempts,
      reason: 'thin content after strip (probably JS-rendered)',
    });
  } else {
    onAttempt({ path: 'direct', state: 'fail', attempts: direct.attempts, reason: direct.reason });
  }

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  onAttempt({ path: 'reader', state: 'start' });
  const reader = await callProxy(url, 'reader', signal);
  if (reader.ok) {
    if (reader.body.trim().length >= MIN_USEFUL_CHARS) {
      onAttempt({ path: 'reader', state: 'ok', attempts: reader.attempts });
      return { kind: 'text', body: reader.body };
    }
    onAttempt({
      path: 'reader',
      state: 'fail',
      attempts: reader.attempts,
      reason: 'thin reader output',
    });
  } else {
    onAttempt({ path: 'reader', state: 'fail', attempts: reader.attempts, reason: reader.reason });
  }

  throw new Error('Could not fetch that URL (both direct and reader paths failed or returned too little content). Try copying the text from the page and pasting it instead.');
}

async function callProxy(url, mode, signal) {
  const response = await fetch(
    `/api/fetch-page?mode=${mode}&url=${encodeURIComponent(url)}`,
    { signal },
  );
  let attempts = [];
  try {
    attempts = JSON.parse(response.headers.get('X-Fetch-Attempts') || '[]');
  } catch {
    attempts = [];
  }
  const body = await response.text();
  if (!response.ok) {
    return { ok: false, attempts, reason: (body || response.statusText).slice(0, 200) };
  }
  return { ok: true, attempts, body };
}

function cleanHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const tag of doc.querySelectorAll('script, style, noscript, svg, iframe, link, meta')) {
    tag.remove();
  }
  return doc.body?.innerHTML ?? '';
}
