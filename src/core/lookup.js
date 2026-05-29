import { createCache } from './cache.js';
import { dedupeNames, mergeResults, normaliseName } from './merge.js';
import { createQueue } from './rateLimit.js';

let _defaultCache = null;
function defaultCache() {
  if (!_defaultCache) _defaultCache = createCache();
  return _defaultCache;
}

const EXPAND_SKIP_TYPES = new Set(['Search hint', 'Legal name']);
const MAX_EXPANSION_LOOKUPS = 25;
const ALIAS_FANOUT_CAP = 15;

function shouldExpandAlias(alias) {
  return !alias?.type || !EXPAND_SKIP_TYPES.has(alias.type);
}

// Festival lineups commonly use "X vs Y", "X b2b Y", "X & Y" for collab acts.
// Providers don't know these combined names, so we look up the constituents
// individually and merge their data + closures into the combo's entry.
const COLLAB_SEPARATORS = [/\s+vs\.?\s+/i, /\s+b2b\s+/i, /\s+&\s+/];

export function splitCollab(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  for (const sep of COLLAB_SEPARATORS) {
    if (!sep.test(s)) continue;
    const parts = s
      .split(sep)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return null;
}

export function lookupAll(names, providers, callbacks = {}) {
  const { onArtistDone, onArtistComplete, signal, cache: injectedCache } = callbacks;
  const persistent = injectedCache ?? defaultCache();
  const unique = dedupeNames(names);
  const rootKeys = new Set(unique.map(normaliseName).filter(Boolean));

  const queued = providers.map((provider) => {
    const queue = provider.minIntervalMs
      ? createQueue({ minIntervalMs: provider.minIntervalMs })
      : { run: (fn) => fn() };
    const inRun = new Map();
    const cachedLookup = async (name, opts) => {
      const key = normaliseName(name);
      if (!key) {
        const result = await queue.run(() => provider.lookup(name, opts));
        return { result, cached: false, fromPersistent: false, stale: false };
      }
      if (inRun.has(key)) {
        const value = await inRun.get(key);
        return { ...value, cached: true };
      }
      const promise = persistent.lookup(provider.name, key, {
        fetch: () => queue.run(() => provider.lookup(name, opts)),
      });
      inRun.set(key, promise);
      return promise;
    };
    return { provider, cachedLookup };
  });

  return Promise.all(
    unique.map(async (name) => {
      const combo = await runOnePipeline(name, queued, callbacks, rootKeys, {
        reportName: name,
      });

      let merged = combo.merged;
      const closure = new Set(combo.closure);
      // `sources` attributes each relation back to the sub-name that hosts it,
      // so the graph can render "aka Filteria" rather than "aka X vs Filteria".
      const sources = [{ name, merged: combo.merged }];

      const parts = splitCollab(name);
      if (parts) {
        const partResults = await Promise.all(
          parts.map((p) => runOnePipeline(p, queued, callbacks, rootKeys, { reportName: null })),
        );
        partResults.forEach((pr, i) => {
          merged = mergeResults(merged, pr.merged);
          for (const k of pr.closure) closure.add(k);
          sources.push({ name: parts[i], merged: pr.merged });
        });
        onArtistDone?.(name, merged);
      }

      const queried = Object.keys(combo.initialOutcomes).filter((k) => combo.initialOutcomes[k].ok);
      const errored = Object.keys(combo.initialOutcomes).filter(
        (k) => !combo.initialOutcomes[k].ok,
      );
      onArtistComplete?.(name, merged, { queried, errored, closure });
      return { name, merged, closure, sources, parts: parts ?? [] };
    }),
  );
}

async function runOnePipeline(name, queued, callbacks, rootKeys, { reportName }) {
  const { onProviderResult, onArtistDone, signal } = callbacks;
  const initialOutcomes = {};
  const perProvider = await Promise.all(
    queued.map(async ({ provider, cachedLookup }) => {
      try {
        const { result, cached } = await cachedLookup(name, { signal });
        initialOutcomes[provider.name] = { ok: true };
        onProviderResult?.(name, provider.name, { ok: true, result, cached });
        return result;
      } catch (error) {
        initialOutcomes[provider.name] = { ok: false };
        onProviderResult?.(name, provider.name, { ok: false, error, cached: false });
        return null;
      }
    }),
  );
  const merged0 = mergeResults(...perProvider.filter(Boolean));
  if (reportName) onArtistDone?.(reportName, merged0);

  // Suppress onArtistDone routing for part runs — the part's display name
  // isn't a lineup row, so progress events for it have nowhere useful to land.
  const expandCallbacks = reportName ? callbacks : { ...callbacks, onArtistDone: undefined };
  const expanded = await expandIdentityGraph(name, merged0, queued, expandCallbacks, rootKeys);
  return { merged: expanded.merged, closure: expanded.closure, initialOutcomes };
}

async function expandIdentityGraph(artistName, initialMerged, queued, callbacks, rootKeys) {
  const { onArtistDone, onProviderResult, onBudgetExhausted, signal } = callbacks;
  const ownRootKey = normaliseName(artistName);
  const visited = new Set();
  visited.add(ownRootKey);

  let accumulated = initialMerged;
  const pending = [];
  enqueueFromNode(pending, visited, initialMerged, [], rootKeys, {
    parentKind: null,
    viaHadMemberStep: false,
  });
  let budget = MAX_EXPANSION_LOOKUPS;
  const rejectedAliasKeys = new Set();

  while (pending.length > 0 && budget > 0) {
    const item = pending.shift();
    const key = normaliseName(item.name);
    if (!key || visited.has(key)) continue;
    visited.add(key);

    // Another root input's walk covers this identity sub-graph; recording the
    // name in `visited` is enough for clustering to union the two roots.
    if (rootKeys?.has(key) && key !== ownRootKey) continue;

    budget--;

    const perProvider = await Promise.all(
      queued.map(async ({ provider, cachedLookup }) => {
        try {
          const { result, cached } = await cachedLookup(item.name, { signal });
          onProviderResult?.(artistName, provider.name, {
            ok: true,
            result,
            via: item.name,
            cached,
          });
          return result;
        } catch (error) {
          onProviderResult?.(artistName, provider.name, {
            ok: false,
            error,
            via: item.name,
            cached: false,
          });
          return null;
        }
      }),
    );

    const nodeMerged = mergeResults(...perProvider.filter(Boolean));

    // Suspected alias-of-group: a previous node listed `item.name` as an alias,
    // but the lookup reveals it has its own membership. Treat it as a group,
    // not as an identity-equivalent of the root. Skip attribution and don't
    // fan into co-members — otherwise collaborators leak in as apparent
    // aliases of the root (e.g. Discogs lists a duo's project as an alias of
    // each member, and walking that node's members swaps the two members).
    const looksLikeGroup = (nodeMerged.members ?? []).length > 0;
    if (item.kind === 'alias' && looksLikeGroup) {
      // Also strip from accumulated.aliases so downstream graph-build doesn't
      // treat this name as an aka of the root (e.g. a duo project listed as
      // an alias of one member would otherwise bridge the member to the
      // duo's other collaborator's bands as "aka <duo project>").
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
    onArtistDone?.(artistName, accumulated);

    enqueueFromNode(pending, visited, nodeMerged, viaChain, rootKeys, {
      parentKind: item.kind,
      viaHadMemberStep,
    });
  }

  if (budget === 0 && pending.length > 0) {
    onBudgetExhausted?.(artistName, { skipped: pending.length });
  }

  if (rejectedAliasKeys.size > 0) {
    accumulated = {
      ...accumulated,
      aliases: accumulated.aliases.filter((a) => !rejectedAliasKeys.has(normaliseName(a?.name))),
    };
  }

  return { merged: accumulated, closure: visited };
}

function enqueueFromNode(pending, visited, node, viaChain, rootKeys, ctx = {}) {
  const { parentKind = null, viaHadMemberStep = false } = ctx;
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
      pending.push({ name: alias.name, viaChain, kind: 'alias', viaHadMemberStep });
    }
  }
  // Follow members only when the node is itself a group AND we did not arrive
  // here via an alias hop. Walking members of an alias-reached node would turn
  // co-collaborators into apparent aliases of the root identity.
  if (parentKind !== 'alias' && (node.members ?? []).length > 0) {
    for (const member of node.members) {
      const key = normaliseName(member?.name);
      if (!key || visited.has(key)) continue;
      pending.push({ name: member.name, viaChain, kind: 'member', viaHadMemberStep: true });
    }
  }
  // Don't walk groups/relatedProjects in general (would fan out across every
  // session credit a prolific person has), but if one is itself a lineup root
  // we want it in the closure — enqueueing lets the root-skip rule register
  // it in `visited` without spending budget on a redundant lookup.
  if (rootKeys) {
    for (const bucket of [node.groups, node.relatedProjects]) {
      for (const entry of bucket ?? []) {
        const key = normaliseName(entry?.name);
        if (!key || visited.has(key) || !rootKeys.has(key)) continue;
        pending.push({ name: entry.name, viaChain, kind: 'alias', viaHadMemberStep });
      }
    }
  }
}
