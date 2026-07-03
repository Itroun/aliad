import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArtist, decodeEntities } from '../scripts/dump/parseArtist.js';

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, 'fixtures', 'discogs-dump-artists.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0);

const parseAll = () => lines.map(parseArtist).filter(Boolean);

describe('parseArtist', () => {
  it('skips non-<artist> lines (comment, xml decl, wrapper tags)', () => {
    const records = parseAll();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.id)).toEqual([10, 11, 12]);
  });

  it('parses an artist with every section', () => {
    const a = parseArtist(lines.find((l) => l.includes('>10<')));
    expect(a.id).toBe(10);
    expect(a.name).toBe('Møbius & Co.');
    expect(a.namevariations).toEqual(['Mobius and Co', 'Møbius']);
    expect(a.aliases).toEqual([
      { id: 20, name: 'Sølo Act' },
      { id: 21, name: 'Alter Ego' },
    ]);
    expect(a.groups).toEqual([{ id: 30, name: 'The Collective' }]);
    expect(a.members).toEqual([
      { id: 40, name: 'First Member' },
      { id: 41, name: 'Second Member' },
    ]);
  });

  it('ignores the redundant bare <id> elements inside <members>', () => {
    const a = parseArtist(lines.find((l) => l.includes('>10<')));
    // Two members despite four <id>/<name id> tokens in the block.
    expect(a.members).toHaveLength(2);
    expect(a.members.every((m) => typeof m.name === 'string' && m.name)).toBe(true);
  });

  it('parses an artist with no relations or variations', () => {
    const a = parseArtist(lines.find((l) => l.includes('>11<')));
    expect(a).toEqual({
      id: 11,
      name: 'Lonely Solo',
      namevariations: [],
      aliases: [],
      groups: [],
      members: [],
    });
  });

  it('decodes named, decimal, and hex XML entities in names', () => {
    const a = parseArtist(lines.find((l) => l.includes('>12<')));
    expect(a.name).toBe('Sunn O)))'); // non-entity parens untouched
    expect(a.namevariations).toEqual(['Café del Mar']); // &#233;
    expect(a.aliases).toEqual([
      { id: 50, name: 'R&B Star' }, // &amp;
      { id: 51, name: '♫ Music' }, // &#x266B;
    ]);
  });

  it('returns null for non-artist input', () => {
    expect(parseArtist('<artists>')).toBeNull();
    expect(parseArtist('<?xml version="1.0"?>')).toBeNull();
    expect(parseArtist('')).toBeNull();
    expect(parseArtist(null)).toBeNull();
  });

  it('tolerates a record split across physical lines (buffered slice)', () => {
    const multiline = '<artist>\n  <id>99</id>\n  <name>Wrapped Name</name>\n</artist>';
    const a = parseArtist(multiline);
    expect(a.id).toBe(99);
    expect(a.name).toBe('Wrapped Name');
  });
});

describe('decodeEntities', () => {
  it('leaves an escaped ampersand literal without over-decoding the tail', () => {
    // &amp;lt; is a literal "&lt;", not "<".
    expect(decodeEntities('a &amp;lt; b')).toBe('a &lt; b');
  });

  it('returns empty string for falsy input', () => {
    expect(decodeEntities('')).toBe('');
    expect(decodeEntities(undefined)).toBe('');
  });
});
