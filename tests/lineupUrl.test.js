import { describe, it, expect } from 'vitest';
import { encodeLineup, decodeLineup } from '../src/core/lineupUrl.js';

describe('lineupUrl', () => {
  it('round-trips a lineup through the fragment', async () => {
    const names = ['Atmos', 'Glass Reef', 'Sister Tundra VS Moth Parade'];
    const decoded = await decodeLineup(`#${await encodeLineup(names)}`);
    expect(decoded).toEqual(names);
  });

  it('encodes to a compact, URL-safe l= token', async () => {
    const frag = await encodeLineup(['Brooks & Bangs', 'a↔b']);
    expect(frag.startsWith('l=')).toBe(true);
    // base64url token: no whitespace, no +/=/& that would need escaping.
    expect(frag.slice(2)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('compresses a large repetitive lineup well below its raw length', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `Act Number ${i} vs Some Other Act`);
    const frag = await encodeLineup(names);
    const raw = names.join('\n').length;
    expect(frag.length).toBeLessThan(raw);
  });

  it('dedupes (case-insensitively) and drops blanks on encode', async () => {
    const decoded = await decodeLineup(
      `#${await encodeLineup(['Atmos', 'atmos', '  ', 'Filteria'])}`,
    );
    expect(decoded).toEqual(['Atmos', 'Filteria']);
  });

  it('returns null when there is nothing to persist', async () => {
    expect(await encodeLineup([])).toBeNull();
    expect(await encodeLineup(['  ', ''])).toBeNull();
    expect(await encodeLineup(null)).toBeNull();
  });

  it('decodes a token with or without the leading #', async () => {
    const frag = await encodeLineup(['Atmos']);
    expect(await decodeLineup(frag)).toEqual(['Atmos']);
    expect(await decodeLineup(`#${frag}`)).toEqual(['Atmos']);
  });

  it('returns null for an empty, missing, or foreign fragment', async () => {
    expect(await decodeLineup('')).toBeNull();
    expect(await decodeLineup('#')).toBeNull();
    expect(await decodeLineup('#theme=dark')).toBeNull();
    expect(await decodeLineup(undefined)).toBeNull();
  });

  it('isolates the l= token when the fragment carries other params', async () => {
    const frag = await encodeLineup(['Atmos']);
    // The active-view marker is appended after the lineup token.
    expect(await decodeLineup(`#${frag}&v=list`)).toEqual(['Atmos']);
    // …and tolerates the lineup token not coming first.
    expect(await decodeLineup(`#v=list&${frag}`)).toEqual(['Atmos']);
  });

  it('never throws on a malformed token', async () => {
    expect(await decodeLineup('#l=not-valid-gzip')).toBeNull();
    expect(await decodeLineup('#l=!!!!')).toBeNull();
  });

  it('rejects a decompression bomb instead of inflating it', async () => {
    // A tiny token that gunzips to ~5MB — well past the cap; must yield null,
    // not OOM. Built by gzipping a large payload through the same path.
    const bomb = 'x\n'.repeat(2_500_000); // ~5MB raw, compresses tiny
    const frag = await encodeLineup([bomb]);
    expect(await decodeLineup(`#${frag}`)).toBeNull();
  });

  it('preserves unicode act names', async () => {
    const names = ['Sigur Rós', 'Mötley Crüe'];
    expect(await decodeLineup(`#${await encodeLineup(names)}`)).toEqual(names);
  });
});
