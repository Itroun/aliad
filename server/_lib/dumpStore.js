// Read-only adapter over the Turso-hosted Discogs dump (see TODO.md → "Discogs
// dump substrate" and ARCHITECTURE.md). The ONLY place the Turso pipeline
// protocol lives — lookup.js talks to the small `{ getArtist }` interface, and
// tests inject a fake fetch returning captured pipeline JSON, mirroring how
// fakeKV / the in-memory quad store stand in for their bindings.
//
// `makeDumpStore(env, { fetchFn })` returns `null` when the dump credentials are
// unbound — that's the degrade-open path: no dump, fall back to the gated wire.
// Credentials arrive as ONE secret, `TURSO_DUMP` = {"url","token"}, so a monthly
// refresh repoints host and token in a single atomic `wrangler secret put`; with
// two secrets the gap between the two puts served a mismatched pair. The legacy
// TURSO_DUMP_URL/TURSO_DUMP_TOKEN pair is still read as a fallback.
//
// `getArtist(normName, { signal })` runs ONE POST carrying two statements —
// presence (is this name in the dump at all?) and its identity edges — and
// returns a Discogs *details*-shaped object that `discogs.mapDetails` consumes
// unchanged, or `null` for a name absent from the dump. A present artist with no
// relations returns empty edge arrays ("known empty") — still a hit, so obscure
// relation-less roots never touch the API. Any transport / SQL error throws so
// the caller falls through to the wire.

import { BUCKET_FOR_CODE } from '../../src/core/dumpKinds.js';

const PRESENCE_SQL = 'SELECT artist_id FROM dump_names WHERE norm_name = ?';
// Resolve the id inline so both statements key only on norm_name and batch into
// one pipeline round-trip.
const EDGES_SQL =
  'SELECT kind, other_id, other_name FROM dump_edges ' +
  'WHERE artist_id = (SELECT artist_id FROM dump_names WHERE norm_name = ?)';

// A malformed TURSO_DUMP degrades open like an absent one: a broken dump costs
// speed (the wire path still answers), and throwing here would fail lookups
// outright.
export function readDumpCreds(env) {
  const raw = env?.TURSO_DUMP;
  if (raw) {
    // Tolerate surrounding quotes: the value is copied from upload.js output
    // (single-quoted so .dev.vars stays shell-sourceable) into `wrangler secret
    // put`, which takes it literally. Failing on that would black out the dump
    // silently — a slow app with nothing in the logs.
    const parsed = typeof raw === 'string' ? safeJson(unquote(raw)) : raw;
    const url = parsed?.url;
    const token = parsed?.token;
    if (url && token) return { url: String(url), token: String(token) };
    return null;
  }
  const url = env?.TURSO_DUMP_URL;
  const token = env?.TURSO_DUMP_TOKEN;
  if (url && token) return { url: String(url), token: String(token) };
  return null;
}

export function makeDumpStore(env, { fetchFn = fetch } = {}) {
  const creds = readDumpCreds(env);
  if (!creds) return null;
  const { url: base, token } = creds;
  const endpoint = `${String(base).replace(/\/$/, '')}/v2/pipeline`;

  return {
    async getArtist(normName, { signal } = {}) {
      const key = String(normName ?? '');
      if (!key) return null;

      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            { type: 'execute', stmt: { sql: PRESENCE_SQL, args: [textArg(key)] } },
            { type: 'execute', stmt: { sql: EDGES_SQL, args: [textArg(key)] } },
            { type: 'close' },
          ],
        }),
        signal,
      });
      if (!res.ok) throw new Error(`dump store HTTP ${res.status}`);

      const body = await res.json();
      const presenceRows = executeResult(body, 0).rows ?? [];
      if (presenceRows.length === 0) return null; // name not in the dump — read edges only when present

      const id = Number(cell(presenceRows[0], 0));
      // A present name must carry a positive integer id; anything else means a
      // malformed response — throw so the caller degrades to the wire rather than
      // returning a bogus id:0 hit (which mapDetails would then strip of its URL).
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`dump store: bad artist_id for "${key}"`);
      }

      const details = { id, aliases: [], groups: [], members: [] };
      for (const row of executeResult(body, 1).rows ?? []) {
        const bucket = BUCKET_FOR_CODE[cell(row, 0)];
        if (!bucket) continue;
        details[bucket].push({ id: Number(cell(row, 1)), name: String(cell(row, 2) ?? '') });
      }
      return details;
    },
  };
}

function unquote(text) {
  const t = String(text).trim();
  const quoted = t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0];
  return quoted ? t.slice(1, -1) : t;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textArg(value) {
  return { type: 'text', value };
}

// Pull the execute result for request index `i`, throwing on a SQL/stream error
// so the caller degrades to the wire rather than silently seeing empty edges.
function executeResult(body, i) {
  const entry = body?.results?.[i];
  if (!entry) throw new Error(`dump store: missing result ${i}`);
  if (entry.type === 'error') {
    throw new Error(`dump store SQL error: ${entry.error?.message ?? 'unknown'}`);
  }
  const result = entry.response?.result;
  if (!result) throw new Error(`dump store: malformed result ${i}`);
  return result;
}

// A Hrana cell is { type, value }; integers arrive as strings. `null` cells have
// no value field.
function cell(row, col) {
  const c = row?.[col];
  return c && 'value' in c ? c.value : null;
}
