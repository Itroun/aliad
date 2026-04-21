import { describe, it, expect } from 'vitest';
import { clusterArtists } from '../src/core/cluster.js';
import { normaliseName } from '../src/core/merge.js';

function result(name, reached = []) {
  return {
    name,
    merged: { aliases: [], groups: [], members: [], relatedProjects: [] },
    closure: new Set([normaliseName(name), ...reached.map(normaliseName)]),
  };
}

describe('clusterArtists', () => {
  it('clusters two inputs when one reaches the other in its closure', () => {
    const per = [
      result('Aphex Twin', ['AFX']),
      result('AFX', ['Aphex Twin']),
      result('Boards of Canada'),
    ];
    const { clusters, singletons } = clusterArtists(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].names).toEqual(['Aphex Twin', 'AFX']);
    expect(singletons).toHaveLength(1);
    expect(singletons[0].name).toBe('Boards of Canada');
  });

  it('clusters on a one-directional closure edge', () => {
    const per = [result('A', ['B']), result('B')];
    const { clusters, singletons } = clusterArtists(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].names).toEqual(['A', 'B']);
    expect(singletons).toHaveLength(0);
  });

  it('unions three inputs via transitive closure overlap', () => {
    const per = [result('A', ['B']), result('B', ['C']), result('C')];
    const { clusters } = clusterArtists(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].names).toEqual(['A', 'B', 'C']);
  });

  it('matches across casing and accents', () => {
    const per = [result('Björk', ['sigur ros']), result('SIGUR ROS')];
    const { clusters } = clusterArtists(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].names).toEqual(['Björk', 'SIGUR ROS']);
  });

  it('clusters via shared-member-of-group reached through closure', () => {
    // Mirrors Shpongle↔Hallucinogen via Simon Posford: expansion walks from
    // Shpongle (group) → Simon Posford (member) → Hallucinogen (his alias).
    const per = [result('Shpongle', ['Simon Posford', 'Hallucinogen']), result('Hallucinogen')];
    const { clusters } = clusterArtists(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].names).toEqual(['Shpongle', 'Hallucinogen']);
  });

  it('returns all inputs as singletons when no closure overlaps the lineup', () => {
    const per = [result('X', ['Something Else']), result('Y'), result('Z', ['Nobody Here'])];
    const { clusters, singletons } = clusterArtists(per);
    expect(clusters).toHaveLength(0);
    expect(singletons.map((s) => s.name)).toEqual(['X', 'Y', 'Z']);
  });

  it('returns empty structure for empty input', () => {
    expect(clusterArtists([])).toEqual({ clusters: [], singletons: [] });
  });

  it('preserves input order inside clusters and across the output', () => {
    const per = [result('C', ['A']), result('A', ['C']), result('B'), result('D', ['B'])];
    const { clusters, singletons } = clusterArtists(per);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].names).toEqual(['C', 'A']);
    expect(clusters[1].names).toEqual(['B', 'D']);
    expect(singletons).toHaveLength(0);
  });
});
