import { describe, it, expect } from 'vitest';
import {
  detectInputType,
  extractArtists,
  callLLM,
  looksUnderExtracted,
} from '../src/core/extract.js';
import messy from './fixtures/anthropic-extract-messy-text.json';
import html from './fixtures/anthropic-extract-html.json';

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

describe('callLLM', () => {
  it('parses a valid Anthropic response', async () => {
    const fetchFn = async () => new Response(JSON.stringify(messy));
    const result = await callLLM(
      {
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        model: 'claude-haiku-4-5-20251001',
      },
      { fetchFn },
    );
    expect(result.artists).toContain('Shpongle');
    expect(result.discoveredAliases).toHaveLength(2);
  });

  it('handles markdown-fenced JSON in response', async () => {
    const fenced = {
      content: [
        { type: 'text', text: '```json\n{"artists":["Test"],"discoveredAliases":[]}\n```' },
      ],
    };
    const fetchFn = async () => new Response(JSON.stringify(fenced));
    const result = await callLLM(
      {
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        model: 'claude-haiku-4-5-20251001',
      },
      { fetchFn },
    );
    expect(result.artists).toEqual(['Test']);
  });

  it('throws on non-ok response', async () => {
    const fetchFn = async () => new Response('Server error', { status: 500 });
    await expect(
      callLLM(
        {
          system: 'test',
          messages: [{ role: 'user', content: 'test' }],
          model: 'claude-haiku-4-5-20251001',
        },
        { fetchFn },
      ),
    ).rejects.toThrow(/500/);
  });
});

describe('looksUnderExtracted', () => {
  it('flags empty output on non-trivial input', () => {
    expect(looksUnderExtracted([], 500)).toBe(true);
    expect(looksUnderExtracted([], 10)).toBe(false);
  });

  it('does not flag small inputs with a few artists', () => {
    expect(looksUnderExtracted(['A', 'B'], 400)).toBe(false);
    expect(looksUnderExtracted(['A'], 1500)).toBe(false);
  });

  it('flags large inputs with far fewer artists than expected', () => {
    expect(looksUnderExtracted(['A', 'B'], 5000)).toBe(true);
    expect(looksUnderExtracted(['A', 'B', 'C'], 10000)).toBe(true);
  });

  it('does not flag large inputs with plenty of artists', () => {
    expect(looksUnderExtracted(Array(30).fill('x'), 10000)).toBe(false);
  });
});

describe('extractArtists', () => {
  it('uses parseLineup for clean text', async () => {
    const result = await extractArtists('Infected Mushroom\nShpongle', { type: 'clean-text' });
    expect(result.artists).toEqual(['Infected Mushroom', 'Shpongle']);
    expect(result.discoveredAliases).toEqual([]);
  });

  it('calls LLM for messy text', async () => {
    const fetchFn = async () => new Response(JSON.stringify(messy));
    const result = await extractArtists('Infected Mushroom, Shpongle, Aphex Twin, and more...', {
      type: 'messy-text',
      fetchFn,
    });
    expect(result.artists).toContain('Infected Mushroom');
    expect(result.artists).toContain('Shpongle');
    expect(result.discoveredAliases.length).toBeGreaterThan(0);
  });

  it('calls LLM for html type', async () => {
    const fetchFn = async () => new Response(JSON.stringify(html));
    const result = await extractArtists('Some festival page content about Dado vs Dino Psaras...', {
      type: 'html',
      fetchFn,
    });
    expect(result.artists).toContain('Dado vs Dino Psaras');
    expect(result.discoveredAliases[0].aliases).toContain('Deedrah');
  });

  it('falls back to Sonnet when Haiku returns suspiciously few artists for a large input', async () => {
    const calls = [];
    const haikuResponse = {
      content: [{ type: 'text', text: '{"artists":["One","Two"],"discoveredAliases":[]}' }],
    };
    const sonnetResponse = {
      content: [
        {
          type: 'text',
          text: '{"artists":["A","B","C","D","E","F","G","H"],"discoveredAliases":[]}',
        },
      ],
    };
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model.includes('haiku')) return new Response(JSON.stringify(haikuResponse));
      return new Response(JSON.stringify(sonnetResponse));
    };
    const bigInput = 'x'.repeat(5000);
    const result = await extractArtists(bigInput, { type: 'html', fetchFn });
    expect(calls).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
    expect(result.artists).toHaveLength(8);
  });

  it('keeps Haiku result when Sonnet returns fewer artists on fallback', async () => {
    const haikuResponse = {
      content: [{ type: 'text', text: '{"artists":["One","Two"],"discoveredAliases":[]}' }],
    };
    const sonnetResponse = {
      content: [{ type: 'text', text: '{"artists":["Only"],"discoveredAliases":[]}' }],
    };
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model.includes('haiku')) return new Response(JSON.stringify(haikuResponse));
      return new Response(JSON.stringify(sonnetResponse));
    };
    const bigInput = 'x'.repeat(5000);
    const result = await extractArtists(bigInput, { type: 'html', fetchFn });
    expect(result.artists).toEqual(['One', 'Two']);
  });

  it('does not fall back for small inputs even with few artists', async () => {
    const calls = [];
    const haikuResponse = {
      content: [{ type: 'text', text: '{"artists":["One","Two"],"discoveredAliases":[]}' }],
    };
    const fetchFn = async (_url, opts) => {
      calls.push(JSON.parse(opts.body).model);
      return new Response(JSON.stringify(haikuResponse));
    };
    await extractArtists('short lineup text', { type: 'messy-text', fetchFn });
    expect(calls).toEqual(['claude-haiku-4-5']);
  });

  it('falls back to Sonnet when Haiku returns empty', async () => {
    const calls = [];
    const emptyResponse = {
      content: [{ type: 'text', text: '{"artists":[],"discoveredAliases":[]}' }],
    };
    const sonnetResponse = {
      content: [{ type: 'text', text: '{"artists":["Found"],"discoveredAliases":[]}' }],
    };
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model.includes('haiku')) return new Response(JSON.stringify(emptyResponse));
      return new Response(JSON.stringify(sonnetResponse));
    };
    const result = await extractArtists('some messy content here', { type: 'messy-text', fetchFn });
    expect(calls).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
    expect(result.artists).toEqual(['Found']);
  });
});
