// URL-fragment persistence for the resolved lineup (Stage 2: the flat list of
// act names, *not* the raw input nor the computed graph). Living in the hash
// (`#l=…`) keeps it off the wire — the fragment is never sent to the server, so
// a 100+ act lineup can't trip the edge's request-URL length cap. On reload we
// decode these names and replay the lookup walk against the warm D1 cache.
//
// Names are gzip-compressed (lineups are very repetitive — " vs ", shared
// words) and base64url-encoded into a compact opaque token rather than a wall
// of percent-escaped text. CompressionStream makes encode/decode async.
import { dedupeNames } from './merge.js';

const LINEUP_KEY = 'l';

// The fragment is untrusted (anyone can craft a shared link), so cap how much
// we'll inflate: a tiny token can gzip-bomb to gigabytes and OOM the tab. 256KB
// is orders of magnitude above any real lineup.
const MAX_DECOMPRESSED_BYTES = 256 * 1024;

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DECOMPRESSED_BYTES) {
      await reader.cancel();
      throw new Error('decompressed lineup exceeds size cap');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toBase64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// `names` → fragment value (`l=…`), or null when there's nothing to persist.
export async function encodeLineup(names) {
  const clean = dedupeNames(names);
  if (!clean.length) return null;
  const compressed = await gzip(new TextEncoder().encode(clean.join('\n')));
  return `${LINEUP_KEY}=${toBase64url(compressed)}`;
}

// `location.hash` (or any fragment string) → deduped names, or null when the
// fragment carries no lineup / is malformed. Never throws — a bad token should
// fall back to a normal cold boot, not blank the app.
export async function decodeLineup(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const prefix = `${LINEUP_KEY}=`;
  // The fragment may carry other `&`-joined params (e.g. the active-view marker
  // `v=list`), so isolate the lineup param rather than assuming it's the whole
  // fragment.
  const param = raw.split('&').find((p) => p.startsWith(prefix));
  if (!param) return null;
  try {
    const bytes = fromBase64url(param.slice(prefix.length));
    const text = new TextDecoder().decode(await gunzip(bytes));
    const names = dedupeNames(text.split('\n'));
    return names.length ? names : null;
  } catch {
    return null;
  }
}
