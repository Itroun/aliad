import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normaliseName } from '../src/core/merge.js';
import { stripDisambiguation } from '../src/providers/discogs.map.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const norm = (raw) => normaliseName(stripDisambiguation(raw));

// build.js needs the experimental SQLite flag, which vitest's process doesn't
// carry — so drive it (and read the result) through `node --experimental-sqlite`
// subprocesses. `buildAndRead` gzips a dump buffer, builds a DB, and reads it
// back as plain JSON.
function buildAndRead(fixtureBuffer, dumpDate = '2026-07-01') {
  const dir = mkdtempSync(join(tmpdir(), 'aliad-dump-'));
  const gz = join(dir, 'artists.xml.gz');
  const db = join(dir, 'out.db');
  writeFileSync(gz, gzipSync(fixtureBuffer));

  const build = spawnSync(
    'node',
    [
      '--experimental-sqlite',
      join(root, 'scripts/dump/build.js'),
      '--input',
      gz,
      '--output',
      db,
      '--dump-date',
      dumpDate,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);
  const summary = JSON.parse(build.stdout.trim());

  const read = spawnSync(
    'node',
    [
      '--experimental-sqlite',
      '-e',
      `const {DatabaseSync}=require('node:sqlite');
       const db=new DatabaseSync(process.argv[1]);
       const meta=Object.fromEntries(db.prepare('SELECT key,value FROM dump_meta').all().map(r=>[r.key,r.value]));
       const names=db.prepare('SELECT norm_name,artist_id FROM dump_names ORDER BY norm_name').all();
       const edges=db.prepare('SELECT artist_id,kind,other_id,other_name FROM dump_edges ORDER BY artist_id,kind,other_id').all();
       const journal=db.prepare('PRAGMA journal_mode').get().journal_mode;
       console.log(JSON.stringify({meta,names,edges,journal}));`,
      db,
    ],
    { encoding: 'utf8' },
  );
  if (read.status !== 0) throw new Error(`read failed: ${read.stderr}`);
  return { summary, ...JSON.parse(read.stdout.trim()) };
}

describe('buildDump (end-to-end via subprocess)', () => {
  let built;
  beforeAll(() => {
    built = buildAndRead(readFileSync(join(here, 'fixtures', 'discogs-dump-artists.txt')));
  });

  it('counts artists and edges from the dump, skipping wrapper lines', () => {
    expect(built.summary.artists).toBe(3);
    expect(built.summary.edges).toBe(7); // artist 10: 5, artist 11: 0, artist 12: 2
    expect(built.meta.artist_count).toBe('3');
    expect(built.meta.edge_count).toBe('7');
  });

  it('records dump_date and name_count in meta', () => {
    expect(built.meta.dump_date).toBe('2026-07-01');
    expect(built.meta.name_count).toBe(String(built.names.length));
    expect(built.meta.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('leaves the file in WAL mode for Turso upload', () => {
    expect(built.journal).toBe('wal');
    expect(built.summary.journal).toBe('wal');
  });

  it('indexes an artist by its primary name', () => {
    const row = built.names.find((n) => n.norm_name === norm('Møbius & Co.'));
    expect(row.artist_id).toBe(10);
  });

  it('indexes a relation-less artist as a known-empty entry (present, zero edges)', () => {
    const row = built.names.find((n) => n.norm_name === norm('Lonely Solo'));
    expect(row.artist_id).toBe(11);
    expect(built.edges.filter((e) => e.artist_id === 11)).toEqual([]);
  });

  it('indexes namevariations too, so obscure aliases still resolve', () => {
    const row = built.names.find((n) => n.norm_name === norm('Café del Mar'));
    expect(row.artist_id).toBe(12);
  });

  it('stores identity edges as (kind, other_id, raw other_name) rows', () => {
    const tenEdges = built.edges.filter((e) => e.artist_id === 10);
    expect(tenEdges).toEqual([
      { artist_id: 10, kind: 'a', other_id: 20, other_name: 'Sølo Act' },
      { artist_id: 10, kind: 'a', other_id: 21, other_name: 'Alter Ego' },
      { artist_id: 10, kind: 'g', other_id: 30, other_name: 'The Collective' },
      { artist_id: 10, kind: 'm', other_id: 40, other_name: 'First Member' },
      { artist_id: 10, kind: 'm', other_id: 41, other_name: 'Second Member' },
    ]);
  });
});

// Regression: ~4% of real dump records span multiple physical lines because
// <profile> text contains literal newlines. The relation sections land on the
// continuation line; feeding parseArtist one physical line at a time drops them
// (measured: ~1 M edges lost on the full dump). The build must buffer
// <artist>…</artist> across lines.
describe('buildDump multi-line records', () => {
  const multiline = [
    '<artists>',
    '<artist><id>50</id><name>Split Artist</name><profile>Line one of the bio.',
    'Line two, after a real newline.</profile><data_quality>Correct</data_quality>' +
      '<aliases><name id="60">Hidden Alias</name></aliases>' +
      '<groups><name id="61">Hidden Group</name></groups></artist>',
    '<artist><id>51</id><name>Same Line Artist</name><aliases><name id="70">Plain Alias</name></aliases></artist>',
    '</artists>',
    '',
  ].join('\n');

  it('captures edges from relation sections on a continuation line', () => {
    const built = buildAndRead(Buffer.from(multiline));
    expect(built.summary.artists).toBe(2);
    expect(built.summary.edges).toBe(3); // split: 2 (alias+group), same-line: 1 alias
    const split = built.edges.filter((e) => e.artist_id === 50);
    expect(split).toEqual([
      { artist_id: 50, kind: 'a', other_id: 60, other_name: 'Hidden Alias' },
      { artist_id: 50, kind: 'g', other_id: 61, other_name: 'Hidden Group' },
    ]);
    // The buffered record's primary name still resolves correctly.
    expect(built.names.find((n) => n.norm_name === norm('Split Artist')).artist_id).toBe(50);
  });
});
