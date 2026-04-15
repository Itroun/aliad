import { mergeResults } from './merge.js';
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
      const merged = mergeResults(...perProvider.filter(Boolean));
      onArtistDone?.(name, merged);
      return { name, merged };
    }),
  );
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
