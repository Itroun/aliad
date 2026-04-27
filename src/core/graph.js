import { normaliseName } from './merge.js';

// Turn a per-artist lookup result set into the graph shape the UI renders:
//   { clusters: [{ id, nodes, edges }], singletons: [...] }
//
// Input entries have the shape produced by `lookupAll`:
//   { name, merged: { aliases, groups, members, relatedProjects }, closure: Set<string> }
// where `closure` is the set of normalised identity names reached during expansion.
//
// Clustering is union-find over closure overlaps. Edges between two lineup entries
// A and B are derived from identities shared by A.merged and B.merged — for each
// such bridge P we emit evidence describing how P relates to A and how P relates
// to B (e.g. "Dick Trevor: aka Dickster · member of Bumbling Loons").

const BUCKET_TO_REL = {
  aliases: 'aka',
  members: 'member of',
  groups: 'group of',
  relatedProjects: 'related to',
};

function relForEntry(bucket, entry) {
  // Via-mediated groups/related-projects: the framing depends on how we got
  // there. An alias-only chain means the root really is a member of the
  // group (just under another name) — say so. A chain that took a member
  // step is a side-project of someone in the group, not the root itself.
  if ((bucket === 'groups' || bucket === 'relatedProjects') && entry?.via) {
    return entry.viaHadMemberStep ? 'side project of' : 'member of';
  }
  return BUCKET_TO_REL[bucket];
}

function collectRelations(merged) {
  const rels = new Map();
  for (const bucket of ['aliases', 'members', 'groups', 'relatedProjects']) {
    for (const entry of merged?.[bucket] ?? []) {
      const key = normaliseName(entry?.name);
      if (!key) continue;
      if (!rels.has(key)) {
        rels.set(key, {
          displayName: entry.name,
          rel: relForEntry(bucket, entry),
          viaKey: normaliseName(entry?.via),
        });
      }
    }
  }
  return rels;
}

function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  return { find, union };
}

function buildEdge(A, B) {
  const aKey = normaliseName(A.name);
  const bKey = normaliseName(B.name);
  const aRels = collectRelations(A.merged);
  const bRels = collectRelations(B.merged);

  const evidence = [];
  const seenPersons = new Set();

  const pushEvidence = (personKey, person, hops) => {
    if (seenPersons.has(personKey)) return;
    seenPersons.add(personKey);
    evidence.push({ person, hops });
  };

  // A "person-bridge" row is a shared identity that appears as a person on
  // both sides (member-of or aka). When one exists, every via-mediated row —
  // direct or bridge — is redundant noise: the same connector is already
  // covered by the person-bridge row, just expressed honestly.
  const isPersonRel = (rel) => rel === 'member of' || rel === 'aka';
  let hasPersonBridge = false;
  for (const [key, aEntry] of aRels) {
    if (key === aKey || key === bKey) continue;
    const bEntry = bRels.get(key);
    if (!bEntry) continue;
    if (isPersonRel(aEntry.rel) && isPersonRel(bEntry.rel)) {
      hasPersonBridge = true;
      break;
    }
  }

  // Direct relationship: B appears in A's merged (or vice-versa) — one-hop.
  // Suppressed entirely when a person-bridge exists: the people are the more
  // informative connector, and band-to-band rows ("X aka Y") are redundant
  // when we can already point at the specific shared members.
  if (aRels.has(bKey) && !hasPersonBridge) {
    const entry = aRels.get(bKey);
    pushEvidence(bKey, entry.displayName || B.name, [{ rel: entry.rel, with: A.name }]);
  }
  if (bRels.has(aKey) && !hasPersonBridge && !seenPersons.has(aKey)) {
    const entry = bRels.get(aKey);
    pushEvidence(aKey, entry.displayName || A.name, [{ rel: entry.rel, with: B.name }]);
  }

  // Bridge identities present in both A and B's merged buckets.
  for (const [key, aEntry] of aRels) {
    if (key === aKey || key === bKey) continue;
    const bEntry = bRels.get(key);
    if (!bEntry) continue;
    if ((aEntry.viaKey || bEntry.viaKey) && hasPersonBridge) continue;
    pushEvidence(key, aEntry.displayName || bEntry.displayName, [
      { rel: aEntry.rel, with: A.name },
      { rel: bEntry.rel, with: B.name },
    ]);
  }

  if (evidence.length === 0) return null;
  return { a: A.name, b: B.name, evidence };
}

export function buildGraph(perArtistResults) {
  const entries = (perArtistResults ?? []).filter((r) => normaliseName(r?.name));
  const n = entries.length;
  if (n === 0) return { clusters: [], singletons: [] };

  const keyToIndex = new Map();
  entries.forEach((r, i) => {
    const key = normaliseName(r.name);
    if (!keyToIndex.has(key)) keyToIndex.set(key, i);
  });

  const { find, union } = unionFind(n);

  // Union via lineup names appearing in each other's closure.
  entries.forEach((r, i) => {
    const closure = r?.closure;
    if (!closure) return;
    for (const key of closure) {
      const j = keyToIndex.get(key);
      if (j !== undefined && j !== i) union(i, j);
    }
  });

  // Union via shared non-lineup bridge identities — handles cases where
  // expansion reached a common person but didn't walk through to the other
  // lineup act (e.g. budget exhausted).
  const keyToEntries = new Map();
  entries.forEach((r, i) => {
    const ownKey = normaliseName(r.name);
    for (const key of r?.closure ?? []) {
      if (key === ownKey) continue;
      if (keyToIndex.has(key)) continue; // already handled above
      if (!keyToEntries.has(key)) keyToEntries.set(key, []);
      keyToEntries.get(key).push(i);
    }
  });
  for (const indices of keyToEntries.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  const rootToIndices = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!rootToIndices.has(root)) rootToIndices.set(root, []);
    rootToIndices.get(root).push(i);
  }

  const clusters = [];
  const singletons = [];
  const sortedRoots = [...rootToIndices.keys()].sort((a, b) => a - b);

  for (const root of sortedRoots) {
    const indices = rootToIndices.get(root).sort((a, b) => a - b);
    if (indices.length < 2) {
      singletons.push(entries[indices[0]].name);
      continue;
    }
    const nodes = indices.map((i) => entries[i].name);
    const edges = [];
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const edge = buildEdge(entries[indices[i]], entries[indices[j]]);
        if (edge) edges.push(edge);
      }
    }
    clusters.push({ id: `c${root}`, nodes, edges });
  }

  return { clusters, singletons };
}
