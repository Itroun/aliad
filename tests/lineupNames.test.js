import { describe, it, expect } from 'vitest';
import { reRootOwner, splitBilling, stripPerformanceQualifier } from '../src/core/lineupNames.js';
import { normaliseName } from '../src/core/merge.js';

describe('splitBilling', () => {
  it('tags a collaboration billing as collab', () => {
    expect(splitBilling('Skizologic vs Filteria')).toEqual({
      parts: ['Skizologic', 'Filteria'],
      kind: 'collab',
    });
    expect(splitBilling('Astrix b2b Vini Vici').kind).toBe('collab');
    expect(splitBilling('Antidot & DICA').kind).toBe('collab');
    expect(splitBilling('David Maurette ft. Irina Mikhailova').kind).toBe('collab');
  });

  it('tags a one-artist-two-names billing as alias, not collab', () => {
    // Rendering these with the collab glyph (and announcing "collaboration")
    // would state something untrue: it's one artist.
    expect(splitBilling('Robert Leiner aka The Source Experience')).toEqual({
      parts: ['Robert Leiner', 'The Source Experience'],
      kind: 'alias',
    });
    expect(splitBilling('Mathew Jonson presents Freedom Engine').kind).toBe('alias');
  });

  it('returns null for an ordinary single name', () => {
    expect(splitBilling('Infected Mushroom')).toBeNull();
    expect(splitBilling('Benji Vaughan (Prometheus)')).toBeNull();
    expect(splitBilling('')).toBeNull();
    expect(splitBilling(null)).toBeNull();
  });
});

describe('reRootOwner', () => {
  it('gives the re-root to the first row that strips to the base', () => {
    const roots = ['Etnica in Dub', 'Etnica Live'];
    expect(reRootOwner(roots, 'etnica', normaliseName)).toBe('Etnica in Dub');
  });

  it('returns null when no row strips to that base', () => {
    expect(reRootOwner(['Shpongle'], 'etnica', normaliseName)).toBeNull();
    expect(reRootOwner([], 'etnica', normaliseName)).toBeNull();
  });
});

describe('stripPerformanceQualifier', () => {
  it('strips trailing performance-mode qualifiers', () => {
    expect(stripPerformanceQualifier('Etnica in DUB')).toBe('Etnica');
    expect(stripPerformanceQualifier('Etnica In Dub')).toBe('Etnica');
    expect(stripPerformanceQualifier('Zion Train Sound System')).toBe('Zion Train');
    expect(stripPerformanceQualifier('Zion Train Soundsystem')).toBe('Zion Train');
    expect(stripPerformanceQualifier('Nightmares on Wax Acoustic')).toBe('Nightmares on Wax');
    expect(stripPerformanceQualifier('Freedom Engine Live')).toBe('Freedom Engine');
  });

  it('only matches at the end, so a qualifier word inside a name survives', () => {
    // All three are real artists that resolve directly — the rule must not fire.
    expect(stripPerformanceQualifier('Gabi Von Dub')).toBeNull();
    expect(stripPerformanceQualifier('Kukan dub Lagan')).toBeNull();
    expect(stripPerformanceQualifier('Synergy Dub')).toBeNull();
    expect(stripPerformanceQualifier('Live Skull')).toBeNull();
    expect(stripPerformanceQualifier('Dub Fx')).toBeNull();
  });

  it('returns null when there is no qualifier', () => {
    expect(stripPerformanceQualifier('Prometheus')).toBeNull();
    expect(stripPerformanceQualifier('')).toBeNull();
    expect(stripPerformanceQualifier(null)).toBeNull();
    expect(stripPerformanceQualifier(undefined)).toBeNull();
  });

  it('refuses to strip down to a stub', () => {
    // "Dub" alone is not a lookup worth making.
    expect(stripPerformanceQualifier('X in Dub')).toBeNull();
    expect(stripPerformanceQualifier('AB Live')).toBeNull();
  });

  it('is idempotent — a stripped name has nothing left to strip', () => {
    const once = stripPerformanceQualifier('Etnica in DUB');
    expect(stripPerformanceQualifier(once)).toBeNull();
  });
});
