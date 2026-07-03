// Build the Discogs dump SQLite database from a monthly artists dump.
//
// Run with the experimental SQLite flag (Node 22.12):
//   node --experimental-sqlite scripts/dump/build.js --input <artists.xml.gz> --output dump.db
//
// Download the dump first (Range requests are NOT honored — it pulls the whole
// ~470 MB gz):
//   curl -L -o discogs_YYYYMM01_artists.xml.gz \
//     'https://data.discogs.com/?download=data%2FYYYY%2Fdiscogs_YYYYMM01_artists.xml.gz'
// or use the convenience: `--download YYYYMM` (shells out to curl -L).
//
// Output is the final schema in TODO.md: dump_names (collision winner per
// norm_name), dump_edges (identity relations by artist), dump_meta. The build
// streams the gz (never holds the dump in memory), stages every name occurrence
// in a scratch table, then resolves one winner per norm_name via resolveWinner
// (the unit-tested rule) over a keyset scan so peak memory stays one page, not
// 15 M rows. Final file is VACUUMed and left in WAL mode (Turso upload requires
// WAL).

import { createReadStream, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { parseArtist } from './parseArtist.js';
import { resolveWinner } from './resolveWinner.js';
import { normaliseName } from '../../src/core/merge.js';
import { stripDisambiguation } from '../../src/providers/discogs.map.js';

const SUFFIX_RE = / \(\d+\)$/; // the "(3)"-style disambiguation the norm key strips
const KIND = { aliases: 'a', groups: 'g', members: 'm' };
const COMMIT_EVERY = 50_000;
const RESOLVE_PAGE = 50_000;

const SCHEMA = `
CREATE TABLE dump_names (
  norm_name TEXT PRIMARY KEY,
  artist_id INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE dump_edges (
  artist_id  INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  other_id   INTEGER NOT NULL,
  other_name TEXT NOT NULL
);
CREATE TABLE dump_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE stage_names (
  norm_name    TEXT NOT NULL,
  artist_id    INTEGER NOT NULL,
  primary_flag INTEGER NOT NULL,
  suffixed     INTEGER NOT NULL,
  edges        INTEGER NOT NULL
);
`;

export async function buildDump({ input, output, dumpDate, log = () => {} }) {
  // Always build from scratch: a stale output would make CREATE TABLE fail
  // ("table already exists") or, worse, append to old data. Clear the file and
  // its WAL/SHM sidecars first.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${output}${suffix}`, { force: true });
  }
  const db = new DatabaseSync(output);
  try {
    // Fast bulk-load settings; the file is throwaway until VACUUM + WAL at the end.
    db.exec('PRAGMA journal_mode = OFF');
    db.exec('PRAGMA synchronous = OFF');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec(SCHEMA);

    const counts = await ingest(db, input, log);
    const nameCount = resolveNames(db, log);

    writeMeta(db, {
      dump_date: dumpDate || deriveDumpDate(input) || '',
      built_at: new Date().toISOString(),
      artist_count: String(counts.artists),
      edge_count: String(counts.edges),
      name_count: String(nameCount),
    });

    log('indexing + vacuuming…');
    db.exec('CREATE INDEX idx_dump_edges ON dump_edges(artist_id)');
    db.exec('DROP TABLE stage_names');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
    return { artists: counts.artists, edges: counts.edges, names: nameCount, journal };
  } finally {
    db.close();
  }
}

async function ingest(db, input, log) {
  const insEdge = db.prepare(
    'INSERT INTO dump_edges(artist_id, kind, other_id, other_name) VALUES (?, ?, ?, ?)',
  );
  const insStage = db.prepare(
    'INSERT INTO stage_names(norm_name, artist_id, primary_flag, suffixed, edges) VALUES (?, ?, ?, ?, ?)',
  );

  let stream = createReadStream(input);
  if (input.endsWith('.gz')) stream = stream.pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let artists = 0;
  let edges = 0;
  let pending = 0;
  db.exec('BEGIN');

  const handleRecord = (record) => {
    const a = parseArtist(record);
    if (!a) return;
    artists += 1;

    // Identity edges — count first so every name occurrence records the same tally.
    const relSets = [
      ['aliases', a.aliases],
      ['groups', a.groups],
      ['members', a.members],
    ];
    let edgeCount = 0;
    for (const [section, list] of relSets) {
      const kind = KIND[section];
      for (const rel of list) {
        insEdge.run(a.id, kind, rel.id, rel.name);
        edgeCount += 1;
      }
    }
    edges += edgeCount;

    stageName(insStage, a.name, a.id, 1, edgeCount);
    for (const v of a.namevariations) stageName(insStage, v, a.id, 0, edgeCount);

    pending += edgeCount + 1 + a.namevariations.length;
    if (pending >= COMMIT_EVERY) {
      db.exec('COMMIT');
      db.exec('BEGIN');
      pending = 0;
      if (artists % 500_000 < 1) log(`  …${artists.toLocaleString()} artists`);
    }
  };

  // Records are USUALLY one per line, but ~4% span multiple physical lines —
  // literal newlines inside <profile> text split the record. Those splits only
  // ever fall inside text content, never mid-tag, so buffer from <artist> to
  // </artist> and rejoin with '\n' to reconstruct the record faithfully;
  // otherwise a multi-line record's later relation sections (aliases/groups/
  // members) are silently dropped (measured: ~1 M edges lost without this).
  let buffer = null;
  for await (const line of rl) {
    if (buffer === null) {
      if (line.indexOf('<artist>') === -1) continue; // xml decl / <artists> wrapper
      if (line.indexOf('</artist>') !== -1) handleRecord(line);
      else buffer = line;
    } else {
      buffer += '\n' + line;
      if (line.indexOf('</artist>') !== -1) {
        handleRecord(buffer);
        buffer = null;
      }
    }
  }
  db.exec('COMMIT');
  log(`ingested ${artists.toLocaleString()} artists, ${edges.toLocaleString()} edges`);
  return { artists, edges };
}

function stageName(insStage, raw, artistId, primaryFlag, edgeCount) {
  const norm = normaliseName(stripDisambiguation(String(raw ?? '')));
  if (!norm) return;
  const suffixed = SUFFIX_RE.test(String(raw)) ? 1 : 0;
  insStage.run(norm, artistId, primaryFlag, suffixed, edgeCount);
}

// One winner per norm_name via a keyset scan over an ordered index, so peak
// memory is a single page of collisions rather than the whole staging table.
function resolveNames(db, log) {
  db.exec('CREATE INDEX stage_norm ON stage_names(norm_name)');
  const page = db.prepare(
    'SELECT norm_name, artist_id, primary_flag, suffixed, edges FROM stage_names WHERE norm_name > ? ORDER BY norm_name LIMIT ?',
  );
  const insName = db.prepare('INSERT INTO dump_names(norm_name, artist_id) VALUES (?, ?)');

  let last = '';
  let count = 0;
  db.exec('BEGIN');
  for (;;) {
    const rows = page.all(last, RESOLVE_PAGE);
    if (rows.length === 0) break;
    const finalPage = rows.length < RESOLVE_PAGE;
    const lastNorm = rows[rows.length - 1].norm_name;

    let i = 0;
    let processedThisPage = 0;
    while (i < rows.length) {
      const norm = rows[i].norm_name;
      // Defer the last group of a non-final page: it may continue next page.
      if (!finalPage && norm === lastNorm) break;
      const group = [];
      while (i < rows.length && rows[i].norm_name === norm) {
        group.push(toCandidate(rows[i]));
        i += 1;
      }
      insName.run(norm, resolveWinner(group));
      last = norm;
      count += 1;
      processedThisPage += 1;
    }

    if (finalPage) break;
    if (processedThisPage === 0) {
      // A single collision group larger than a page — impossible for real
      // Discogs data, but don't spin forever if it ever happens.
      throw new Error(`resolveNames: collision group for "${lastNorm}" exceeds RESOLVE_PAGE`);
    }
  }
  db.exec('COMMIT');
  log(`resolved ${count.toLocaleString()} unique names`);
  return count;
}

function toCandidate(row) {
  return {
    artist_id: row.artist_id,
    primary: row.primary_flag === 1,
    suffixed: row.suffixed === 1,
    edges: row.edges,
  };
}

function writeMeta(db, meta) {
  const ins = db.prepare('INSERT OR REPLACE INTO dump_meta(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) ins.run(k, v);
}

function deriveDumpDate(input) {
  const m = String(input).match(/discogs_(\d{4})(\d{2})(\d{2})_artists/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function download(yyyymm) {
  const year = yyyymm.slice(0, 4);
  const out = `discogs_${yyyymm}01_artists.xml.gz`;
  // The dump is served from data.discogs.com (Cloudflare-fronted); the path is
  // passed as a url-encoded `?download=` query. Range is not honored — this
  // pulls the whole ~470 MB.
  const path = `data/${year}/${out}`;
  const url = `https://data.discogs.com/?download=${encodeURIComponent(path)}`;
  console.error(`downloading ${url}`);
  const res = spawnSync('curl', ['-L', '--fail', '-o', out, url], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`curl failed (status ${res.status})`);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.download ? download(args.download) : args.input;
  if (!input) {
    console.error(
      'usage: build.js --input <artists.xml.gz> [--output dump.db] [--dump-date YYYY-MM-DD]',
    );
    console.error('   or: build.js --download YYYYMM [--output dump.db]');
    process.exit(2);
  }
  const output = args.output || 'discogs-dump.db';
  const log = args.json ? () => {} : (m) => console.error(m);
  const started = Date.now();
  const result = await buildDump({ input, output, dumpDate: args['dump-date'], log });
  const summary = { ...result, output, seconds: Math.round((Date.now() - started) / 1000) };
  if (args.json) console.log(JSON.stringify(summary));
  else console.error(`done in ${summary.seconds}s → ${output} (journal=${result.journal})`, result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
