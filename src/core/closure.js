// Query-shaped identity traversal over the graph substrate (Phase 3a substrate,
// Phase 3b live).
//
// The crown-jewel expansion RULES that used to live in src/core/lookup.js's BFS
// now live HERE, re-expressed as a query: each "look up this node" is "read this
// node's edges from the graph" instead of a network round-trip. No I/O lives here
// — like quads.js, the module is pure and takes an injected async `neighbors`
// accessor (the fetchFn-injection convention used across the codebase), so tests
// drive it with an in-memory graph and production (functions/api/closure.js) wires
// it to functions/_lib/quadStore.js via quadsToResult.
//
// As of Phase 3b this is LIVE: functions/api/closure.js wires `neighbors` to
// handleLookup (cold/expired fetch + write) + getQuadsTouching (cross-lookup
// read), runs this query, and streams the walk back as SSE; the browser BFS in
// src/core/lookup.js has been deleted. Reading a node's edges ACROSS source_keys
// is what finally unions MB + Discogs into one cross-provider view — the
// cross-lookup edges Phase 2 deliberately deferred.

import { emptyResult } from '../providers/provider.js';
import { mergeResults, normaliseName } from './merge.js';

// Mirrors lookup.js: aliases of these types are shown in the UI but never walked —
// misspellings / phonetic variants / real names that rarely have their own graph.
const EXPAND_SKIP_TYPES = new Set(['Search hint', 'Legal name']);
const DEFAULT_MAX_LOOKUPS = 25;
const DEFAULT_FANOUT_CAP = 15;

function shouldExpandAlias(alias) {
  return !alias?.type || !EXPAND_SKIP_TYPES.has(alias.type);
}

// Shared-band signal for the foreign-identity guard: the groups a node is in
// plus its related projects. Deliberately EXCLUDES:
//   - `aka`: a poisoned alias string can appear verbatim on two unrelated pages
//     (e.g. a George Clinton alias mistakenly added to another artist), so
//     shared alias strings would create false overlap; shared bands do not.
//   - `members`: those are PEOPLE in a group, not bands the identity shares —
//     counting them lets a group's member roster masquerade as project overlap.
// An `aka` hop is person↔person, so common BANDS are the right same-identity tell
// (a group reached via alias is already handled by the looksLikeGroup rule).
function connectionKeys(node) {
  const keys = new Set();
  for (const bucket of [node?.groups, node?.relatedProjects]) {
    for (const entry of bucket ?? []) {
      const key = normaliseName(entry?.name);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function setsIntersect(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// Add a node's walkable alias names to the closure WITHOUT enqueueing them for a
// read — used where we want lineup-root matches to still cluster but don't want
// to spend lookups walking the aliases (fan-out cap; band-less stubs).
function registerWalkableAliases(visited, node) {
  for (const alias of (node?.aliases ?? []).filter(shouldExpandAlias)) {
    const key = normaliseName(alias?.name);
    if (key) visited.add(key);
  }
}

/**
 * Identity-closure query for one root over the graph.
 *
 * @param {string} rootName  Original-cased root name (normalised internally).
 * @param {object} opts
 * @param {(key: string) => Promise<{aliases,groups,members,relatedProjects}>} opts.neighbors
 *        Reconstituted, deduped cross-provider result for one normalised node key.
 *        Production: `(k) => mergeResults(quadsToResult(k, await store.getQuadsTouching(k)))`.
 * @param {Set<string>} [opts.rootKeys]  Normalised names of all lineup roots
 *        (drives the union/skip rule).
 * @param {number} [opts.maxLookups]  Pathology guard (was MAX_EXPANSION_LOOKUPS).
 * @param {number} [opts.fanoutCap]    Per-node alias fan-out cap.
 * @param {(merged) => void} [opts.onNode]  Fired with the running accumulated
 *        result after each node is merged in — the streaming hook the SSE
 *        endpoint uses to push progressive updates (mirrors lookup.js's
 *        per-node onArtistDone). Not fired for the initial root read.
 * @param {(info: {skipped: number}) => void} [opts.onBudgetExhausted]
 * @returns {Promise<{merged, closure: Set<string>}>}  Same shape expandIdentityGraph returns.
 *
 * `neighbors` receives the ORIGINAL-cased name (root, then each alias/member
 * name as it appears upstream) and normalises internally for its read — the
 * server endpoint needs the original name to drive cold MB/Discogs searches.
 */
export async function identityClosure(
  rootName,
  {
    neighbors,
    rootKeys = new Set(),
    maxLookups = DEFAULT_MAX_LOOKUPS,
    fanoutCap = DEFAULT_FANOUT_CAP,
    onNode,
    onBudgetExhausted,
    onWalkStats,
  } = {},
) {
  const ownRootKey = normaliseName(rootName);
  const visited = new Set();
  if (ownRootKey) visited.add(ownRootKey);

  // TEMP DIAGNOSTIC (alias-chain budget sizing, TODO.md "Long alias chains dodge
  // the fan-out cap"). Per-root tallies to decide between a flat alias cap vs a
  // barren-hop heuristic. Remove once the budget design is settled.
  const stats = {
    root: rootName,
    lookups: 0, // total budget spent (cold + cached node reads)
    aliasLookups: 0, // of those, reached via an `aka` hop
    memberLookups: 0, // of those, reached via a `member` hop
    aliasProductive: 0, // accepted alias node that added ≥1 new band/project
    aliasBarren: 0, // accepted alias node that added no new bands
    aliasAsGroup: 0, // alias node that turned out to be a group (skipped)
    aliasRejected: 0, // alias node rejected by the foreign-identity guard
    aliasRegisteredOnly: 0, // band-less alias stub: names registered, not walked
    maxAliasDepth: 0, // longest consecutive alias-hop chain from the root
    budgetExhausted: false,
    skipped: 0,
  };

  const initialMerged = (await neighbors(rootName)) ?? emptyResult();
  let accumulated = initialMerged;
  const pending = [];
  enqueueFromNode(pending, visited, initialMerged, [], rootKeys, fanoutCap, {
    parentKind: null,
    viaHadMemberStep: false,
    aliasDepth: 0,
  });
  let budget = maxLookups;
  const rejectedAliasKeys = new Set();

  // Projects that anchor this root's identity cluster. An `aka` hop asserts
  // "same person", so the resolved node should share at least one project with
  // the cluster. A node that brings ONLY foreign projects (a bad/ambiguous alias
  // string that resolves to an unrelated, often prolific artist) is rejected —
  // this stops a single poisoned alias edge from dragging a whole foreign
  // discography into the closure. Seeded from the root (and all lineup roots);
  // grows as nodes are accepted, so legit multi-hop chains keep discovering.
  const clusterConnections = new Set([ownRootKey, ...rootKeys].filter(Boolean));
  // The guard only fires once the cluster has at least one real project to judge
  // against — otherwise a legit alias-only chain whose first project appears
  // several hops in (A aka B aka C-with-a-group) would be cut at the project.
  let clusterHasProjects = false;
  const addConnections = (keys) => {
    for (const key of keys) {
      clusterConnections.add(key);
      clusterHasProjects = true;
    }
  };
  addConnections(connectionKeys(initialMerged));

  while (pending.length > 0 && budget > 0) {
    const item = pending.shift();
    const key = normaliseName(item.name);
    if (!key || visited.has(key)) continue;
    visited.add(key);

    // Another root's closure covers this identity sub-graph; recording the name
    // in `visited` is enough for clustering to union the two roots.
    if (rootKeys.has(key) && key !== ownRootKey) continue;

    budget--;

    // TEMP DIAGNOSTIC: classify this lookup by hop kind / chain depth.
    const isAlias = item.kind === 'alias';
    stats.lookups++;
    if (isAlias) {
      stats.aliasLookups++;
      if ((item.aliasDepth ?? 0) > stats.maxAliasDepth) stats.maxAliasDepth = item.aliasDepth ?? 0;
    } else if (item.kind === 'member') {
      stats.memberLookups++;
    }

    const nodeMerged = (await neighbors(item.name)) ?? emptyResult();

    // Suspected alias-of-group: a previous node listed this name as an alias, but
    // its own edges reveal members. Treat it as a group, not an identity of the
    // root — skip attribution and don't fan into co-members, otherwise
    // collaborators leak in as apparent aliases. Mirror lookup.js exactly.
    const looksLikeGroup = (nodeMerged.members ?? []).length > 0;
    if (item.kind === 'alias' && looksLikeGroup) {
      stats.aliasAsGroup++; // TEMP DIAGNOSTIC
      rejectedAliasKeys.add(key);
      continue;
    }

    // Foreign-identity guard (alias hops only). Reject a node that has bands of
    // its own, shares NONE with the cluster, AND was reached through a band-less
    // alias bridge. That combination is the signature of a poisoned alias edge: a
    // junk name-variation resolves to a bare stub that then points at an
    // unrelated (often prolific) artist, dragging in a whole foreign discography.
    // We DON'T reject merely-non-overlapping nodes reached straight from a
    // band-bearing node — that's the legit "same person, different band" case
    // alias-walking exists to find. The clusterHasProjects gate lets a band-less
    // root chain (A aka B aka C-with-a-band) define its cluster from C.
    const connKeys = connectionKeys(nodeMerged);
    if (
      item.kind === 'alias' &&
      connKeys.size > 0 &&
      clusterHasProjects &&
      !item.parentHasBands &&
      !setsIntersect(connKeys, clusterConnections)
    ) {
      stats.aliasRejected++; // TEMP DIAGNOSTIC
      rejectedAliasKeys.add(key);
      continue;
    }

    // Band-less alias stub under an established cluster: it can only point back to
    // known members (already visited) or into a foreign identity's mutually-aka'd
    // satellite clique (reverse edges) we don't want to read. Register its alias
    // names so lineup-root matches still cluster, but don't fan into them. Before
    // the cluster has any bands we still fan, so a band-less root chain can reach
    // its first real identity (A aka B aka C-with-a-band).
    if (item.kind === 'alias' && connKeys.size === 0 && clusterHasProjects) {
      stats.aliasRegisteredOnly++; // TEMP DIAGNOSTIC
      registerWalkableAliases(visited, nodeMerged);
      continue;
    }

    // TEMP DIAGNOSTIC: an accepted alias hop is "productive" if it contributes a
    // band/project the cluster didn't already have, else "barren" (the
    // spelling-variant case we're trying to size a budget against).
    if (isAlias) {
      let addedNew = false;
      for (const k of connKeys) {
        if (!clusterConnections.has(k)) {
          addedNew = true;
          break;
        }
      }
      if (addedNew) stats.aliasProductive++;
      else stats.aliasBarren++;
    }

    const viaChain = [item.name, ...item.viaChain];
    const via = item.name;
    const viaHadMemberStep = !!item.viaHadMemberStep;

    const attributed = {
      aliases: [],
      groups: nodeMerged.groups.map((e) => ({ ...e, via, viaChain, viaHadMemberStep })),
      members: nodeMerged.members.map((e) => ({ ...e, via, viaChain, viaHadMemberStep })),
      relatedProjects: nodeMerged.relatedProjects.map((e) => ({
        ...e,
        via,
        viaChain,
        viaHadMemberStep,
      })),
    };

    accumulated = mergeResults(accumulated, attributed);
    onNode?.(accumulated);

    // Accepted node's projects extend the cluster, so later alias hops can
    // overlap with identities discovered mid-walk, not just the root.
    addConnections(connKeys);

    enqueueFromNode(pending, visited, nodeMerged, viaChain, rootKeys, fanoutCap, {
      parentKind: item.kind,
      viaHadMemberStep,
      aliasDepth: item.aliasDepth ?? 0,
    });
  }

  if (budget === 0 && pending.length > 0) {
    onBudgetExhausted?.({ skipped: pending.length });
  }

  // TEMP DIAGNOSTIC: emit the per-root walk tally.
  stats.budgetExhausted = budget === 0 && pending.length > 0;
  stats.skipped = pending.length;
  onWalkStats?.(stats);

  if (rejectedAliasKeys.size > 0) {
    accumulated = {
      ...accumulated,
      aliases: accumulated.aliases.filter((a) => !rejectedAliasKeys.has(normaliseName(a?.name))),
    };
  }

  return { merged: accumulated, closure: visited };
}

function enqueueFromNode(pending, visited, node, viaChain, rootKeys, fanoutCap, ctx = {}) {
  const { parentKind = null, viaHadMemberStep = false, aliasDepth = 0 } = ctx;
  // Whether THIS node has bands of its own — propagated to its hops so the
  // foreign-identity guard can tell a legit "same person, different band" alias
  // (hopped from a band-bearing node) from a poisoned bridge (a band-less alias
  // stub that resolves to an unrelated artist).
  const parentHasBands = connectionKeys(node).size > 0;
  const walkableAliases = (node.aliases ?? []).filter(shouldExpandAlias);
  if (walkableAliases.length > fanoutCap) {
    // Prolific-artist cap: register names in the closure so lineup matches still
    // get detected, but don't walk into each alias of one underlying artist.
    registerWalkableAliases(visited, node);
  } else {
    for (const alias of walkableAliases) {
      const key = normaliseName(alias?.name);
      if (!key || visited.has(key)) continue;
      pending.push({
        name: alias.name,
        viaChain,
        kind: 'alias',
        viaHadMemberStep,
        parentHasBands,
        aliasDepth: aliasDepth + 1,
      });
    }
  }
  // Follow members only when the node is itself a group AND we did not arrive via
  // an alias hop — i.e. don't traverse member_of after traversing aka. Otherwise
  // co-collaborators become apparent aliases of the root identity.
  if (parentKind !== 'alias' && (node.members ?? []).length > 0) {
    for (const member of node.members) {
      const key = normaliseName(member?.name);
      if (!key || visited.has(key)) continue;
      pending.push({
        name: member.name,
        viaChain,
        kind: 'member',
        viaHadMemberStep: true,
        parentHasBands,
        aliasDepth: 0,
      });
    }
  }
  // Don't walk groups/relatedProjects in general (would fan out across every
  // session credit a prolific person has), but if one is itself a lineup root we
  // want it in the closure — enqueueing lets the root-skip rule register it in
  // `visited` without spending budget on a redundant lookup.
  for (const bucket of [node.groups, node.relatedProjects]) {
    for (const entry of bucket ?? []) {
      const key = normaliseName(entry?.name);
      if (!key || visited.has(key) || !rootKeys.has(key)) continue;
      pending.push({
        name: entry.name,
        viaChain,
        kind: 'alias',
        viaHadMemberStep,
        parentHasBands,
        aliasDepth: aliasDepth + 1,
      });
    }
  }
}
