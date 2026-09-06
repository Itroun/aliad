// Provision the Turso-hosted Discogs dump, blue-green: seed a NEW month-named
// database alongside the one production is serving, verify it, and only then
// hand over the credentials that cut traffic across. Plain Node — the platform
// API is JSON over fetch; the large binary upload shells out to curl (the
// proven, Content-Length-friendly path).
//
//   node scripts/dump/upload.js --file discogs-dump.db --month 202610
//
// Why blue-green: the old shape dropped the live database *before* uploading, so
// any failure in between left production with no dump at all (seen 2026-09-06,
// when the seed endpoint 404'd seconds after create). Now nothing about the live
// database is touched until the new one has been uploaded and read back, and the
// previous month's database survives as a rollback target — it is pruned at the
// START of the NEXT refresh, once its successor has proven itself in production
// for a month.
//
// Reads TURSO_TOKEN (the platform API token — scripts only, the Worker must
// never see it) from .dev.vars. Prints ONE `TURSO_DUMP` secret holding both the
// url and the token, so the cutover is a single atomic `wrangler secret put`
// rather than two puts with a mismatched-pair window between them.
//
// The upload file MUST be in WAL mode (build.js leaves it that way) or the
// upload endpoint 400s.

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://api.turso.tech';
const DEFAULTS = { org: 'itroun', group: 'default', prefix: 'discogs-dump' };
// The feasibility test left this DB behind; clean it up on the first real run.
const LEFTOVER_TEST_DB = 'dump-import-test';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file;
  const month = args.month;
  if (!file || !month) {
    fail('usage: upload.js --file <dump.db> --month YYYYMM [--prefix discogs-dump] [--org itroun]');
  }
  if (!/^\d{6}$/.test(month)) fail(`--month must be YYYYMM, got "${month}"`);
  const size = fileSizeOrDie(file);

  const cfg = { ...DEFAULTS, ...pick(args, ['org', 'group', 'prefix']) };
  const name = `${cfg.prefix}-${month}`;
  const platformToken = readDevVar('TURSO_TOKEN');
  if (!platformToken) fail('TURSO_TOKEN not found in .dev.vars');
  const api = makeApi(platformToken, cfg.org);

  log(`file: ${file} (${(size / 1e9).toFixed(2)} GB) → database "${name}"`);

  // 1. Prune last refresh's leftovers — never the live database, never the
  //    target. The database production is serving right now is identified from
  //    .dev.vars; if that can't be read we skip pruning rather than guess.
  await pruneOldDatabases(api, { name, prefix: cfg.prefix });

  // 2. Create the new database from an upload seed. The live one is untouched.
  log(`creating database "${name}" in group "${cfg.group}"…`);
  const created = await api.post(`/v1/organizations/${cfg.org}/databases`, {
    name,
    group: cfg.group,
    seed: { type: 'database_upload' },
  });
  const hostname = created?.database?.Hostname || created?.database?.hostname;
  if (!hostname) fail(`create returned no hostname: ${JSON.stringify(created)}`);
  log(`  host: ${hostname}`);

  // 3. Upload the file with a full-access token (curl handles the big body).
  const uploadToken = await mintToken(api, { ...cfg, name }, { readOnly: false });
  await waitForUploadEndpoint({ hostname, token: uploadToken });
  log('uploading (this is the slow part)…');
  await uploadFile({ hostname, token: uploadToken, file });

  // 4. Mint the read-only token the Worker will carry.
  const workerToken = await mintToken(api, { ...cfg, name }, { readOnly: true });

  // 5. Read the new database back through the Worker's own credentials, BEFORE
  //    production points at it — the whole point of seeding alongside.
  const dumpUrl = `https://${hostname}`;
  const meta = await readDumpMeta({ url: dumpUrl, token: workerToken });
  assertMetaMatchesMonth(meta, month);
  log(
    `verified: dump_date=${meta.dump_date} artists=${fmt(meta.artist_count)} ` +
      `edges=${fmt(meta.edge_count)} names=${fmt(meta.name_count)}`,
  );

  log('\n✓ done. Cut over with ONE secret (url + token together):\n');
  // Single-quoted: the value is JSON, so an unquoted line makes .dev.vars
  // unsourceable by the shell (`set -a; . ./.dev.vars` tries to run the braces).
  // readDevVar and wrangler both strip the surrounding quotes.
  console.log(`TURSO_DUMP='${JSON.stringify({ url: dumpUrl, token: workerToken })}'`);
  log(
    `\nProd: npx wrangler secret put TURSO_DUMP` +
      `\nThe previous month's database is left in place as a rollback target;` +
      `\nthe next refresh prunes it.`,
  );
}

// Delete the databases this script owns except the live one and the target. The
// live host comes from .dev.vars (TURSO_DUMP, or the legacy pair) — the same
// value production is running, so an unreadable one means "don't touch
// anything" rather than a guess that could drop a serving database.
async function pruneOldDatabases(api, { name, prefix }) {
  const liveHost = readLiveHost();
  if (!liveHost) {
    log('  (no dump credentials in .dev.vars — skipping prune)');
    return;
  }
  const { res, json } = await api.get(`/v1/organizations/${api.org}/databases`);
  if (!res.ok) {
    log('  (could not list databases — skipping prune)');
    return;
  }
  const existing = (json?.databases ?? []).map((d) => ({
    name: d.Name ?? d.name,
    hostname: d.Hostname ?? d.hostname,
  }));
  const stale = selectStaleDatabases({ existing, liveHost, target: name, prefix });
  for (const victim of stale) await deleteIfExists(api, victim);
  if (!stale.length) log('  (nothing to prune)');
  await deleteIfExists(api, LEFTOVER_TEST_DB);
}

// Pure so the "which database gets dropped" decision is unit-tested rather than
// discovered in production. Keeps the live database and the target; everything
// else this script owns goes.
export function selectStaleDatabases({ existing, liveHost, target, prefix = 'discogs-dump' }) {
  const owned = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d{6})?$`);
  return existing
    .filter((db) => db.name && owned.test(db.name))
    .filter((db) => db.name !== target && db.hostname !== liveHost)
    .map((db) => db.name);
}

function readLiveHost() {
  const bundled = readDevVar('TURSO_DUMP');
  const url = bundled ? safeJson(bundled)?.url : readDevVar('TURSO_DUMP_URL');
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function readDumpMeta({ url, token }) {
  const res = await fetch(`${url.replace(/\/$/, '')}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql: 'SELECT key, value FROM dump_meta' } },
        { type: 'close' },
      ],
    }),
  });
  if (!res.ok) throw new Error(`verify failed: dump_meta HTTP ${res.status}`);
  const body = await res.json();
  const entry = body?.results?.[0];
  if (entry?.type === 'error') {
    throw new Error(`verify failed: ${entry.error?.message ?? 'unknown SQL error'}`);
  }
  const rows = entry?.response?.result?.rows ?? [];
  return Object.fromEntries(rows.map((r) => [r[0]?.value, r[1]?.value]));
}

// A seeded-but-wrong database is the one failure blue-green must not wave
// through: it would be cut over to and serve stale data silently.
export function assertMetaMatchesMonth(meta, month) {
  const expected = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
  if (!meta?.dump_date) throw new Error('verify failed: dump_meta has no dump_date');
  if (meta.dump_date !== expected) {
    throw new Error(`verify failed: dump_date is ${meta.dump_date}, expected ${expected}`);
  }
  if (!Number(meta.edge_count)) throw new Error('verify failed: dump_meta reports no edges');
  return true;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

// ── Turso platform API helpers ───────────────────────────────────────────────

function makeApi(token, org) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    return { res, json, text };
  };
  return {
    org,
    async post(path, body) {
      const { res, json, text } = await call('POST', path, body);
      if (!res.ok) fail(`POST ${path} → ${res.status}: ${text}`);
      return json;
    },
    async del(path) {
      const { res, text } = await call('DELETE', path);
      return { ok: res.ok, status: res.status, text };
    },
    async get(path) {
      return call('GET', path);
    },
  };
}

async function deleteIfExists(api, name) {
  const { ok, status, text } = await api.del(`/v1/organizations/${api.org}/databases/${name}`);
  if (ok) log(`deleted existing database "${name}"`);
  else if (status !== 404) log(`  (delete "${name}" → ${status}: ${text.slice(0, 120)})`);
}

async function mintToken(api, cfg, { readOnly }) {
  const q = readOnly ? '?authorization=read-only' : '';
  const out = await api.post(
    `/v1/organizations/${cfg.org}/databases/${cfg.name}/auth/tokens${q}`,
    {},
  );
  const jwt = out?.jwt;
  if (!jwt) fail(`token mint returned no jwt: ${JSON.stringify(out)}`);
  return jwt;
}

// ── upload: readiness + retry ───────────────────────────────────────────────
//
// Turso needs a moment after the create call before the new database will
// accept its seed — until then /v1/upload 404s. That window is a trap here:
// curl sends `Expect: 100-continue` for a body this size, so the rejection
// lands before any bytes move and the upload fails in seconds, looking like a
// dead route rather than a slow one — which is how it burned a refresh on
// 2026-09-06 (back when the create had already dropped the live database, so
// the give-up left production with no dump at all). Blue-green now contains the
// damage; this contains the failure. Probe until the route answers, then still
// retry the upload itself if the window reopens.

const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 3_000;
const UPLOAD_ATTEMPTS = 3;

// A live endpoint rejects the undersized probe with 400 ("file size is less
// than minimum size") without seeding anything; 404 means not ready yet, and 0
// is our marker for a request that never landed.
export function isUploadEndpointReady(status) {
  return status !== 404 && status !== 0;
}

export async function waitForUploadEndpoint({
  hostname,
  token,
  probe = probeUpload,
  sleep = delay,
  now = Date.now,
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  onWait = () => log('  waiting for the upload endpoint to come up…'),
}) {
  const deadline = now() + timeoutMs;
  let waited = false;
  for (;;) {
    const status = await probe({ hostname, token });
    if (isUploadEndpointReady(status)) return status;
    if (now() >= deadline) {
      throw new Error(
        `upload endpoint never became ready (last status ${status || 'unreachable'}) ` +
          `after ${Math.round(timeoutMs / 1000)}s — the database exists but is unseeded; ` +
          `re-run to retry.`,
      );
    }
    if (!waited) {
      waited = true;
      onWait();
    }
    await sleep(pollMs);
  }
}

// One-byte body: the endpoint's minimum-size check rejects it, which is exactly
// the cheap "are you there" signal we want — no partial seed is possible.
async function probeUpload({ hostname, token }) {
  try {
    const res = await fetch(`https://${hostname}/v1/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: 'x',
    });
    return res.status;
  } catch {
    return 0;
  }
}

export async function uploadFile({
  hostname,
  token,
  file,
  send = runUpload,
  sleep = delay,
  attempts = UPLOAD_ATTEMPTS,
  pollMs = READY_POLL_MS,
}) {
  for (let attempt = 1; ; attempt += 1) {
    const { status, body } = await send({ hostname, token, file });
    if (status === 200) {
      if (body) log(`  ${body.trim()}`);
      return;
    }
    if (status !== 404 || attempt === attempts) {
      throw new Error(`upload failed (HTTP ${status || 'no response'}): ${body.trim()}`);
    }
    log(`  upload → 404 (attempt ${attempt}/${attempts}), database not seeding yet; retrying…`);
    await sleep(pollMs * attempt);
  }
}

// curl owns the big body (Content-Length-friendly); `--fail` is deliberately
// absent so a 404 comes back as a status we can retry rather than exit code 22.
function runUpload({ hostname, token, file }) {
  const res = spawnSync(
    'curl',
    [
      '-sS',
      '-X',
      'POST',
      `https://${hostname}/v1/upload`,
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/octet-stream',
      '--data-binary',
      `@${file}`,
      '-w',
      '\n%{http_code}',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 20 },
  );
  if (res.error) throw new Error(`curl could not run: ${res.error.message}`);
  const out = (res.stdout ?? '').trim();
  const nl = out.lastIndexOf('\n');
  const status = Number(out.slice(nl + 1)) || 0;
  if (!status) {
    throw new Error(`upload failed (curl status ${res.status}): ${(res.stderr ?? '').trim()}`);
  }
  return { status, body: nl === -1 ? '' : out.slice(0, nl) };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── small utilities ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function readDevVar(key) {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', '..', '.dev.vars');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
  }
  return null;
}

function fileSizeOrDie(file) {
  try {
    return statSync(file).size;
  } catch {
    fail(`file not found: ${file}`);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function log(msg) {
  console.error(msg);
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
