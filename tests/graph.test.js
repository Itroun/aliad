import { describe, it, expect } from 'vitest';
import { buildGraph, nodeKind } from '../src/core/graph.js';
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

describe('nodeKind', () => {
  it('classifies a split collab ("X vs Y") as collab', () => {
    expect(nodeKind({ parts: ['X', 'Y'], merged: { members: [{ name: 'A' }] } })).toBe('collab');
  });

  it('classifies an act with members as a group', () => {
    expect(nodeKind(entry('Band', { members: ['A', 'B'] }))).toBe('group');
  });

  it('classifies a memberless solo act as a person', () => {
    expect(nodeKind(entry('Solo', { groups: ['Some Band'] }))).toBe('person');
  });

  it('exposes a name → kind map from buildGraph', () => {
    const { kinds } = buildGraph([entry('Band', { members: ['A'] }), entry('Solo')]);
    expect(kinds.get('Band')).toBe('group');
    expect(kinds.get('Solo')).toBe('person');
  });
});

describe('buildGraph', () => {
  it('returns empty structure for empty input', () => {
    expect(buildGraph([])).toEqual({ clusters: [], singletons: [], kinds: new Map() });
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

  it('collapses multiple shared aliases of one person into a single connection', () => {
    // One human is Federico Baltimore, Dado, and also Synthetic / Frédéric
    // Holyszewski / Electric Boy. Two of those aliases are lineup acts (the solo
    // "Federico Baltimore" and the Dado half of "Dado vs Dino Psaras"), so the
    // other three each surface as an "aka Federico Baltimore · aka Dado" bridge —
    // all restating the single fact that the two acts are the same identity.
    const shared = ['Synthetic', 'Frédéric Holyszewski', 'Electric Boy'];
    const mk = (aliases) => ({
      aliases: aliases.map((n) => ({ name: n })),
      members: [],
      groups: [],
      relatedProjects: [],
    });
    const dadoMerged = mk(['Federico Baltimore', ...shared]);
    const combo = {
      name: 'Dado vs Dino Psaras',
      merged: mk(['Federico Baltimore', ...shared]),
      closure: new Set([
        normaliseName('Dado vs Dino Psaras'),
        'dado',
        'dino psaras',
        normaliseName('Federico Baltimore'),
        ...shared.map(normaliseName),
      ]),
      parts: ['Dado', 'Dino Psaras'],
      sources: [
        { name: 'Dado vs Dino Psaras', merged: mk(['Federico Baltimore', ...shared]) },
        { name: 'Dado', merged: dadoMerged },
        { name: 'Dino Psaras', merged: mk([]) },
      ],
    };
    const { clusters } = buildGraph([
      entry('Federico Baltimore', { aliases: ['Dado', ...shared] }),
      combo,
    ]);
    expect(clusters).toHaveLength(1);
    const edge = clusters[0].edges[0];
    // Three shared aliases (plus the direct aka the combo's Dado part carries)
    // all restate one identity, so they collapse to a single aka-only row that
    // links Federico Baltimore and Dado.
    expect(edge.evidence).toHaveLength(1);
    const row = edge.evidence[0];
    expect(row.hops.every((h) => h.rel === 'aka')).toBe(true);
    const names = new Set([row.person, ...row.hops.map((h) => h.with)].map(normaliseName));
    expect(names.has('dado')).toBe(true);
    expect(names.has(normaliseName('Federico Baltimore'))).toBe(true);
  });

  it('prefers a direct aka between the two nodes over a third-alias bridge', () => {
    // DOOF and Nick Barber are the same person (DOOF lists Nick Barber as an
    // alias), who also records as Sunyataji. The direct "DOOF aka Nick Barber"
    // link is the clearest connection; the Sunyataji bridge merely restates it,
    // so the edge should show a single direct aka row, not the third alias.
    const per = [
      entry('DOOF', { aliases: ['Nick Barber', 'Sunyataji'] }),
      entry('Nick Barber', { aliases: ['DOOF', 'Sunyataji'] }),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence).toHaveLength(1);
    expect(edge.evidence[0].person).not.toBe('Sunyataji');
    const names = new Set(
      [edge.evidence[0].person, ...edge.evidence[0].hops.map((h) => h.with)].map(normaliseName),
    );
    expect(names.has('doof')).toBe(true);
    expect(names.has(normaliseName('Nick Barber'))).toBe(true);
  });

  it('still lets a member-bridge suppress a band-to-band aka (alias-bridge does not)', () => {
    // Guard for the other direction: when the shared identity is a *member*
    // (Maurizio, Max), the band-to-band aka stays suppressed in its favour.
    const per = [
      entry('Etnica', { aliases: ['Pleiadians'], members: ['Maurizio', 'Max'] }),
      entry('Pleiadians', { aliases: ['Etnica'], members: ['Maurizio', 'Max'] }),
    ];
    const { clusters } = buildGraph(per);
    expect(clusters[0].edges[0].evidence.map((e) => e.person)).toEqual(['Maurizio', 'Max']);
  });

  it('keeps distinct shared members as separate connections (not collapsed)', () => {
    // Two different humans in both bands — same hop signature, but member-of, so
    // both must stay. Guards against the alias-collapse over-reaching.
    const per = [
      entry('Etnica', { members: ['Maurizio', 'Max'] }),
      entry('Pleiadians', { members: ['Maurizio', 'Max'] }),
    ];
    const { clusters } = buildGraph(per);
    expect(clusters[0].edges[0].evidence).toHaveLength(2);
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

  it('drops via-mediated side-project bridges when the two nodes are directly linked', () => {
    // Max is a member of Tecnica (direct, non-via link). Tecnica's *other*
    // member (Maurizio) is also in Pleiadians/Etnica, so those surface on
    // Tecnica's side via a member step ("side project of Tecnica") while Max
    // is in them directly. The direct "Max member of Tecnica" row already
    // explains the edge; the via-mediated band rows are redundant noise.
    const per = [
      entry('Max Lanfranconi', {
        groups: ['Pleiadians', 'Etnica', 'Tecnica'],
      }),
      entry('Tecnica', {
        members: ['Max Lanfranconi', 'Maurizio'],
        groups: [
          { name: 'Pleiadians', via: 'Maurizio', viaHadMemberStep: true },
          { name: 'Etnica', via: 'Maurizio', viaHadMemberStep: true },
        ],
      }),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    expect(edge.evidence.map((e) => e.person).sort()).toEqual(['Max Lanfranconi', 'Tecnica']);
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
    // Force them into the same union-find group via shared closure on the third
    // act. With no real edge between them, they're not actually a cluster — they
    // fall out as singletons rather than floating edgeless in one.
    for (const e of per) e.closure.add('ultravibe');
    const { clusters, singletons } = buildGraph(per);
    expect(clusters).toHaveLength(0);
    expect(singletons).toEqual(expect.arrayContaining(['Filteria', 'Cosmosis']));
  });

  it('drops entries with no usable name', () => {
    const per = [entry(''), entry('Real'), { name: null }];
    const { singletons } = buildGraph(per);
    expect(singletons).toEqual(['Real']);
  });

  it('attributes a collab bridge to the specific part, not the "X vs Y" combo', () => {
    // "Drop & Dash vs Germinator" ↔ "Psyko Disko vs Spies", bridged by Steve
    // Lavell, who is a member only of Germinator and of Psyko Disko. The combo
    // lookup itself also surfaces him (the case that used to force the fallback
    // to the combo name); attribution must still pin to the hosting part.
    const mergedOf = (members) => ({
      aliases: [],
      members: members.map((n) => ({ name: n })),
      groups: [],
      relatedProjects: [],
    });
    const collab = (name, parts, hostPart) => ({
      name,
      merged: mergedOf(['Steve Lavell']),
      closure: new Set([normaliseName(name), ...parts.map(normaliseName), 'steve lavell']),
      parts,
      sources: [
        { name, merged: mergedOf(['Steve Lavell']) }, // combo lookup also has him
        ...parts.map((p) => ({
          name: p,
          merged: mergedOf(p === hostPart ? ['Steve Lavell'] : []),
        })),
      ],
    });
    const per = [
      collab('Drop & Dash vs Germinator', ['Drop & Dash', 'Germinator'], 'Germinator'),
      collab('Psyko Disko vs Spies', ['Psyko Disko', 'Spies'], 'Psyko Disko'),
    ];
    const { clusters } = buildGraph(per);
    const edge = clusters[0].edges[0];
    const lavell = edge.evidence.find((e) => e.person === 'Steve Lavell');
    expect(lavell.hops).toEqual([
      { rel: 'member of', with: 'Germinator' },
      { rel: 'member of', with: 'Psyko Disko' },
    ]);
  });

  it('splits a collab bridge into one hop per part when a person hosts both', () => {
    // "Cosmosis vs Laughing Buddha" ↔ "Ultravibe", bridged by Bill Halsey, who is
    // a member of *both* combo parts and of Ultravibe. The combo side must emit a
    // hop per hosting part ("member of Cosmosis · member of Laughing Buddha")
    // rather than collapsing to the combo name.
    const mergedOf = (members) => ({
      aliases: [],
      members: members.map((n) => ({ name: n })),
      groups: [],
      relatedProjects: [],
    });
    const combo = {
      name: 'Cosmosis vs Laughing Buddha',
      merged: mergedOf(['Bill Halsey']),
      closure: new Set([
        normaliseName('Cosmosis vs Laughing Buddha'),
        'cosmosis',
        'laughing buddha',
        'bill halsey',
      ]),
      parts: ['Cosmosis', 'Laughing Buddha'],
      sources: [
        { name: 'Cosmosis vs Laughing Buddha', merged: mergedOf(['Bill Halsey']) },
        { name: 'Cosmosis', merged: mergedOf(['Bill Halsey']) },
        { name: 'Laughing Buddha', merged: mergedOf(['Bill Halsey']) },
      ],
    };
    const ultravibe = entry('Ultravibe', { members: ['Bill Halsey'] });
    const { clusters } = buildGraph([combo, ultravibe]);
    const edge = clusters[0].edges[0];
    const halsey = edge.evidence.find((e) => e.person === 'Bill Halsey');
    expect(halsey.hops).toEqual([
      { rel: 'member of', with: 'Cosmosis' },
      { rel: 'member of', with: 'Laughing Buddha' },
      { rel: 'member of', with: 'Ultravibe' },
    ]);
  });

  it('does not repeat a hop a via-mediated direct row already took through the bridge', () => {
    // Solo "Cosmosis" ↔ "Cosmosis vs Laughing Buddha": the combo's member Jeremy
    // is "member of Cosmosis · member of Laughing Buddha", and the combo also
    // surfaces the solo "Cosmosis" node in its groups *via* Jeremy. The direct
    // row therefore tacks "member of Cosmosis" onto Jeremy's own combo hops,
    // duplicating it. The two are the same hop and must collapse to one.
    const mergedOf = (members, groups = []) => ({
      aliases: [],
      members: members.map((n) => ({ name: n })),
      groups: groups.map((g) => (typeof g === 'string' ? { name: g } : g)),
      relatedProjects: [],
    });
    const combo = {
      name: 'Cosmosis vs Laughing Buddha',
      merged: mergedOf(['Jeremy Van Kampen'], [{ name: 'Cosmosis', via: 'Jeremy Van Kampen' }]),
      closure: new Set([
        normaliseName('Cosmosis vs Laughing Buddha'),
        'cosmosis',
        'laughing buddha',
        'jeremy van kampen',
      ]),
      parts: ['Cosmosis', 'Laughing Buddha'],
      sources: [
        {
          name: 'Cosmosis vs Laughing Buddha',
          merged: mergedOf(['Jeremy Van Kampen'], [{ name: 'Cosmosis', via: 'Jeremy Van Kampen' }]),
        },
        { name: 'Cosmosis', merged: mergedOf(['Jeremy Van Kampen']) },
        { name: 'Laughing Buddha', merged: mergedOf(['Jeremy Van Kampen']) },
      ],
    };
    const solo = entry('Cosmosis', { members: ['Jeremy Van Kampen'] });
    const { clusters } = buildGraph([solo, combo]);
    const edge = clusters[0].edges[0];
    const jeremy = edge.evidence.find((e) => e.person === 'Jeremy Van Kampen');
    expect(jeremy).toBeTruthy();
    expect(jeremy.hops).toEqual([
      { rel: 'member of', with: 'Cosmosis' },
      { rel: 'member of', with: 'Laughing Buddha' },
    ]);
  });

  describe('obvious same-named-part connections', () => {
    // Shared identity hosted by the SAME visibly-named part on both sides is a
    // link the user reads straight off the labels — not a reveal — so it's
    // dropped. The acts then fall out of the cluster they'd otherwise form.
    const mk = ({ aliases = [], members = [] } = {}) => ({
      aliases: aliases.map((n) => ({ name: n })),
      members: members.map((n) => ({ name: n })),
      groups: [],
      relatedProjects: [],
    });
    // A combo "X vs Y" whose parts each carry their own merged data; the combo's
    // own merged is the fusion of its parts, as the real pipeline produces.
    const combo = (name, partData) => {
      const parts = Object.keys(partData);
      const fuse = (k) => parts.flatMap((p) => partData[p][k] ?? []);
      const fused = mk({ aliases: fuse('aliases'), members: fuse('members') });
      return {
        name,
        merged: fused,
        closure: new Set([
          normaliseName(name),
          ...parts.map(normaliseName),
          ...[...fused.aliases, ...fused.members].map((e) => normaliseName(e.name)),
        ]),
        parts,
        sources: [
          { name, merged: fused },
          ...parts.map((p) => ({ name: p, merged: mk(partData[p]) })),
        ],
      };
    };

    it('does not cluster a solo act with a combo that just contains it as a part', () => {
      // "Process" (solo) ↔ "Process vs Aether": the only tie is that both ARE
      // Process (aka the same person on each side).
      const solo = entry('Process', { aliases: ['Sean Williams'] });
      const vs = combo('Process vs Aether', {
        Process: { aliases: ['Sean Williams'] },
        Aether: {},
      });
      const { clusters, singletons } = buildGraph([solo, vs]);
      expect(clusters).toHaveLength(0);
      expect(singletons).toEqual(expect.arrayContaining(['Process', 'Process vs Aether']));
    });

    it('treats a punctuation/spelling variant of the part name as the same act', () => {
      // "Ree.K" (solo) ↔ "DOMINO vs Ree-K": "Ree.K" and "Ree-K" normalise equal,
      // so the part is visibly the same act.
      const solo = entry('Ree.K', { aliases: ['Rie Kurihara'] });
      const vs = combo('DOMINO vs Ree-K', {
        DOMINO: {},
        'Ree-K': { aliases: ['Rie Kurihara'] },
      });
      const { clusters, singletons } = buildGraph([solo, vs]);
      expect(clusters).toHaveLength(0);
      expect(singletons).toEqual(expect.arrayContaining(['Ree.K', 'DOMINO vs Ree-K']));
    });

    it('does not cluster two combos that only share a visibly-named part', () => {
      // "Process vs Aether" ↔ "Process vs Bob": both labels say Process.
      const a = combo('Process vs Aether', {
        Process: { aliases: ['Sean Williams'] },
        Aether: {},
      });
      const b = combo('Process vs Bob', {
        Process: { aliases: ['Sean Williams'] },
        Bob: {},
      });
      const { clusters } = buildGraph([a, b]);
      expect(clusters).toHaveLength(0);
    });

    it('keeps a HIDDEN shared member between two combos that also share a part', () => {
      // Both say Process (obvious, dropped) but also secretly share a member
      // hosted by *different* parts (Aether vs Bob) — that's the real reveal.
      const a = combo('Process vs Aether', {
        Process: { aliases: ['Sean Williams'] },
        Aether: { members: ['Hidden Person'] },
      });
      const b = combo('Process vs Bob', {
        Process: { aliases: ['Sean Williams'] },
        Bob: { members: ['Hidden Person'] },
      });
      const { clusters } = buildGraph([a, b]);
      expect(clusters).toHaveLength(1);
      const persons = clusters[0].edges[0].evidence.map((e) => e.person);
      expect(persons).toContain('Hidden Person');
      expect(persons).not.toContain('Sean Williams');
    });
  });

  it('reduces a triangle to a star when the bridge is itself a lineup node', () => {
    // Moon Beasts (a lineup band) has two members who are also lineup acts under
    // their own names (Ephedra/Alexandre Cohen, Proxeeus/Jerome Lesterps). The
    // Moon Beasts↔Ephedra and Moon Beasts↔Proxeeus person-bridge edges fully
    // explain the cluster; a direct Ephedra↔Proxeeus edge bridged solely by
    // Moon Beasts (a visible node) just restates the hub and must be dropped.
    const moonBeasts = entry('Moon Beasts', {
      members: ['Ephedra', 'Proxeeus', 'Alexandre Cohen', 'Jerome Lesterps'],
    });
    const ephedra = entry('Ephedra', { groups: ['Moon Beasts'], aliases: ['Alexandre Cohen'] });
    const proxeeus = entry('Proxeeus', { groups: ['Moon Beasts'], aliases: ['Jerome Lesterps'] });
    const { clusters } = buildGraph([moonBeasts, ephedra, proxeeus]);
    expect(clusters).toHaveLength(1);

    const hasEdge = (x, y) =>
      clusters[0].edges.some((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x));
    expect(hasEdge('Moon Beasts', 'Ephedra')).toBe(true);
    expect(hasEdge('Moon Beasts', 'Proxeeus')).toBe(true);
    // The redundant hub-restating edge is gone.
    expect(hasEdge('Ephedra', 'Proxeeus')).toBe(false);
    expect(clusters[0].edges).toHaveLength(2);
  });

  it('keeps a shared-band edge when the band is NOT a lineup node', () => {
    // Same shape, but the shared band isn't on the lineup — so it has no point of
    // its own and the only way to show the two acts are bandmates is the edge
    // between them. It must survive.
    const ephedra = entry('Ephedra', { groups: ['Moon Beasts'] });
    const proxeeus = entry('Proxeeus', { groups: ['Moon Beasts'] });
    const { clusters } = buildGraph([ephedra, proxeeus]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].edges).toHaveLength(1);
    const bridge = clusters[0].edges[0].evidence.find((e) => e.person === 'Moon Beasts');
    expect(bridge).toBeTruthy();
  });
});
