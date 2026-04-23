import { fetchWithRetry } from './fetchWithRetry.js';

export async function fetchJson(
  url,
  { signal, fetchFn, sleep } = {},
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
  return result.response.json();
}
