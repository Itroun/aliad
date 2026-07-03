import { describe, it, expect } from 'vitest';
import { resolveWinner } from '../scripts/dump/resolveWinner.js';

const cand = (over) => ({ artist_id: 1, primary: true, suffixed: false, edges: 0, ...over });

describe('resolveWinner', () => {
  it('returns the sole candidate', () => {
    expect(resolveWinner([cand({ artist_id: 42 })])).toBe(42);
  });

  it('tier 1: a primary name beats a namevariation', () => {
    const winner = resolveWinner([
      cand({ artist_id: 2, primary: false, edges: 100 }), // namevariation, many edges
      cand({ artist_id: 3, primary: true, edges: 0 }), // primary, no edges
    ]);
    expect(winner).toBe(3);
  });

  it('tier 2: unsuffixed beats "(N)"-suffixed when both primary', () => {
    const winner = resolveWinner([
      cand({ artist_id: 4, suffixed: true, edges: 100 }),
      cand({ artist_id: 5, suffixed: false, edges: 0 }),
    ]);
    expect(winner).toBe(5);
  });

  it('tier 3: more identity edges wins when primary/suffix tie', () => {
    const winner = resolveWinner([
      cand({ artist_id: 6, edges: 3 }),
      cand({ artist_id: 7, edges: 9 }),
      cand({ artist_id: 8, edges: 1 }),
    ]);
    expect(winner).toBe(7);
  });

  it('tier 4: lowest artist id breaks a full tie', () => {
    const winner = resolveWinner([
      cand({ artist_id: 30, edges: 5 }),
      cand({ artist_id: 12, edges: 5 }),
      cand({ artist_id: 25, edges: 5 }),
    ]);
    expect(winner).toBe(12);
  });

  it('is order-independent (deterministic) across permutations', () => {
    const set = [
      cand({ artist_id: 10, primary: false, suffixed: true, edges: 2 }),
      cand({ artist_id: 11, primary: true, suffixed: true, edges: 0 }),
      cand({ artist_id: 12, primary: true, suffixed: false, edges: 1 }),
      cand({ artist_id: 13, primary: true, suffixed: false, edges: 1 }),
    ];
    // Expected winner: primary + unsuffixed + edges=1, lowest id => 12.
    const reversed = [...set].reverse();
    expect(resolveWinner(set)).toBe(12);
    expect(resolveWinner(reversed)).toBe(12);
  });

  it('treats missing edges as zero', () => {
    const winner = resolveWinner([
      { artist_id: 20, primary: true, suffixed: false },
      cand({ artist_id: 21, edges: 1 }),
    ]);
    expect(winner).toBe(21);
  });

  it('throws on empty or non-array input', () => {
    expect(() => resolveWinner([])).toThrow();
    expect(() => resolveWinner(null)).toThrow();
  });
});
