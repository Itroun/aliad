import { describe, it, expect } from 'vitest';
import {
  detectInputType,
  extractArtists,
  callLLM,
  looksUnderExtracted,
  combineExtractions,
} from '../src/core/extract.js';
import messy from './fixtures/openrouter-extract-messy-text.json';
import html from './fixtures/openrouter-extract-html.json';
import { PRIMARY, FALLBACK } from '../src/core/models.js';

// Build an OpenRouter chat-completions response wrapping a model's raw text.
const orResponse = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

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
  it('parses a valid OpenRouter response', async () => {
    const fetchFn = async () => new Response(JSON.stringify(messy));
    const result = await callLLM(
      {
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        model: PRIMARY,
      },
      { fetchFn },
    );
    expect(result.artists).toContain('Shpongle');
  });

  it('sends the system prompt as a leading message', async () => {
    let sent;
    const fetchFn = async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return new Response(JSON.stringify(orResponse('{"artists":["X"]}')));
    };
    await callLLM(
      { system: 'SYS', messages: [{ role: 'user', content: 'U' }], model: PRIMARY },
      { fetchFn },
    );
    expect(sent.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'U' },
    ]);
  });

  it('handles markdown-fenced JSON in response', async () => {
    const fenced = orResponse('```json\n{"artists":["Test"],"discoveredAliases":[]}\n```');
    const fetchFn = async () => new Response(JSON.stringify(fenced));
    const result = await callLLM(
      {
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        model: PRIMARY,
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
          model: PRIMARY,
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
  it('uses parseLineup for clean text', async () => {
    const result = await extractArtists('Infected Mushroom\nShpongle', { type: 'clean-text' });
    expect(result.artists).toEqual(['Infected Mushroom', 'Shpongle']);
  });

  it('calls LLM for messy text', async () => {
    const fetchFn = async () => new Response(JSON.stringify(messy));
    const result = await extractArtists('Infected Mushroom, Shpongle, Aphex Twin, and more...', {
      type: 'messy-text',
      fetchFn,
    });
    expect(result.artists).toContain('Infected Mushroom');
    expect(result.artists).toContain('Shpongle');
  });

  it('calls LLM for html type', async () => {
    const fetchFn = async () => new Response(JSON.stringify(html));
    const result = await extractArtists('Some festival page content about Dado vs Dino Psaras...', {
      type: 'html',
      fetchFn,
    });
    expect(result.artists).toContain('Dado vs Dino Psaras');
  });

  it('falls back to the stronger model when the primary returns suspiciously few artists for a large input', async () => {
    const calls = [];
    const primaryResponse = orResponse('{"artists":["One","Two"],"discoveredAliases":[]}');
    const fallbackResponse = orResponse(
      '{"artists":["A","B","C","D","E","F","G","H"],"discoveredAliases":[]}',
    );
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === PRIMARY) return new Response(JSON.stringify(primaryResponse));
      return new Response(JSON.stringify(fallbackResponse));
    };
    const bigInput = 'x'.repeat(5000);
    const result = await extractArtists(bigInput, { type: 'html', fetchFn });
    expect(calls).toEqual([PRIMARY, FALLBACK]);
    expect(result.artists).toHaveLength(8);
  });

  it('keeps the primary result when the fallback returns fewer artists', async () => {
    const primaryResponse = orResponse('{"artists":["One","Two"],"discoveredAliases":[]}');
    const fallbackResponse = orResponse('{"artists":["Only"],"discoveredAliases":[]}');
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model === PRIMARY) return new Response(JSON.stringify(primaryResponse));
      return new Response(JSON.stringify(fallbackResponse));
    };
    const bigInput = 'x'.repeat(5000);
    const result = await extractArtists(bigInput, { type: 'html', fetchFn });
    expect(result.artists).toEqual(['One', 'Two']);
  });

  it('does not fall back for small inputs even with few artists', async () => {
    const calls = [];
    const primaryResponse = orResponse('{"artists":["One","Two"],"discoveredAliases":[]}');
    const fetchFn = async (_url, opts) => {
      calls.push(JSON.parse(opts.body).model);
      return new Response(JSON.stringify(primaryResponse));
    };
    await extractArtists('short lineup text', { type: 'messy-text', fetchFn });
    expect(calls).toEqual([PRIMARY]);
  });

  it('falls back to the stronger model when the primary returns empty', async () => {
    const calls = [];
    const emptyResponse = orResponse('{"artists":[],"discoveredAliases":[]}');
    const fallbackResponse = orResponse('{"artists":["Found"],"discoveredAliases":[]}');
    const fetchFn = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === PRIMARY) return new Response(JSON.stringify(emptyResponse));
      return new Response(JSON.stringify(fallbackResponse));
    };
    const result = await extractArtists('some messy content here', { type: 'messy-text', fetchFn });
    expect(calls).toEqual([PRIMARY, FALLBACK]);
    expect(result.artists).toEqual(['Found']);
  });
});
