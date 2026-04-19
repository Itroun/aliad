import { mergeResults, normaliseName } from './merge.js';
import { createQueue } from './rateLimit.js';

const EXPAND_SKIP_TYPES = new Set(['Search hint', 'Legal name']);
const MAX_EXPANSION_LOOKUPS = 25;

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

      merged = await expandAliases(name, merged, queued, callbacks);

      const queried = Object.keys(initialOutcomes).filter((k) => initialOutcomes[k].ok);
      const errored = Object.keys(initialOutcomes).filter((k) => !initialOutcomes[k].ok);
      onArtistComplete?.(name, merged, { queried, errored });
      return { name, merged };
    }),
  );
}

async function expandAliases(artistName, initialMerged, queued, callbacks) {
  const { onArtistDone, onProviderResult, onBudgetExhausted, signal } = callbacks;
  const visited = new Set();
  visited.add(normaliseName(artistName));

  let accumulated = initialMerged;
  const pending = initialMerged.aliases.filter(shouldExpandAlias);
  let budget = MAX_EXPANSION_LOOKUPS;

  while (pending.length > 0 && budget > 0) {
    const alias = pending.shift();
    const key = normaliseName(alias.name);
    if (visited.has(key)) continue;
    visited.add(key);
    budget--;

    const perProvider = await Promise.all(
      queued.map(async ({ provider, queue }) => {
        try {
          const result = await queue.run(() => provider.lookup(alias.name, { signal }));
          onProviderResult?.(artistName, provider.name, { ok: true, result, via: alias.name });
          return result;
        } catch (error) {
          onProviderResult?.(artistName, provider.name, { ok: false, error, via: alias.name });
          return null;
        }
      }),
    );

    const aliasMerged = mergeResults(...perProvider.filter(Boolean));

    const attributed = {
      aliases: [],
      groups: aliasMerged.groups.map((e) => ({ ...e, via: alias.name })),
      members: aliasMerged.members.map((e) => ({ ...e, via: alias.name })),
      relatedProjects: aliasMerged.relatedProjects.map((e) => ({ ...e, via: alias.name })),
    };

    accumulated = mergeResults(accumulated, attributed);
    onArtistDone?.(artistName, accumulated);

    for (const newAlias of aliasMerged.aliases) {
      if (!visited.has(normaliseName(newAlias.name)) && shouldExpandAlias(newAlias)) {
        pending.push(newAlias);
      }
    }
  }

  if (budget === 0 && pending.length > 0) {
    onBudgetExhausted?.(artistName, { skipped: pending.length });
  }

  return accumulated;
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
