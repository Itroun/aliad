import { fetchWithRetry } from './fetchWithRetry.js';

export async function fetchJson(
  url,
  { signal, fetchFn, sleep, recordMeta } = {},
  { providerName, retryOptions } = {},
) {
  const result = await fetchWithRetry(
    url,
    { headers: { Accept: 'application/json' } },
    { fetchFn, signal, sleep, ...retryOptions },
  );
  if (!result.ok) {
    throw new Error(`${providerName} ${result.status ?? result.reason} for ${url}`);
  }
  // Surface the proxy's shared-cache outcome (Phase 1b) for the dev-probe. Absent
  // on faked test responses and on direct (un-proxied) fetches — harmless then.
  const serverCache = result.response.headers?.get?.('X-Cache');
  if (serverCache) recordMeta?.({ serverCache });
  return result.response.json();
}
