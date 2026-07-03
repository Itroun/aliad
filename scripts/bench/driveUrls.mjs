// URL benchmark harness: replicate the app's URL→lineup extraction (fetch-page
// reader mode → LLM extract), then run the same closure telemetry aggregation
// as drive.mjs. URLs as argv; target via ALIAD_BASE (see drive.mjs).
import { extractArtists, combineExtractions } from '../../src/core/extract.js';
import { aggregateClosure, BASE, pool } from './drive.mjs';

const MIN_USEFUL_CHARS = 80;

// The extract modules call relative '/api/openrouter'; rewrite to the target Worker.
const localFetch = (url, init) =>
  fetch(typeof url === 'string' && url.startsWith('/') ? BASE + url : url, init);

async function fetchPage(url, mode) {
  const res = await localFetch(`/api/fetch-page?mode=${mode}&url=${encodeURIComponent(url)}`);
  const body = await res.text();
  return { ok: res.ok, body, reason: res.ok ? '' : body.slice(0, 160) };
}

async function urlToLineup(url) {
  // Reader mode only: the app's direct path runs cleanHTML, which needs a browser
  // DOMParser unavailable in Node. Reader (r.jina.ai) returns clean markdown text
  // — the app's fallback and what these JS-rendered festival pages use anyway.
  const reader = await fetchPage(url, 'reader');
  if (reader.ok && reader.body.trim().length >= MIN_USEFUL_CHARS) {
    const out = await extractArtists(reader.body, { type: 'messy-text', fetchFn: localFetch });
    return { url, path: 'reader', artists: out.artists };
  }
  throw new Error(`fetch failed for ${url}: ${reader.reason || 'thin content'}`);
}

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('usage: node driveUrls.mjs <url> [url...]');
  process.exit(2);
}

const extractions = [];
await pool(urls, 3, async (url) => {
  try {
    const r = await urlToLineup(url);
    console.log(`  extracted ${r.artists.length} acts from ${url} (${r.path})`);
    extractions.push(r.artists);
  } catch (e) {
    console.log(`  FAILED ${url}: ${e.message}`);
  }
});

if (!extractions.length) {
  console.error('no lineups extracted');
  process.exit(1);
}

const lineup = combineExtractions(extractions.map((artists) => ({ artists }))).artists;
console.log(`\ncombined lineup: ${lineup.length} unique acts`);
console.log('sample:', lineup.slice(0, 12).join(' · '), lineup.length > 12 ? '…' : '');
console.log('');
await aggregateClosure(lineup);
