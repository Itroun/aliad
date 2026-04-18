const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export async function fetchWithRetry(
  fetchFn,
  url,
  init = {},
  { maxAttempts = 3, sleep = defaultSleep, baseDelayMs = 500 } = {},
) {
  let attempt = 0;
  while (true) {
    attempt++;
    let res;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      if (isAbort(err) || attempt >= maxAttempts) throw err;
      await sleep(backoff(attempt, baseDelayMs));
      continue;
    }
    if (res.ok) return res;
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= maxAttempts) return res;
    const retryAfter = parseRetryAfter(res.headers);
    await sleep(retryAfter ?? backoff(attempt, baseDelayMs));
  }
}

function backoff(attempt, base) {
  const exp = base * 2 ** (attempt - 1);
  return exp + Math.random() * base;
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('Retry-After');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  return null;
}

function isAbort(err) {
  return err?.name === 'AbortError';
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
