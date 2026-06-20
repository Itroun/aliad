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

const REL_BUCKETS = ['aliases', 'members', 'groups', 'relatedProjects'];

// How a specific source (part of a combo, or a solo act) relates to `key`, or
// null if that source doesn't host it. Returns the relation rather than a bare
// boolean so a person who belongs to multiple parts under *different* relations
// (member of one, aka of another) labels each hop correctly.
function sourceRelFor(merged, key) {
  for (const bucket of REL_BUCKETS) {
    for (const entry of merged?.[bucket] ?? []) {
      if (normaliseName(entry?.name) === key) return relForEntry(bucket, entry);
    }
  }
  return null;
}

// Build the relation map for a lineup entry. For collab combos ("X vs Y") the
// merged data fuses both halves; `sources` lets us pin each relation to the
// specific part(s) that actually host it via `rel.owners` ([{ name, rel }]),
// which falls back to the combo name only when no part hosts the relation.
function collectRelations(entry) {
  const merged = entry?.merged;
  const sources = entry?.sources?.length > 0 ? entry.sources : [{ name: entry?.name, merged }];

  const rels = new Map();
  for (const bucket of REL_BUCKETS) {
    for (const e of merged?.[bucket] ?? []) {
      const key = normaliseName(e?.name);
      if (!key) continue;
      if (!rels.has(key)) {
        rels.set(key, {
          displayName: e.name,
          rel: relForEntry(bucket, e),
          bucket,
          viaKey: normaliseName(e?.via),
          viaName: e?.via,
        });
      }
    }
  }

  // Attribute each relation to the specific *part(s)* that host it, so a collab
  // ("X vs Y") renders "member of Y" rather than "member of X vs Y". The combo
  // source itself is excluded from ownership: it represents the whole act, and
  // counting it would tie every relation back to the combo name (the bug this
  // avoids). Each owning part becomes its own hop — a person who belongs to
  // several parts (e.g. Bill Halsey, member of both Cosmosis and Laughing Buddha)
  // renders "member of Cosmosis · member of Laughing Buddha", not the combo name.
  // When *no* part hosts the relation (surfaced only by the combo's own lookup)
  // we keep the combo name, since we genuinely can't pin it to a part. Solo acts
  // have only the combo source, so `partSources` is empty and they fall back to
  // their own name as before.
  const comboKey = normaliseName(entry?.name);
  const partSources = sources.filter((s) => normaliseName(s.name) !== comboKey);
  for (const [key, rel] of rels) {
    const owners = [];
    for (const s of partSources) {
      const r = sourceRelFor(s.merged, key);
      if (r) owners.push({ name: s.name, rel: r });
    }
    rel.owners = owners.length > 0 ? owners : [{ name: entry?.name, rel: rel.rel }];
  }
  return rels;
}

const PERSON_BUCKETS = new Set(['aliases', 'members']);

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
  const aRels = collectRelations(A);
  const bRels = collectRelations(B);

  // Combo parts ("X vs Y" → X, Y) are already represented by the combo node
  // itself, so a bridge identity that *is* one of those parts is circular
  // noise — the real connection sits on a direct/person-bridge row.
  const aPartKeys = new Set((A.parts ?? []).map(normaliseName).filter(Boolean));
  const bPartKeys = new Set((B.parts ?? []).map(normaliseName).filter(Boolean));
  const isPartKey = (key) => aPartKeys.has(key) || bPartKeys.has(key);

  const evidence = [];
  const suppressed = [];
  const seenPersons = new Set();

  const pushEvidence = (personKey, person, hops) => {
    if (seenPersons.has(personKey)) return;
    seenPersons.add(personKey);
    evidence.push({ person, hops });
  };

  // A "person-bridge" row is a shared identity that appears as a person on
  // both sides (in aliases or members). When one exists, every via-mediated
  // row — direct or bridge — is redundant noise: the same connector is
  // already covered by the person-bridge row, just expressed honestly.
  let hasPersonBridge = false;
  for (const [key, aEntry] of aRels) {
    if (key === aKey || key === bKey || isPartKey(key)) continue;
    const bEntry = bRels.get(key);
    if (!bEntry) continue;
    if (PERSON_BUCKETS.has(aEntry.bucket) && PERSON_BUCKETS.has(bEntry.bucket)) {
      hasPersonBridge = true;
      break;
    }
  }

  const groupBucketRel = (entry) =>
    entry.bucket === 'relatedProjects' ? 'related to' : 'member of';

  // One hop per owning part — a person who belongs to several parts of a combo
  // contributes a hop for each ("member of Cosmosis · member of Laughing Buddha").
  // `owners` is always populated by collectRelations (falling back to the combo
  // name); `root` is a defensive fallback for entries built without it.
  const ownerHops = (entry, root) =>
    (entry.owners ?? [{ name: root, rel: entry.rel }]).map((o) => ({ rel: o.rel, with: o.name }));

  // Direct relationship: B appears in A's merged (or vice-versa).
  // For via-mediated entries (e.g. B reached through some member/alias X), we
  // emit the actual chain through X rather than a misleading single-hop row.
  // Suppressed entirely when a person-bridge exists.
  const pushDirect = (root, otherKey, otherName, otherRels, ownRels) => {
    if (!ownRels.has(otherKey)) return;
    const entry = ownRels.get(otherKey);
    if (entry.viaKey && ownRels.has(entry.viaKey)) {
      const via = ownRels.get(entry.viaKey);
      pushEvidence(entry.viaKey, via.displayName || entry.viaName, [
        ...ownerHops(via, root),
        { rel: groupBucketRel(entry), with: otherName },
      ]);
    } else {
      pushEvidence(otherKey, entry.displayName || otherName, ownerHops(entry, root));
    }
  };
  if (!hasPersonBridge) {
    pushDirect(A.name, bKey, B.name, bRels, aRels);
    if (!seenPersons.has(aKey)) pushDirect(B.name, aKey, A.name, aRels, bRels);
  }

  // Bridge identities present in both A and B's merged buckets.
  for (const [key, aEntry] of aRels) {
    if (key === aKey || key === bKey) continue;
    const bEntry = bRels.get(key);
    if (!bEntry) continue;
    if ((aEntry.viaKey || bEntry.viaKey) && hasPersonBridge) continue;
    // Drop weak via-via bridges where each side reached the shared name
    // through a different person — that's two acts both connected to a third
    // act, not actually connected to each other.
    if (aEntry.viaKey && bEntry.viaKey && aEntry.viaKey !== bEntry.viaKey) continue;
    const row = {
      key,
      person: aEntry.displayName || bEntry.displayName,
      hops: [...ownerHops(aEntry, A.name), ...ownerHops(bEntry, B.name)],
    };
    // A bridge that is itself a combo part is circular — hold it back as a
    // fallback so the edge survives if it had no other evidence.
    if (isPartKey(key)) suppressed.push(row);
    else pushEvidence(key, row.person, row.hops);
  }

  if (evidence.length === 0) {
    for (const row of suppressed) pushEvidence(row.key, row.person, row.hops);
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
