import { describe, it, expect } from 'vitest';
import { parseLineup } from '../src/ui/input.js';

describe('parseLineup', () => {
  it('splits on newlines, trims, and dedupes case-insensitively', () => {
    const text = '  Infected Mushroom\nShpongle\n\ninfected mushroom\n   \nAphex Twin\n';
    expect(parseLineup(text)).toEqual(['Infected Mushroom', 'Shpongle', 'Aphex Twin']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseLineup('')).toEqual([]);
    expect(parseLineup('   \n\n  ')).toEqual([]);
  });
});
