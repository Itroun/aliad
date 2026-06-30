import './style.css';
import { initTheme } from './ui/themeToggle.js';
import { createInputScreen } from './ui/inputScreen.js';
import { createGraphScreen } from './ui/graphScreen.js';
import { createEmptyGraphScreen } from './ui/emptyGraphScreen.js';
import { createListScreen } from './ui/listScreen.js';
import { createDevProbe } from './ui/devProbe.js';
import { lookupAll } from './core/lookup.js';
import { detectInputType, extractArtists, combineExtractions } from './core/extract.js';
import { cleanHTML } from './core/cleanHTML.js';
import { encodeLineup, decodeLineup } from './core/lineupUrl.js';

initTheme();

const app = document.querySelector('#app');
const devProbe = createDevProbe();
if (devProbe.el) document.body.append(devProbe.el);

let activeController = null;
let activeView = 'input';
let graphScreen = null;
// The `l=…` token for the active lineup (sans view marker), so a tab switch can
// rewrite the URL without re-encoding. Null when no lineup is loaded.
let currentFrag = null;

// Compose the URL fragment from a lineup token + which view is showing. Map is
// the default so only List needs a marker; Lineup (input) carries no fragment.
function withView(frag, view) {
  return view === 'list' ? `${frag}&v=list` : frag;
}

// Read the active view / lineup token back out of a URL fragment. Take the hash
// explicitly so a caller can snapshot it once (rather than re-reading
// `location.hash`, which can shift under an interleaved navigation).
function viewFromHash(hash) {
  return hash.replace(/^#/, '').split('&').includes('v=list') ? 'list' : 'graph';
}
function lineupFragFromHash(hash) {
  return (
    hash
      .replace(/^#/, '')
      .split('&')
      .find((p) => p.startsWith('l=')) || null
  );
}

const inputScreen = createInputScreen({
  onSubmit: handleSubmit,
  onCancel: cancelActive,
  onViewChange: handleTabChange,
});
const emptyGraphScreen = createEmptyGraphScreen({ onViewChange: handleTabChange });
const listScreen = createListScreen({ onViewChange: handleTabChange });

app.append(inputScreen.el);
app.append(emptyGraphScreen.el);
app.append(listScreen.el);
applyViewVisibility();

restoreFromHash('replace');

function cancelActive() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

function setView(view) {
  if (view !== 'input' && view !== 'graph' && view !== 'list') return;
  activeView = view;
  applyViewVisibility();
}

// A user clicked a view tab. Switching tabs isn't a navigation between lineups,
// so it never adds a history entry (replaceState) — but it keeps the URL honest
// with what's on screen: Map/List carry the lineup fragment (+ a List marker, so
// refresh/forward restores the right one); Lineup (the input form, which shows
// the raw/empty input — not the resolved names in `l=`) drops the fragment. Back
// and Forward stay reserved for moving between lineups.
function handleTabChange(view) {
  setView(view);
  if (view === 'input' || !currentFrag) {
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } else {
    history.replaceState(null, '', `#${withView(currentFrag, view)}`);
  }
}

function applyViewVisibility() {
  inputScreen.el.hidden = activeView !== 'input';
  inputScreen.setActiveView(activeView);

  emptyGraphScreen.el.hidden = !!graphScreen || activeView !== 'graph';
  if (graphScreen) graphScreen.el.hidden = activeView !== 'graph';
  graphScreen?.setActiveView?.(activeView);
  emptyGraphScreen.setActiveView(activeView);

  listScreen.el.hidden = activeView !== 'list';
  listScreen.setActiveView(activeView);
}

function replaceGraphScreen(graph) {
  if (graphScreen) graphScreen.el.remove();
  graphScreen = graph;
  app.append(graphScreen.el);
  // The List view renders off the same graph; subscribing primes it with the
  // current (initially empty) state and keeps it in step as results stream.
  graphScreen.onGraphChange((g, lineup) => listScreen.update(g, lineup));
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
  inputScreen.setBusy(input.urls.length ? 'Fetching the lineup…' : 'Reading the lineup…');

  try {
    const { artists } = await resolveInput(input, signal);
    if (!artists.length) {
      inputScreen.clearBusy();
      setView('input');
      console.warn('No artist names found in input.');
      return;
    }

    inputScreen.clearBusy();
    // A submit is a new view: push a history entry so Back returns to input.
    await runLineup(artists, signal, { urlUpdate: 'push' });
  } catch (err) {
    // An aborted run was superseded by a newer submit, which has set its own busy
    // state — leave it alone. Only a genuine failure unlocks the form here.
    if (err?.name === 'AbortError' || signal.aborted) return;
    inputScreen.clearBusy();
    console.error(err);
    setView('input');
  }
}

// Stage 2 → 3: given the resolved act names, persist them to the URL fragment
// (so a refresh or a shared link restores this exact map) and run the live
// identity-graph walk. Shared by the submit flow and the on-boot hash restore;
// the caller owns the AbortController (submit reuses the one guarding the
// fetch/extract step). Assumes `artists` is non-empty.
async function runLineup(artists, signal, { urlUpdate = 'replace', view = 'graph' } = {}) {
  // Persist to the URL fragment so refresh / shared links / browser history all
  // restore this exact map. `urlUpdate` picks the history behaviour:
  //   'push'    — a fresh submit: add an entry so Back returns to the prior view
  //   'replace' — on-boot restore: normalise the existing hash in place
  //   'skip'    — popstate restore: the URL is already at this entry, leave it
  // Persisting is best-effort: a CompressionStream-less browser or a history
  // failure must never block the actual map from rendering.
  if (urlUpdate !== 'skip') {
    try {
      const frag = await encodeLineup(artists);
      if (frag) {
        currentFrag = frag;
        const url = `#${withView(frag, view)}`;
        if (urlUpdate === 'push') history.pushState(null, '', url);
        else history.replaceState(null, '', url);
      }
    } catch (err) {
      console.warn('Could not persist lineup to URL', err);
    }
  }

  const graph = createGraphScreen({ lineup: artists, onViewChange: handleTabChange });
  replaceGraphScreen(graph);
  setView(view);

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
}

// Reconcile the app to the URL fragment — the source of truth for which map is
// shown. Runs on load and on every browser back/forward. A present `#l=`
// restores that map by replaying the lookup walk (Stage 3) rather than
// re-fetching/re-extracting — the names are already resolved and the D1 cache
// makes the rebuild cheap; an absent fragment returns to the input screen.
// `urlUpdate` is forwarded to runLineup: 'replace' on boot (normalise the hash),
// 'skip' on popstate (the URL is already at the target entry — don't touch it).
async function restoreFromHash(urlUpdate) {
  // Snapshot the fragment once: decodeLineup awaits, and a second history
  // traversal mid-decode could otherwise leave us reading `names` from one URL
  // but the token/view from another. Everything below derives from this snapshot.
  const hash = window.location.hash;
  const names = await decodeLineup(hash);

  // No lineup in the URL → show the input form, but KEEP the loaded map alive
  // (hidden) so Forward / clicking Map returns to it instantly. This makes Back
  // and the Lineup tab behave identically: both just switch view — neither tears
  // the map down nor re-streams it.
  if (!names) {
    setView('input');
    return;
  }

  const frag = lineupFragFromHash(hash);
  const view = viewFromHash(hash);

  // Same lineup already loaded — just switch view; don't re-run the walk. (Covers
  // Forward back onto a map we still hold, and view markers like &v=list.)
  if (frag === currentFrag && graphScreen) {
    setView(view);
    return;
  }

  // A different (or first) lineup → build it and stream, superseding any run
  // still in flight for the previous one. `currentFrag` tracks what's loaded.
  cancelActive();
  currentFrag = frag;
  activeController = new AbortController();
  const signal = activeController.signal;
  devProbe.reset();
  runLineup(names, signal, { urlUpdate, view }).catch((err) => {
    if (err?.name === 'AbortError' || signal.aborted) return;
    console.error(err);
    setView('input');
  });
}

// Back/forward changes the fragment without a reload — replay it. Our own
// pushState/replaceState don't fire popstate, so this only runs for genuine
// history traversal, never for our own URL writes.
window.addEventListener('popstate', () => restoreFromHash('skip'));

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

// One field, possibly carrying both links and lineup text. Resolve each present
// part in parallel — fetch+extract the URLs, parse the loose text — then merge
// into one flat lineup (combineExtractions dedupes across the two). A "paste
// anything" field that mixes a stage link with a few typed acts just works.
async function resolveInput(input, signal) {
  const parts = [];
  if (input.urls?.length) parts.push(resolveUrls(input.urls, signal));
  if (input.text) parts.push(resolveTextPart(input, signal));

  if (!parts.length) return { artists: [] };

  const resolved = await Promise.all(parts);
  return combineExtractions(resolved);
}

// The text portion of a paste. Rich-paste HTML (a copied lineup table) extracts
// far better than its flattened text, so prefer it when it survived cleaning;
// otherwise fall back to plain-text detection + extraction.
function resolveTextPart(input, signal) {
  if (input.html) {
    const cleaned = cleanHTML(input.html);
    if (cleaned.trim().length >= 20) {
      return extract(cleaned, 'html', signal);
    }
  }
  return resolveText(input.text, signal);
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
