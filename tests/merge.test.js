import { describe, it, expect } from 'vitest';
import { mergeResults, normaliseName } from '../src/core/merge.js';

describe('normaliseName', () => {
  it('lowercases, strips accents, collapses punctuation', () => {
    expect(normaliseName('Björk  Pálsdóttir!')).toBe('bjork palsdottir');
    expect(normaliseName('  FOO—bar  ')).toBe('foo bar');
    expect(normaliseName(null)).toBe('');
  });
});

describe('mergeResults', () => {
  it('deduplicates by normalised name across providers', () => {
    const a = {
      aliases: [{ name: 'AFX', sourceUrl: 'https://mb/afx' }],
      groups: [],
      members: [],
      relatedProjects: [],
    };
    const b = {
      aliases: [{ name: 'afx', sourceUrl: 'https://discogs/afx' }],
      groups: [],
      members: [],
      relatedProjects: [],
    };
    const merged = mergeResults(a, b);
    expect(merged.aliases).toHaveLength(1);
    expect(merged.aliases[0].sources).toEqual(['https://mb/afx', 'https://discogs/afx']);
  });

  it('keeps separate entries for different names', () => {
    const a = {
      aliases: [{ name: 'Polygon Window' }, { name: 'AFX' }],
      groups: [],
      members: [],
      relatedProjects: [],
    };
    const merged = mergeResults(a);
    expect(merged.aliases.map((x) => x.name).sort()).toEqual(['AFX', 'Polygon Window']);
  });

  it('tolerates missing buckets or empty input', () => {
    expect(mergeResults()).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
    expect(mergeResults({})).toEqual({ aliases: [], groups: [], members: [], relatedProjects: [] });
  });
});
