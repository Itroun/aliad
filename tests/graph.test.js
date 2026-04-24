import { describe, it, expect } from 'vitest';
import { buildGraph } from '../src/core/graph.js';
import { normaliseName } from '../src/core/merge.js';

function entry(name, { aliases = [], members = [], groups = [], relatedProjects = [] } = {}) {
  const merged = {
    aliases: aliases.map((n) => ({ name: n })),
    members: members.map((n) => ({ name: n })),
    groups: groups.map((n) => ({ name: n })),
    relatedProjects: relatedProjects.map((n) => ({ name: n })),
  };
  const closure = new Set([
    normaliseName(name),
    ...aliases.map(normaliseName),
    ...members.map(normaliseName),
    ...groups.map(normaliseName),
    ...relatedProjects.map(normaliseName),
  ]);
  return { name, merged, closure };
}

describe('buildGraph', () => {
  it('returns empty structure for empty input', () => {
    expect(buildGraph([])).toEqual({ clusters: [], singletons: [] });
  });

  it('puts isolated entries in singletons as plain strings', () => {
    const per = [entry('Atmos'), entry('Doof')];
    const { clusters, singletons } = buildGraph(per);
    expect(clusters).toEqual([]);
    expect(singletons).toEqual(['Atmos', 'Doof']);
  });

  it('builds a direct-alias edge (one hop) when B appears in A.aliases', () => {
    const per = [
      entry('Aphex Twin', { aliases: ['AFX'] }),
      entry('AFX', { aliases: ['Aphex Twin'] }),
    ];
    const { clusters, singletons } = buildGraph(per);
    expect(singletons).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].nodes).toEqual(['Aphex Twin', 'AFX']);
    expect(clusters[0].edges).toHaveLength(1);
    const edge = clusters[0].edges[0];
    expect(edge.a).toBe('Aphex Twin');
    expect(edge.b).toBe('AFX');
    expect(edge.evidence[0].hops[0].rel).toBe('aka');
  });

  it('builds a shared-member bridge edge with two hops', () => {
    // Etnica ↔ Pleiadians, bridge person "Maurizio"
    const per = [
      entry('Etnica', { members: ['Maurizio', 'Max'] }),
      entry('Pleiadians', { members: ['Maurizio', 'Max'] }),
    ];
    const { clusters } = buildGraph(per);
    expect(clusters).toHaveLength(1);
    const edge = clusters[0].edges[0];
    expect(edge.a).toBe('Etnica');
    expect(edge.b).toBe('Pleiadians');
    expect(edge.evidence).toHaveLength(2);
    const maurizio = edge.evidence.find((e) => e.person === 'Maurizio');
    expect(maurizio.hops).toEqual([
      { rel: 'member of', with: 'Etnica' },
      { rel: 'member of', with: 'Pleiadians' },
    ]);
  });

  it('combines aka + member-of hops for an alias-to-group bridge', () => {
    // Dickster.aliases = [Dick Trevor]; Bumbling Loons.members = [Dick Trevor]
    const per = [
      entry('Dickster', { aliases: ['Dick Trevor'], groups: ['Bumbling Loons'] }),
      entry('Bumbling Loons', { members: ['Dick Trevor'] }),
    ];
    const { clusters } = buildGraph(per);
    expect(clusters).toHaveLength(1);
    const edge = clusters[0].edges[0];
    const dickTrevor = edge.evidence.find((e) => e.person === 'Dick Trevor');
    expect(dickTrevor).toBeTruthy();
    expect(dickTrevor.hops).toEqual([
      { rel: 'aka', with: 'Dickster' },
      { rel: 'member of', with: 'Bumbling Loons' },
    ]);
  });

  it('emits an edge per pair inside a triangle cluster', () => {
    const per = [
      entry('Dickster', { aliases: ['Dick Trevor'], groups: ['Bumbling Loons', 'Green Nuns'] }),
      entry('Bumbling Loons', { members: ['Dick Trevor'] }),
      entry('Green Nuns', { members: ['Dick Trevor'] }),
    ];
    const { clusters } = buildGraph(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].nodes).toEqual(['Dickster', 'Bumbling Loons', 'Green Nuns']);
    expect(clusters[0].edges).toHaveLength(3);
  });

  it('clusters across casing and accents', () => {
    const per = [entry('Björk', { aliases: ['sigur ros'] }), entry('SIGUR ROS')];
    const { clusters } = buildGraph(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].nodes).toEqual(['Björk', 'SIGUR ROS']);
  });

  it('unions three entries via transitive closure overlap', () => {
    const per = [
      entry('A', { aliases: ['bridge'] }),
      entry('B', { aliases: ['bridge'] }),
      entry('C', { aliases: ['bridge'] }),
    ];
    // Simulate expansion: each act's closure includes "bridge" so they cluster together.
    for (const e of per) e.closure.add('bridge');
    const { clusters } = buildGraph(per);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].nodes).toEqual(['A', 'B', 'C']);
    expect(clusters[0].edges).toHaveLength(3);
  });

  it('gives each cluster a stable id string', () => {
    const per = [
      entry('A', { aliases: ['B'] }),
      entry('B'),
      entry('C', { aliases: ['D'] }),
      entry('D'),
    ];
    const { clusters } = buildGraph(per);
    expect(clusters.map((c) => c.id)).toEqual(['c0', 'c2']);
  });

  it('drops entries with no usable name', () => {
    const per = [entry(''), entry('Real'), { name: null }];
    const { singletons } = buildGraph(per);
    expect(singletons).toEqual(['Real']);
  });
});
