import './style.css';
import { createInputScreen } from './ui/inputScreen.js';
import { createGraphScreen } from './ui/graphScreen.js';
import { createDevProbe } from './ui/devProbe.js';
import { lookupAll } from './core/lookup.js';
import { detectInputType, extractArtists } from './core/extract.js';
import { createExtractionProvider } from './core/extractionProvider.js';
import { cleanHTML } from './core/cleanHTML.js';
import * as musicbrainz from './providers/musicbrainz.js';
import * as discogs from './providers/discogs.js';

const providers = [musicbrainz, discogs];
const app = document.querySelector('#app');
const devProbe = createDevProbe();
if (devProbe.el) document.body.append(devProbe.el);

let activeController = null;
let currentScreen = null;

function mount(el) {
  if (currentScreen) currentScreen.remove();
  currentScreen = el;
  app.append(el);
}

function cancelActive() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

function showInput() {
  cancelActive();
  devProbe.reset();
  const screen = createInputScreen({
    onSubmit: handleSubmit,
    onCancel: cancelActive,
  });
  mount(screen.el);
}

async function handleSubmit(input) {
  cancelActive();
  activeController = new AbortController();
  const signal = activeController.signal;
  devProbe.reset();
  if (input.pasteFormat) devProbe.note(`paste format: ${input.pasteFormat}`);

  try {
    const { artists, discoveredAliases } = await resolveInput(input, signal);
    if (!artists.length) {
      // Surface the error back on the input screen — re-mount with a banner.
      showInput();
      console.warn('No artist names found in input.');
      return;
    }

    const activeProviders = discoveredAliases.length
      ? [createExtractionProvider(discoveredAliases), ...providers]
      : providers;

    const graph = createGraphScreen({ lineup: artists, onBack: showInput });
    mount(graph.el);

    await lookupAll(artists, activeProviders, {
      signal,
      onProviderResult: (artist, provider, outcome) => {
        if (signal.aborted) return;
        devProbe.note(formatProviderNote(artist, provider, outcome));
      },
      onArtistDone: (artist, merged) => {
        if (signal.aborted) return;
        graph.onArtistDone(artist, merged);
      },
      onArtistComplete: (artist, merged, summary) => {
        if (signal.aborted) return;
        graph.onArtistComplete(artist, merged, summary);
      },
      onBudgetExhausted: (artist, info) => {
        if (signal.aborted) return;
        devProbe.note(`${artist} · expansion budget hit (${info.skipped} aliases not explored)`);
      },
    });

    if (signal.aborted) return;
    graph.finalize();
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) return;
    console.error(err);
    // Bounce back to input on hard failure.
    showInput();
  }
}

showInput();

function extract(content, type, signal) {
  return extractArtists(content, {
    type,
    signal,
    onCall: ({ model, inputChars, outputArtists, durationMs }) => {
      devProbe.note(
        `extract · ${model} · in=${inputChars}ch · out=${outputArtists} artists · ${durationMs}ms`,
      );
    },
  });
}

async function resolveInput(input, signal) {
  if (input.type === 'url') {
    const { kind, body } = await fetchWithFallbacks(input.value, {
      signal,
      onAttempt: devProbe.onAttempt,
    });
    return extract(body, kind === 'html' ? 'html' : 'messy-text', signal);
  }

  if (input.type === 'paste-html') {
    const cleaned = cleanHTML(input.html);
    if (cleaned.trim().length < 20) {
      return resolveText(input.value, signal);
    }
    return extract(cleaned, 'html', signal);
  }

  return resolveText(input.value, signal);
}

function resolveText(text, signal) {
  const inputType = detectInputType(text);
  if (inputType === 'clean') {
    return extract(text, 'clean-text', signal);
  }
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

  throw new Error(
    'Could not fetch that URL (both direct and reader paths failed or returned too little content). Try copying the text from the page and pasting it instead.',
  );
}

async function callProxy(url, mode, signal) {
  const response = await fetch(`/api/fetch-page?mode=${mode}&url=${encodeURIComponent(url)}`, {
    signal,
  });
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

function formatProviderNote(artist, provider, outcome) {
  const label = outcome.via ? `${artist} (via ${outcome.via})` : artist;
  const suffix = outcome.cached ? ' · cached' : '';
  if (!outcome.ok) {
    const reason = outcome.error?.message || 'failed';
    return `${label} · ${provider} · error: ${reason}${suffix}`;
  }
  const counts = summariseResult(outcome.result);
  return `${label} · ${provider} · ${counts || 'no data'}${suffix}`;
}

function summariseResult(r) {
  const parts = [];
  if (r?.aliases?.length) parts.push(`${r.aliases.length} aliases`);
  if (r?.groups?.length) parts.push(`${r.groups.length} groups`);
  if (r?.members?.length) parts.push(`${r.members.length} members`);
  if (r?.relatedProjects?.length) parts.push(`${r.relatedProjects.length} related`);
  return parts.join(', ');
}
