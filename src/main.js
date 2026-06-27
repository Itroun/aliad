import './style.css';
import { initTheme } from './ui/themeToggle.js';
import { createInputScreen } from './ui/inputScreen.js';
import { createGraphScreen } from './ui/graphScreen.js';
import { createEmptyGraphScreen } from './ui/emptyGraphScreen.js';
import { createDevProbe } from './ui/devProbe.js';
import { lookupAll } from './core/lookup.js';
import { detectInputType, extractArtists, combineExtractions } from './core/extract.js';
import { cleanHTML } from './core/cleanHTML.js';

initTheme();

const app = document.querySelector('#app');
const devProbe = createDevProbe();
if (devProbe.el) document.body.append(devProbe.el);

let activeController = null;
let activeView = 'input';
let graphScreen = null;

const inputScreen = createInputScreen({
  onSubmit: handleSubmit,
  onCancel: cancelActive,
  onViewChange: setView,
});
const emptyGraphScreen = createEmptyGraphScreen({ onViewChange: setView });

app.append(inputScreen.el);
app.append(emptyGraphScreen.el);
applyViewVisibility();

function cancelActive() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

function setView(view) {
  if (view !== 'input' && view !== 'graph') return;
  activeView = view;
  applyViewVisibility();
}

function applyViewVisibility() {
  inputScreen.el.hidden = activeView !== 'input';
  inputScreen.setActiveView(activeView);

  emptyGraphScreen.el.hidden = !!graphScreen || activeView !== 'graph';
  if (graphScreen) graphScreen.el.hidden = activeView !== 'graph';
  graphScreen?.setActiveView?.(activeView);
  emptyGraphScreen.setActiveView(activeView);
}

function replaceGraphScreen(next) {
  if (graphScreen) {
    graphScreen.el.remove();
    graphScreen = null;
  }
  if (next) {
    graphScreen = next;
    app.append(graphScreen.el);
  }
  applyViewVisibility();
}

async function handleSubmit(input) {
  cancelActive();
  activeController = new AbortController();
  const signal = activeController.signal;
  devProbe.reset();
  if (input.pasteFormat) devProbe.note(`paste format: ${input.pasteFormat}`);

  // Lock the form and turn the button into a live progress indicator: this stretch
  // (URL fetch + the LLM extraction) is the several-second gap before the map
  // appears, and otherwise looks like nothing is happening. URL submits start on
  // "Fetching…"; extract() below flips every path to "Reading…" once it runs.
  inputScreen.setBusy(input.type === 'url' ? 'Fetching the lineup…' : 'Reading the lineup…');

  try {
    const { artists } = await resolveInput(input, signal);
    if (!artists.length) {
      inputScreen.clearBusy();
      setView('input');
      console.warn('No artist names found in input.');
      return;
    }

    inputScreen.clearBusy();
    const graph = createGraphScreen({ lineup: artists, onViewChange: setView });
    replaceGraphScreen(graph);
    setView('graph');

    await lookupAll(artists, {
      signal,
      onProviderResult: (artist, provider, outcome) => {
        if (signal.aborted) return;
        devProbe.providerResult(artist, {
          line: formatProviderNote(artist, provider, outcome),
          ok: outcome.ok,
          serverCache: outcome.serverCache,
        });
        if (outcome.serverCache) devProbe.serverCache(outcome.serverCache);
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
    // An aborted run was superseded by a newer submit, which has set its own busy
    // state — leave it alone. Only a genuine failure unlocks the form here.
    if (err?.name === 'AbortError' || signal.aborted) return;
    inputScreen.clearBusy();
    console.error(err);
    setView('input');
  }
}

function extract(content, type, signal) {
  // Extraction is the dominant cost; once it starts, every path is "Reading…"
  // (for URL submits this is the fetch→read handoff).
  inputScreen.setBusy('Reading the lineup…');
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
    return resolveUrls(input.urls, signal);
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

// Festivals often split their lineup across several pages (one per stage). Fetch
// and extract each URL in parallel, then merge into one flat lineup so the graph
// clusters across the whole festival. A page that fails to fetch/parse is skipped
// with a warning rather than failing the whole submission.
async function resolveUrls(urls, signal) {
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const { kind, body } = await fetchWithFallbacks(url, {
        signal,
        onAttempt: (attempt) => devProbe.onAttempt({ ...attempt, url }),
      });
      return extract(body, kind === 'html' ? 'html' : 'messy-text', signal);
    }),
  );

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  const extracted = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      extracted.push(result.value);
    } else {
      // Surface the skip as a fail row beside this URL's fetch attempts (rather
      // than a note that gets buried under the later graph-walk output), so it's
      // obvious which page dropped out of the lineup.
      devProbe.onAttempt({
        url: urls[i],
        path: 'skipped',
        state: 'fail',
        reason: 'page skipped — not included in lineup',
      });
    }
  });

  if (!extracted.length) {
    throw new Error(
      'Could not fetch any of those URLs (fetch or parse failed for every link). Check the links, or paste the lineup text instead.',
    );
  }

  return combineExtractions(extracted);
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
  // The act name is the group heading in the dev-probe, so the per-node detail
  // only needs the hop: `via X` for an expanded node, or the bare provider for
  // the root's own lookup.
  const label = outcome.via ? `via ${outcome.via}` : 'root';
  const serverTag = outcome.serverCache ? ` · L2:${outcome.serverCache}` : '';
  const suffix = (outcome.cached ? ' · cached' : '') + serverTag;
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
