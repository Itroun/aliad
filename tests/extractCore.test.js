import { describe, it, expect, vi } from 'vitest';
import { parseArtists, looksUnderExtracted, runExtraction } from '../src/core/extractCore.js';
import { PRIMARY, FALLBACK } from '../src/core/models.js';

describe('parseArtists', () => {
  it('parses a plain JSON artist list', () => {
    expect(parseArtists('{"artists":["Shpongle","Ott"]}')).toEqual(['Shpongle', 'Ott']);
  });

  it('unwraps a markdown-fenced JSON object', () => {
    expect(parseArtists('```json\n{"artists":["Test"]}\n```')).toEqual(['Test']);
  });

  it('returns [] when the object has no artists array', () => {
    expect(parseArtists('{"foo":1}')).toEqual([]);
    expect(parseArtists('{"artists":null}')).toEqual([]);
  });

  it('throws on unparseable / truncated output', () => {
    expect(() => parseArtists('{"artists":["A","B"')).toThrow(/parse/i);
    expect(() => parseArtists('not json at all')).toThrow(/parse/i);
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

describe('runExtraction (server-side tier selection)', () => {
  it('runs only the cheap model for a small input with a few artists', async () => {
    const runModel = vi.fn(async () => ({ artists: ['One', 'Two'] }));
    const result = await runExtraction({ inputChars: 400, runModel });
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(runModel).toHaveBeenCalledWith(PRIMARY);
    expect(result.artists).toEqual(['One', 'Two']);
  });

  it('escalates to the stronger model when the cheap one under-extracts, keeping the larger list', async () => {
    const runModel = vi.fn(async (model) =>
      model === PRIMARY
        ? { artists: ['One', 'Two'] }
        : { artists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
    );
    const result = await runExtraction({ inputChars: 5000, runModel });
    expect(runModel.mock.calls.map((c) => c[0])).toEqual([PRIMARY, FALLBACK]);
    expect(result.artists).toHaveLength(8);
  });

  it('keeps the cheap result when the escalation returns fewer artists', async () => {
    const runModel = vi.fn(async (model) =>
      model === PRIMARY ? { artists: ['One', 'Two'] } : { artists: ['Only'] },
    );
    const result = await runExtraction({ inputChars: 5000, runModel });
    expect(result.artists).toEqual(['One', 'Two']);
  });

  it('escalates when the cheap model throws (truncated / unparseable), taking the fallback', async () => {
    const runModel = vi.fn(async (model) => {
      if (model === PRIMARY) throw new Error('parse failed');
      return { artists: ['Recovered'] };
    });
    const result = await runExtraction({ inputChars: 5000, runModel });
    expect(runModel.mock.calls.map((c) => c[0])).toEqual([PRIMARY, FALLBACK]);
    expect(result.artists).toEqual(['Recovered']);
  });

  it('escalates when the cheap model returns empty', async () => {
    const runModel = vi.fn(async (model) =>
      model === PRIMARY ? { artists: [] } : { artists: ['Found'] },
    );
    const result = await runExtraction({ inputChars: 300, runModel });
    expect(runModel.mock.calls.map((c) => c[0])).toEqual([PRIMARY, FALLBACK]);
    expect(result.artists).toEqual(['Found']);
  });

  it('propagates when both models fail', async () => {
    const runModel = vi.fn(async () => {
      throw new Error('parse failed');
    });
    await expect(runExtraction({ inputChars: 5000, runModel })).rejects.toThrow(/parse/i);
    expect(runModel).toHaveBeenCalledTimes(2);
  });

  it('keeps the cheap result when the escalation throws', async () => {
    const runModel = vi.fn(async (model) => {
      if (model === PRIMARY) return { artists: ['One', 'Two'] };
      throw new Error('fallback exploded');
    });
    const result = await runExtraction({ inputChars: 5000, runModel });
    expect(result.artists).toEqual(['One', 'Two']);
  });
});
