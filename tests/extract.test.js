import { describe, it, expect, vi } from 'vitest';
import {
  detectInputType,
  extractArtists,
  callExtract,
  combineExtractions,
} from '../src/core/extract.js';

// The proxy now returns the finished { artists, meta } — model-tier selection and
// LLM-reply parsing happen server-side (covered in tests/extractCore.test.js and
// tests/openrouter-endpoint.test.js). So the client just posts { kind, content }
// and reads the artist list back.
const proxyResponse = (artists, meta) =>
  new Response(JSON.stringify(meta ? { artists, meta } : { artists }));

describe('detectInputType', () => {
  it('returns clean for one-per-line input', () => {
    expect(detectInputType('Infected Mushroom\nShpongle\nAphex Twin')).toBe('clean');
  });

  it('returns messy for comma-separated names', () => {
    expect(detectInputType('Infected Mushroom, Shpongle, Aphex Twin')).toBe('messy');
  });

  it('returns messy for bulleted lists', () => {
    expect(detectInputType('- Infected Mushroom\n- Shpongle')).toBe('messy');
    expect(detectInputType('1. Infected Mushroom\n2. Shpongle')).toBe('messy');
  });

  it('returns messy for long prose lines', () => {
    const prose =
      'This festival features Infected Mushroom alongside Shpongle performing their latest album live on the main stage';
    expect(detectInputType(prose)).toBe('messy');
  });

  it('returns clean for empty input', () => {
    expect(detectInputType('')).toBe('clean');
    expect(detectInputType(null)).toBe('clean');
  });

  it('returns clean for short lines without separators', () => {
    expect(detectInputType('Astrix\nElectric Universe\nVini Vici')).toBe('clean');
  });
});

describe('callExtract', () => {
  it('posts only { kind, content } to the proxy', async () => {
    let sent;
    let url;
    const fetchFn = async (u, opts) => {
      url = u;
      sent = JSON.parse(opts.body);
      return proxyResponse(['X']);
    };
    const { artists } = await callExtract({ kind: 'html', content: 'page text' }, { fetchFn });
    expect(url).toBe('/api/openrouter');
    expect(sent).toEqual({ kind: 'html', content: 'page text' });
    // The server owns the prompt/schema/model — the client must not send them.
    expect(sent.messages).toBeUndefined();
    expect(sent.model).toBeUndefined();
    expect(artists).toEqual(['X']);
  });

  it('returns the meta block when present', async () => {
    const meta = { calls: [{ model: 'm', outputArtists: 1, durationMs: 5 }] };
    const fetchFn = async () => proxyResponse(['X'], meta);
    const result = await callExtract({ kind: 'text', content: 't' }, { fetchFn });
    expect(result.meta).toEqual(meta);
  });

  it('throws on a non-ok response', async () => {
    const fetchFn = async () => new Response('nope', { status: 502 });
    await expect(callExtract({ kind: 'text', content: 't' }, { fetchFn })).rejects.toThrow(/502/);
  });

  it('defaults artists to [] when the proxy omits them', async () => {
    const fetchFn = async () => new Response(JSON.stringify({}));
    const result = await callExtract({ kind: 'text', content: 't' }, { fetchFn });
    expect(result.artists).toEqual([]);
  });
});

describe('combineExtractions', () => {
  it('merges several extraction results into one deduped lineup', () => {
    const merged = combineExtractions([
      { artists: ['Atmos', 'Filteria'] },
      { artists: ['Filteria', 'DOOF'] },
    ]);
    expect(merged.artists).toEqual(['Atmos', 'Filteria', 'DOOF']);
  });

  it('dedupes case-insensitively across pages', () => {
    const merged = combineExtractions([{ artists: ['Shpongle'] }, { artists: ['shpongle'] }]);
    expect(merged.artists).toEqual(['Shpongle']);
  });

  it('skips empty / malformed results', () => {
    const merged = combineExtractions([{ artists: ['Atmos'] }, {}, null, { artists: null }]);
    expect(merged.artists).toEqual(['Atmos']);
  });

  it('returns an empty lineup for no input', () => {
    expect(combineExtractions([]).artists).toEqual([]);
    expect(combineExtractions().artists).toEqual([]);
  });
});

describe('extractArtists', () => {
  it('uses parseLineup for clean text (no network)', async () => {
    const result = await extractArtists('Infected Mushroom\nShpongle', { type: 'clean-text' });
    expect(result.artists).toEqual(['Infected Mushroom', 'Shpongle']);
  });

  it('returns an empty lineup for blank content without calling the proxy', async () => {
    const fetchFn = vi.fn();
    const result = await extractArtists('   ', { type: 'messy-text', fetchFn });
    expect(result.artists).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('extracts messy text via the proxy', async () => {
    const fetchFn = async () => proxyResponse(['Infected Mushroom', 'Shpongle']);
    const result = await extractArtists('Infected Mushroom, Shpongle, and more...', {
      type: 'messy-text',
      fetchFn,
    });
    expect(result.artists).toEqual(['Infected Mushroom', 'Shpongle']);
  });

  it('sends kind "html" for html input', async () => {
    let sent;
    const fetchFn = async (_u, opts) => {
      sent = JSON.parse(opts.body);
      return proxyResponse(['Dado vs Dino Psaras']);
    };
    const result = await extractArtists('Some festival page about Dado vs Dino Psaras...', {
      type: 'html',
      fetchFn,
    });
    expect(sent.kind).toBe('html');
    expect(result.artists).toContain('Dado vs Dino Psaras');
  });

  it('fires onCall for each server-side model call reported in meta', async () => {
    const meta = {
      calls: [
        { model: 'cheap', outputArtists: 2, durationMs: 100 },
        { model: 'strong', outputArtists: 6, durationMs: 400 },
      ],
    };
    const fetchFn = async () => proxyResponse(['A', 'B', 'C', 'D', 'E', 'F'], meta);
    const seen = [];
    await extractArtists('x'.repeat(50), { type: 'html', fetchFn, onCall: (c) => seen.push(c) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ model: 'cheap', outputArtists: 2, durationMs: 100 });
    expect(seen[0].inputChars).toBe(50);
    expect(seen[1]).toMatchObject({ model: 'strong', outputArtists: 6 });
  });

  it('propagates a proxy failure', async () => {
    const fetchFn = async () => new Response('busy', { status: 429 });
    await expect(
      extractArtists('some messy lineup text', { type: 'messy-text', fetchFn }),
    ).rejects.toThrow(/429/);
  });
});
