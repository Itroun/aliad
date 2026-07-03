// Provision the Turso-hosted Discogs dump: (re)create the database from an
// upload seed, push the built SQLite file, and mint a read-only token for the
// Worker. Plain Node — the platform API is JSON over fetch; the large binary
// upload shells out to curl (the proven, Content-Length-friendly path).
//
//   node scripts/dump/upload.js --file discogs-dump.db
//
// Reads TURSO_TOKEN (the platform API token — scripts only, the Worker must
// never see it) from .dev.vars. Prints TURSO_DUMP_URL / TURSO_DUMP_TOKEN ready
// to paste into .dev.vars and `wrangler secret put`.
//
// The upload file MUST be in WAL mode (build.js leaves it that way) or the
// upload endpoint 400s.

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://api.turso.tech';
const DEFAULTS = { org: 'itroun', group: 'default', name: 'discogs-dump' };
// The feasibility test left this DB behind; clean it up on the first real run.
const LEFTOVER_TEST_DB = 'dump-import-test';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file;
  if (!file) fail('usage: upload.js --file <dump.db> [--name discogs-dump] [--org itroun]');
  const size = fileSizeOrDie(file);

  const cfg = { ...DEFAULTS, ...pick(args, ['org', 'group', 'name']) };
  const platformToken = readDevVar('TURSO_TOKEN');
  if (!platformToken) fail('TURSO_TOKEN not found in .dev.vars');
  const api = makeApi(platformToken, cfg.org);

  log(`file: ${file} (${(size / 1e9).toFixed(2)} GB)`);

  // 1. Clean slate: drop the target DB and the leftover feasibility-test DB.
  await deleteIfExists(api, cfg.name);
  await deleteIfExists(api, LEFTOVER_TEST_DB);

  // 2. Create the DB from an upload seed.
  log(`creating database "${cfg.name}" in group "${cfg.group}"…`);
  const created = await api.post(`/v1/organizations/${cfg.org}/databases`, {
    name: cfg.name,
    group: cfg.group,
    seed: { type: 'database_upload' },
  });
  const hostname = created?.database?.Hostname || created?.database?.hostname;
  if (!hostname) fail(`create returned no hostname: ${JSON.stringify(created)}`);
  log(`  host: ${hostname}`);

  // 3. Upload the file with a full-access token (curl handles the big body).
  const uploadToken = await mintToken(api, cfg, { readOnly: false });
  log('uploading (this is the slow part)…');
  uploadFile({ hostname, token: uploadToken, file });

  // 4. Mint the read-only token the Worker will carry.
  const workerToken = await mintToken(api, cfg, { readOnly: true });

  const dumpUrl = `https://${hostname}`;
  log('\n✓ done. Add these to .dev.vars and prod secrets:\n');
  console.log(`TURSO_DUMP_URL=${dumpUrl}`);
  console.log(`TURSO_DUMP_TOKEN=${workerToken}`);
  log('\nProd: npx wrangler secret put TURSO_DUMP_URL / TURSO_DUMP_TOKEN');
}

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

function uploadFile({ hostname, token, file }) {
  const res = spawnSync(
    'curl',
    [
      '-sS',
      '--fail',
      '-X',
      'POST',
      `https://${hostname}/v1/upload`,
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/octet-stream',
      '--data-binary',
      `@${file}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (res.status !== 0) fail(`upload failed (curl status ${res.status})`);
}

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
