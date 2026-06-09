// Phase 3a — query-shaped traversal over the graph substrate.
//
// This is the BFS in src/core/lookup.js (expandIdentityGraph / enqueueFromNode)
// re-expressed as a query: the crown-jewel expansion RULES survive verbatim, but
// each "look up this node" is now "read this node's edges from the graph" instead
// of a network round-trip. No I/O lives here — like quads.js, the module is pure
// and takes an injected async `neighbors(key)` accessor (the fetchFn-injection
// convention used across the codebase), so tests drive it with an in-memory graph
// and production wires it to functions/_lib/quadStore.js via quadsToResult.
//
// Phase 3a ships this DORMANT — nothing imports it in the live path yet. The
// browser BFS is untouched. The server endpoint that drives cold fetches and the
// retirement of that BFS are Phase 3b (see TODO.md). What this proves now is that
// the rules carry over to a graph query, and that reading a node's edges ACROSS
// source_keys finally unions MB + Discogs into one cross-provider view — the
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
 * @param {(info: {skipped: number}) => void} [opts.onBudgetExhausted]
 * @returns {Promise<{merged, closure: Set<string>}>}  Same shape expandIdentityGraph returns.
 */
export async function identityClosure(
  rootName,
  {
    neighbors,
    rootKeys = new Set(),
    maxLookups = DEFAULT_MAX_LOOKUPS,
    fanoutCap = DEFAULT_FANOUT_CAP,
    onBudgetExhausted,
  } = {},
) {
  const ownRootKey = normaliseName(rootName);
  const visited = new Set();
  if (ownRootKey) visited.add(ownRootKey);

  const initialMerged = (await neighbors(ownRootKey)) ?? emptyResult();
  let accumulated = initialMerged;
  const pending = [];
  enqueueFromNode(pending, visited, initialMerged, [], rootKeys, fanoutCap, {
    parentKind: null,
    viaHadMemberStep: false,
  });
  let budget = maxLookups;
  const rejectedAliasKeys = new Set();

  while (pending.length > 0 && budget > 0) {
    const item = pending.shift();
    const key = normaliseName(item.name);
    if (!key || visited.has(key)) continue;
    visited.add(key);

    // Another root's closure covers this identity sub-graph; recording the name
    // in `visited` is enough for clustering to union the two roots.
    if (rootKeys.has(key) && key !== ownRootKey) continue;

    budget--;

    const nodeMerged = (await neighbors(key)) ?? emptyResult();

    // Suspected alias-of-group: a previous node listed this name as an alias, but
    // its own edges reveal members. Treat it as a group, not an identity of the
    // root — skip attribution and don't fan into co-members, otherwise
    // collaborators leak in as apparent aliases. Mirror lookup.js exactly.
    const looksLikeGroup = (nodeMerged.members ?? []).length > 0;
    if (item.kind === 'alias' && looksLikeGroup) {
      rejectedAliasKeys.add(key);
      continue;
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

    enqueueFromNode(pending, visited, nodeMerged, viaChain, rootKeys, fanoutCap, {
      parentKind: item.kind,
      viaHadMemberStep,
    });
  }

  if (budget === 0 && pending.length > 0) {
    onBudgetExhausted?.({ skipped: pending.length });
  }

  if (rejectedAliasKeys.size > 0) {
    accumulated = {
      ...accumulated,
      aliases: accumulated.aliases.filter((a) => !rejectedAliasKeys.has(normaliseName(a?.name))),
    };
  }

  return { merged: accumulated, closure: visited };
}

function enqueueFromNode(pending, visited, node, viaChain, rootKeys, fanoutCap, ctx = {}) {
  const { parentKind = null, viaHadMemberStep = false } = ctx;
  const walkableAliases = (node.aliases ?? []).filter(shouldExpandAlias);
  if (walkableAliases.length > fanoutCap) {
    // Prolific-artist cap: register names in the closure so lineup matches still
    // get detected, but don't walk into each alias of one underlying artist.
    for (const alias of walkableAliases) {
      const key = normaliseName(alias?.name);
      if (key) visited.add(key);
    }
  } else {
    for (const alias of walkableAliases) {
      const key = normaliseName(alias?.name);
      if (!key || visited.has(key)) continue;
      pending.push({ name: alias.name, viaChain, kind: 'alias', viaHadMemberStep });
    }
  }
  // Follow members only when the node is itself a group AND we did not arrive via
  // an alias hop — i.e. don't traverse member_of after traversing aka. Otherwise
  // co-collaborators become apparent aliases of the root identity.
  if (parentKind !== 'alias' && (node.members ?? []).length > 0) {
    for (const member of node.members) {
      const key = normaliseName(member?.name);
      if (!key || visited.has(key)) continue;
      pending.push({ name: member.name, viaChain, kind: 'member', viaHadMemberStep: true });
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
      pending.push({ name: entry.name, viaChain, kind: 'alias', viaHadMemberStep });
    }
  }
}
