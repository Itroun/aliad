import { describe, it, expect } from 'vitest';
import { buildGraph } from '../src/core/graph.js';
import { normaliseName } from '../src/core/merge.js';

function entry(name, { aliases = [], members = [], groups = [], relatedProjects = [] } = {}) {
  const toEntry = (n) => (typeof n === 'string' ? { name: n } : { ...n });
  const merged = {
    aliases: aliases.map(toEntry),
    members: members.map(toEntry),
    groups: groups.map(toEntry),
    relatedProjects: relatedProjects.map(toEntry),
  };
  const nameOf = (n) => (typeof n === 'string' ? n : n.name);
  const closure = new Set([
    normaliseName(name),
    ...aliases.map(nameOf).map(normaliseName),
    ...members.map(nameOf).map(normaliseName),
    ...groups.map(nameOf).map(normaliseName),
    ...relatedProjects.map(nameOf).map(normaliseName),
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

  it('drops side-project bridges that are downstream of a person-bridge', () => {
    // Etnica ↔ Pleiadians, shared member Maurizio. Crop Circles is reached
    // via Maurizio on both sides — it's redundant evidence.
    const per = [
      entry('Etnica', {
        members: ['Maurizio'],
        groups: [{ name: 'Crop Circles', via: 'Maurizio' }],
      }),
      entry('Pleiadians', {
        members: ['Maurizio'],
        groups: [{ name: 'Crop Circles', via: 'Maurizio' }],
      }),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence.map((e) => e.person)).toEqual(['Maurizio']);
  });

  it('keeps a side-project bridge when its via person is not itself a bridge', () => {
    // Budget cutoff scenario: Crop Circles shows up on both sides via
    // Maurizio, but Maurizio is not in either act's merged member list.
    const per = [
      entry('Etnica', {
        groups: [{ name: 'Crop Circles', via: 'Maurizio', viaHadMemberStep: true }],
      }),
      entry('Pleiadians', {
        groups: [{ name: 'Crop Circles', via: 'Maurizio', viaHadMemberStep: true }],
      }),
    ];
    // Force them into the same cluster via shared closure.
    for (const e of per) e.closure.add('crop circles');
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    const crop = edge.evidence.find((e) => e.person === 'Crop Circles');
    expect(crop).toBeTruthy();
    expect(crop.hops).toEqual([
      { rel: 'side project of', with: 'Etnica' },
      { rel: 'side project of', with: 'Pleiadians' },
    ]);
  });

  it('drops direct aka rows when a person-bridge already explains the edge', () => {
    // Etnica and Pleiadians are listed as aliases of each other AND share
    // four members. The shared-members rows are the informative explanation;
    // the band-to-band aka rows are noise.
    const per = [
      entry('Etnica', { aliases: ['Pleiadians'], members: ['Maurizio', 'Max'] }),
      entry('Pleiadians', { aliases: ['Etnica'], members: ['Maurizio', 'Max'] }),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence.map((e) => e.person)).toEqual(['Maurizio', 'Max']);
  });

  it('keeps a direct aka row when no person-bridge explains the edge', () => {
    // Pure alias relationship with no shared members surfaced — the aka row
    // is the only evidence we have, so it must stay.
    const per = [entry('Aphex Twin', { aliases: ['Polygon Window'] }), entry('Polygon Window')];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence.length).toBeGreaterThan(0);
    expect(edge.evidence[0].hops[0].rel).toBe('aka');
  });

  it('drops a direct via-mediated relation when a person-bridge already explains the edge', () => {
    // Bumbling Loons ↔ Green Nuns: each band shows up in the other's `groups`
    // bucket via Dick Trevor (a member of both). The Dick Trevor row covers
    // the connection; the via-mediated direct rows are misleading noise
    // ("X · side project of → Y" when really they share a member).
    const per = [
      entry('Bumbling Loons', {
        members: ['Dick Trevor'],
        groups: [{ name: 'Green Nuns of the Revolution', via: 'Dick Trevor' }],
      }),
      entry('Green Nuns of the Revolution', {
        members: ['Dick Trevor'],
        groups: [{ name: 'Bumbling Loons', via: 'Dick Trevor' }],
      }),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence.map((e) => e.person)).toEqual(['Dick Trevor']);
  });

  it('drops via-mediated bridges even when via-keys differ from the person-bridge name', () => {
    // Real-world drift: a member shows up under one display name as a member
    // (Dick Trevor) but their side-projects are credited under another name
    // (Richard Trevor / Muttley). The presence of *any* person-bridge row
    // should still suppress those via-mediated bridges.
    const per = [
      entry('Bumbling Loons', {
        members: ['Dick Trevor'],
        relatedProjects: [
          { name: 'Baguette Quartette', via: 'Richard Trevor' },
          { name: 'Citywide', via: 'Muttley' },
        ],
      }),
      entry('Green Nuns of the Revolution', {
        members: ['Dick Trevor'],
        relatedProjects: [
          { name: 'Baguette Quartette', via: 'Richard Trevor' },
          { name: 'Citywide', via: 'Muttley' },
        ],
      }),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence.map((e) => e.person)).toEqual(['Dick Trevor']);
  });

  it('renders alias-only via-chains as a 2-hop row through the via person', () => {
    // Filteria → (alias) Jannis Tzikas → (his groups) Ultravibe.
    // The connection should read "Jannis Tzikas, aka Filteria, member of
    // Ultravibe", not the misleading single-hop "Ultravibe member of Filteria".
    const per = [
      entry('Filteria', {
        aliases: ['Jannis Tzikas'],
        groups: [{ name: 'Ultravibe', via: 'Jannis Tzikas', viaHadMemberStep: false }],
      }),
      entry('Ultravibe'),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    const jannis = edge.evidence.find((e) => e.person === 'Jannis Tzikas');
    expect(jannis).toBeTruthy();
    expect(jannis.hops).toEqual([
      { rel: 'aka', with: 'Filteria' },
      { rel: 'member of', with: 'Ultravibe' },
    ]);
  });

  it('renders member-step via-chains as a 2-hop row through the member', () => {
    // Cosmosis → (member) Bill Halsey → (his groups) Ultravibe.
    // Should read "Bill Halsey, member of Cosmosis, member of Ultravibe".
    const per = [
      entry('Cosmosis', {
        members: ['Bill Halsey'],
        groups: [{ name: 'Ultravibe', via: 'Bill Halsey', viaHadMemberStep: true }],
      }),
      entry('Ultravibe'),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    const bill = edge.evidence.find((e) => e.person === 'Bill Halsey');
    expect(bill).toBeTruthy();
    expect(bill.hops).toEqual([
      { rel: 'member of', with: 'Cosmosis' },
      { rel: 'member of', with: 'Ultravibe' },
    ]);
  });

  it('drops a bridge where each side reached the shared name through a different via person', () => {
    // Filteria → Jannis Tzikas → Ultravibe; Cosmosis → Bill Halsey → Ultravibe.
    // The two acts share a connection *to* Ultravibe but not *to each other*;
    // emitting an edge between them via Ultravibe is misleading.
    const per = [
      entry('Filteria', {
        aliases: ['Jannis Tzikas'],
        groups: [{ name: 'Ultravibe', via: 'Jannis Tzikas', viaHadMemberStep: false }],
      }),
      entry('Cosmosis', {
        members: ['Bill Halsey'],
        groups: [{ name: 'Ultravibe', via: 'Bill Halsey', viaHadMemberStep: true }],
      }),
    ];
    // Force them into the same cluster via shared closure on the third act.
    for (const e of per) e.closure.add('ultravibe');
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges.find(
      (e) =>
        (e.a === 'Filteria' && e.b === 'Cosmosis') || (e.a === 'Cosmosis' && e.b === 'Filteria'),
    );
    expect(edge).toBeUndefined();
  });

  it('drops entries with no usable name', () => {
    const per = [entry(''), entry('Real'), { name: null }];
    const { singletons } = buildGraph(per);
    expect(singletons).toEqual(['Real']);
  });
});
