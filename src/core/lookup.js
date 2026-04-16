import { mergeResults, normaliseName } from './merge.js';
import { createQueue } from './rateLimit.js';

export function lookupAll(names, providers, callbacks = {}) {
  const { onProviderResult, onArtistDone, signal } = callbacks;
  const unique = dedupeNames(names);

  const queued = providers.map((provider) => ({
    provider,
    queue: provider.minIntervalMs
      ? createQueue({ minIntervalMs: provider.minIntervalMs })
      : { run: (fn) => fn() },
  }));

  return Promise.all(
    unique.map(async (name) => {
      const perProvider = await Promise.all(
        queued.map(async ({ provider, queue }) => {
          try {
            const result = await queue.run(() => provider.lookup(name, { signal }));
            onProviderResult?.(name, provider.name, { ok: true, result });
            return result;
          } catch (error) {
            onProviderResult?.(name, provider.name, { ok: false, error });
            return null;
          }
        }),
      );
      let merged = mergeResults(...perProvider.filter(Boolean));
      onArtistDone?.(name, merged);

      merged = await expandAliases(name, merged, queued, callbacks);
      return { name, merged };
    }),
  );
}

async function expandAliases(artistName, initialMerged, queued, callbacks) {
  const { onArtistDone, signal } = callbacks;
  const visited = new Set();
  visited.add(normaliseName(artistName));

  let accumulated = initialMerged;
  const pending = [...initialMerged.aliases];

  while (pending.length > 0) {
    const alias = pending.shift();
    const key = normaliseName(alias.name);
    if (visited.has(key)) continue;
    visited.add(key);

    const perProvider = await Promise.all(
      queued.map(async ({ provider, queue }) => {
        try {
          return await queue.run(() => provider.lookup(alias.name, { signal }));
        } catch {
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
      if (!visited.has(normaliseName(newAlias.name))) {
        pending.push(newAlias);
      }
    }
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
