const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_BACKOFF_MS = [500, 1500, 3500];
const DEFAULT_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60_000;

export { RETRYABLE_STATUS };

export async function fetchWithRetry(
  url,
  init,
  {
    maxAttempts = 3,
    backoffMs = DEFAULT_BACKOFF_MS,
    jitter = DEFAULT_JITTER,
    sleep = defaultSleep,
    fetchFn = fetch,
    signal,
    random = Math.random,
  } = {},
) {
  const attempts = [];

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw abortError();

    const attempt = { n: i + 1 };
    attempts.push(attempt);

    let res;
    let fetchError;
    try {
      res = await fetchFn(url, { ...init, signal });
    } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      fetchError = e;
      attempt.error = String(e?.message || e);
    }

    const failed = fetchError != null;
    if (!failed) attempt.status = res.status;

    const canRetry = failed || RETRYABLE_STATUS.has(res.status);
    if (canRetry && i < maxAttempts - 1) {
      const retryAfter = failed ? null : parseRetryAfter(res.headers?.get?.('Retry-After'));
      const wait = computeWait(retryAfter, backoffMs, i, jitter, random);
      attempt.wait = wait;
      await sleep(wait, signal);
      continue;
    }

    if (failed) {
      return {
        ok: false,
        reason: `network error: ${fetchError.message || fetchError}`,
        attempts,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: `upstream returned ${res.status}`,
        status: res.status,
        attempts,
      };
    }
    return { ok: true, response: res, attempts };
  }

  return { ok: false, reason: 'retries exhausted', attempts };
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return clampRetryAfter(secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return clampRetryAfter(date - Date.now());
  return null;
}

function clampRetryAfter(ms) {
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

function computeWait(retryAfterMs, backoffMs, attemptIdx, jitter, random) {
  if (retryAfterMs != null) return Math.round(retryAfterMs);
  const base = backoffMs[Math.min(attemptIdx, backoffMs.length - 1)];
  const spread = base * jitter;
  return Math.max(0, Math.round(base + (random() * 2 - 1) * spread));
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function defaultSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
