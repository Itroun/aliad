import { mergeResults, normaliseName } from './merge.js';
import { createQueue } from './rateLimit.js';

const EXPAND_SKIP_TYPES = new Set(['Search hint', 'Legal name']);
const MAX_EXPANSION_LOOKUPS = 25;
const ALIAS_FANOUT_CAP = 15;

function shouldExpandAlias(alias) {
  return !alias?.type || !EXPAND_SKIP_TYPES.has(alias.type);
}

export function lookupAll(names, providers, callbacks = {}) {
  const { onProviderResult, onArtistDone, onArtistComplete, signal } = callbacks;
  const unique = dedupeNames(names);

  const queued = providers.map((provider) => ({
    provider,
    queue: provider.minIntervalMs
      ? createQueue({ minIntervalMs: provider.minIntervalMs })
      : { run: (fn) => fn() },
  }));

  return Promise.all(
    unique.map(async (name) => {
      const initialOutcomes = {};
      const perProvider = await Promise.all(
        queued.map(async ({ provider, queue }) => {
          try {
            const result = await queue.run(() => provider.lookup(name, { signal }));
            initialOutcomes[provider.name] = { ok: true };
            onProviderResult?.(name, provider.name, { ok: true, result });
            return result;
          } catch (error) {
            initialOutcomes[provider.name] = { ok: false };
            onProviderResult?.(name, provider.name, { ok: false, error });
            return null;
          }
        }),
      );
      let merged = mergeResults(...perProvider.filter(Boolean));
      onArtistDone?.(name, merged);

      const expanded = await expandIdentityGraph(name, merged, queued, callbacks);
      merged = expanded.merged;

      const queried = Object.keys(initialOutcomes).filter((k) => initialOutcomes[k].ok);
      const errored = Object.keys(initialOutcomes).filter((k) => !initialOutcomes[k].ok);
      onArtistComplete?.(name, merged, { queried, errored });
      return { name, merged, closure: expanded.closure };
    }),
  );
}

async function expandIdentityGraph(artistName, initialMerged, queued, callbacks) {
  const { onArtistDone, onProviderResult, onBudgetExhausted, signal } = callbacks;
  const visited = new Set();
  visited.add(normaliseName(artistName));

  let accumulated = initialMerged;
  const pending = [];
  enqueueFromNode(pending, visited, initialMerged, []);
  let budget = MAX_EXPANSION_LOOKUPS;

  while (pending.length > 0 && budget > 0) {
    const item = pending.shift();
    const key = normaliseName(item.name);
    if (!key || visited.has(key)) continue;
    visited.add(key);
    budget--;

    const perProvider = await Promise.all(
      queued.map(async ({ provider, queue }) => {
        try {
          const result = await queue.run(() => provider.lookup(item.name, { signal }));
          onProviderResult?.(artistName, provider.name, { ok: true, result, via: item.name });
          return result;
        } catch (error) {
          onProviderResult?.(artistName, provider.name, { ok: false, error, via: item.name });
          return null;
        }
      }),
    );

    const nodeMerged = mergeResults(...perProvider.filter(Boolean));
    const viaChain = [item.name, ...item.viaChain];
    const via = item.name;

    const attributed = {
      aliases: [],
      groups: nodeMerged.groups.map((e) => ({ ...e, via, viaChain })),
      members: nodeMerged.members.map((e) => ({ ...e, via, viaChain })),
      relatedProjects: nodeMerged.relatedProjects.map((e) => ({ ...e, via, viaChain })),
    };

    accumulated = mergeResults(accumulated, attributed);
    onArtistDone?.(artistName, accumulated);

    enqueueFromNode(pending, visited, nodeMerged, viaChain);
  }

  if (budget === 0 && pending.length > 0) {
    onBudgetExhausted?.(artistName, { skipped: pending.length });
  }

  return { merged: accumulated, closure: visited };
}

function enqueueFromNode(pending, visited, node, viaChain) {
  const walkableAliases = (node.aliases ?? []).filter(shouldExpandAlias);
  if (walkableAliases.length > ALIAS_FANOUT_CAP) {
    // Prolific-artist cap: register names in the closure so lineup matches
    // still get detected, but don't walk into each alias. Without this, a
    // node with 50+ pseudonyms (e.g. M.I.K.E. on Discogs) eats the whole
    // expansion budget on redundant lookups of the same underlying artist.
    for (const alias of walkableAliases) {
      const key = normaliseName(alias?.name);
      if (key) visited.add(key);
    }
  } else {
    for (const alias of walkableAliases) {
      const key = normaliseName(alias?.name);
      if (!key || visited.has(key)) continue;
      pending.push({ name: alias.name, viaChain });
    }
  }
  // Follow members only when the node is itself a group — i.e. has any members.
  // This captures group-to-group-via-shared-person overlaps while avoiding
  // person-to-collaborator fan-out that would drift from identity equivalence.
  if ((node.members ?? []).length > 0) {
    for (const member of node.members) {
      const key = normaliseName(member?.name);
      if (!key || visited.has(key)) continue;
      pending.push({ name: member.name, viaChain });
    }
  }
}

function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names ?? []) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
