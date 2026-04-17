import { describe, it, expect } from 'vitest';
import { detectInputType, extractArtists, callLLM } from '../src/core/extract.js';
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
    const prose = 'This festival features Infected Mushroom alongside Shpongle performing their latest album live on the main stage';
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
      { system: 'test', messages: [{ role: 'user', content: 'test' }], model: 'claude-haiku-4-5-20251001' },
      { fetchFn },
    );
    expect(result.artists).toContain('Shpongle');
    expect(result.discoveredAliases).toHaveLength(2);
  });

  it('handles markdown-fenced JSON in response', async () => {
    const fenced = {
      content: [{ type: 'text', text: '```json\n{"artists":["Test"],"discoveredAliases":[]}\n```' }],
    };
    const fetchFn = async () => new Response(JSON.stringify(fenced));
    const result = await callLLM(
      { system: 'test', messages: [{ role: 'user', content: 'test' }], model: 'claude-haiku-4-5-20251001' },
      { fetchFn },
    );
    expect(result.artists).toEqual(['Test']);
  });

  it('throws on non-ok response', async () => {
    const fetchFn = async () => new Response('Server error', { status: 500 });
    await expect(
      callLLM(
        { system: 'test', messages: [{ role: 'user', content: 'test' }], model: 'claude-haiku-4-5-20251001' },
        { fetchFn },
      ),
    ).rejects.toThrow(/500/);
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
    const result = await extractArtists(
      'Infected Mushroom, Shpongle, Aphex Twin, and more...',
      { type: 'messy-text', fetchFn },
    );
    expect(result.artists).toContain('Infected Mushroom');
    expect(result.artists).toContain('Shpongle');
    expect(result.discoveredAliases.length).toBeGreaterThan(0);
  });

  it('calls LLM for html type', async () => {
    const fetchFn = async () => new Response(JSON.stringify(html));
    const result = await extractArtists(
      'Some festival page content about Dado vs Dino Psaras...',
      { type: 'html', fetchFn },
    );
    expect(result.artists).toContain('Dado vs Dino Psaras');
    expect(result.discoveredAliases[0].aliases).toContain('Deedrah');
  });

  it('falls back to Sonnet when Haiku returns empty', async () => {
    const calls = [];
    const emptyResponse = { content: [{ type: 'text', text: '{"artists":[],"discoveredAliases":[]}' }] };
    const sonnetResponse = { content: [{ type: 'text', text: '{"artists":["Found"],"discoveredAliases":[]}' }] };
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model.includes('haiku')) return new Response(JSON.stringify(emptyResponse));
      return new Response(JSON.stringify(sonnetResponse));
    };
    const result = await extractArtists('some messy content here', { type: 'messy-text', fetchFn });
    expect(calls).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514']);
    expect(result.artists).toEqual(['Found']);
  });
});
