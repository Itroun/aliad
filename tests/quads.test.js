import { describe, it, expect } from 'vitest';
import {
  resultToQuads,
  quadsToResult,
  sourceKeyFor,
  PRED_AKA,
  PRED_MEMBER_OF,
  PRED_RELATED,
} from '../src/core/quads.js';
import { normaliseName } from '../src/core/merge.js';

// A mapped result as the providers' mappers produce it (`{ name, type, sourceUrl }`).
const sample = {
  aliases: [{ name: 'TA', type: 'Artist name', sourceUrl: 'https://mb/artist/1' }],
  groups: [{ name: 'The Band', type: 'Group', sourceUrl: 'https://mb/artist/2' }],
  members: [{ name: 'Side Person', type: 'Person', sourceUrl: 'https://mb/artist/3' }],
  relatedProjects: [{ name: 'Duo Project', type: 'Group', sourceUrl: 'https://mb/artist/4' }],
};

describe('resultToQuads / quadsToResult', () => {
  it('round-trips a full result for the producing subject', () => {
    const nameKey = normaliseName('Test Artist');
    const quads = resultToQuads('musicbrainz', nameKey, 'Test Artist', sample);
    const rebuilt = quadsToResult(nameKey, quads);
    expect(rebuilt).toEqual(sample);
  });

  it('orients members as member_of(member, subject) — reversed from groups', () => {
    const nameKey = normaliseName('Test Artist');
    const quads = resultToQuads('musicbrainz', nameKey, 'Test Artist', sample);

    const group = quads.find((q) => q.predicate === PRED_MEMBER_OF && q.subject === nameKey);
    expect(group.object).toBe(normaliseName('The Band'));

    const member = quads.find((q) => q.predicate === PRED_MEMBER_OF && q.object === nameKey);
    expect(member.subject).toBe(normaliseName('Side Person'));
    expect(member.subjectLabel).toBe('Side Person');
  });

  it('tags every quad with the producing source key and predicate types', () => {
    const nameKey = normaliseName('Test Artist');
    const quads = resultToQuads('musicbrainz', nameKey, 'Test Artist', sample);
    const sourceKey = sourceKeyFor('musicbrainz', nameKey);
    expect(quads.every((q) => q.sourceKey === sourceKey)).toBe(true);
    expect(new Set(quads.map((q) => q.predicate))).toEqual(
      new Set([PRED_AKA, PRED_MEMBER_OF, PRED_RELATED]),
    );
  });

  it('decomposes an empty result to no quads and rebuilds an empty result', () => {
    const nameKey = normaliseName('Nobody');
    const empty = { aliases: [], groups: [], members: [], relatedProjects: [] };
    const quads = resultToQuads('musicbrainz', nameKey, 'Nobody', empty);
    expect(quads).toEqual([]);
    expect(quadsToResult(nameKey, quads)).toEqual(empty);
  });

  it('skips entries whose name normalises to empty', () => {
    const nameKey = normaliseName('Test Artist');
    const dirty = {
      aliases: [{ name: '   ' }, { name: 'Real' }],
      groups: [],
      members: [],
      relatedProjects: [],
    };
    const quads = resultToQuads('musicbrainz', nameKey, 'Test Artist', dirty);
    expect(quads).toHaveLength(1);
    expect(quads[0].objectLabel).toBe('Real');
  });

  it('preserves per-bucket ordering through the round-trip', () => {
    const nameKey = normaliseName('X');
    const many = {
      aliases: [
        { name: 'A1', type: undefined, sourceUrl: undefined },
        { name: 'A2', type: undefined, sourceUrl: undefined },
      ],
      groups: [],
      members: [],
      relatedProjects: [],
    };
    const rebuilt = quadsToResult(nameKey, resultToQuads('discogs', nameKey, 'X', many));
    expect(rebuilt.aliases.map((a) => a.name)).toEqual(['A1', 'A2']);
  });

  it('reconstitution ignores quads from other source keys', () => {
    const nameKey = normaliseName('Test Artist');
    const mine = resultToQuads('musicbrainz', nameKey, 'Test Artist', sample);
    const other = resultToQuads('musicbrainz', normaliseName('Someone Else'), 'Someone Else', {
      aliases: [{ name: 'Test Artist', type: 'x', sourceUrl: 'u' }],
      groups: [],
      members: [],
      relatedProjects: [],
    });
    // quadsToResult filters by subject/object === nameKey, so a foreign quad that
    // happens to mention this subject as its OBJECT (aka) does not leak in as a member.
    const rebuilt = quadsToResult(nameKey, [...mine, ...other]);
    expect(rebuilt).toEqual(sample);
  });
});
