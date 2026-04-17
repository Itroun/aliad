import { describe, it, expect } from 'vitest';
import { createExtractionProvider } from '../src/core/extractionProvider.js';

describe('createExtractionProvider', () => {
  it('returns aliases for a matching artist', async () => {
    const provider = createExtractionProvider([
      { artist: 'Shpongle', aliases: ['Simon Posford', 'Hallucinogen'] },
    ]);
    expect(provider.name).toBe('extraction');
    expect(provider.minIntervalMs).toBe(0);

    const result = await provider.lookup('Shpongle');
    expect(result.aliases).toEqual([
      { name: 'Simon Posford', source: 'page content' },
      { name: 'Hallucinogen', source: 'page content' },
    ]);
  });

  it('matches case-insensitively', async () => {
    const provider = createExtractionProvider([
      { artist: 'Aphex Twin', aliases: ['Richard D. James'] },
    ]);
    const result = await provider.lookup('aphex twin');
    expect(result.aliases).toHaveLength(1);
    expect(result.aliases[0].name).toBe('Richard D. James');
  });

  it('returns empty result for unknown artist', async () => {
    const provider = createExtractionProvider([
      { artist: 'Shpongle', aliases: ['Simon Posford'] },
    ]);
    const result = await provider.lookup('Unknown Artist');
    expect(result.aliases).toEqual([]);
    expect(result.groups).toEqual([]);
    expect(result.members).toEqual([]);
    expect(result.relatedProjects).toEqual([]);
  });

  it('skips malformed entries', async () => {
    const provider = createExtractionProvider([
      { artist: null, aliases: ['X'] },
      { artist: 'Valid', aliases: 'not an array' },
      { artist: 'Good', aliases: ['Alias'] },
    ]);
    const result = await provider.lookup('Good');
    expect(result.aliases).toHaveLength(1);
  });
});
