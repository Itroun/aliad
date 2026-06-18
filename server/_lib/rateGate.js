// Adapter between the lookup path and the RateLimiter Durable Object. Turns a
// denied token-take into backpressure: wait the reported time, then retry, until
// granted or a hard cap is hit. Keeps all Cloudflare-specific DO plumbing behind
// one swappable function (see server/rateLimiter.js for the why).

// Don't block a single upstream call forever; past this, give up waiting and let
// the call proceed (fetchWithRetry's Retry-After handling is the backstop).
const MAX_TOTAL_WAIT_MS = 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for a Discogs slot. Degrades OPEN (returns immediately) when the binding
// is absent — tests, local runs without the DO, or a DO error — so a missing
// limiter never takes the app down, mirroring kvLimit's fail-open posture.
export async function awaitDiscogsSlot(env, { sleep = defaultSleep, signal } = {}) {
  const ns = env?.RATE_LIMITER;
  if (!ns) return;
  let stub;
  try {
    stub = ns.get(ns.idFromName('discogs'));
  } catch {
    return;
  }

  let waited = 0;
  for (;;) {
    let granted = true;
    let waitMs = 0;
    try {
      const res = await stub.fetch('https://rate-limiter/?key=discogs');
      ({ granted, waitMs } = await res.json());
    } catch {
      return; // DO unreachable — fail open.
    }
    if (granted) return;

    const remaining = MAX_TOTAL_WAIT_MS - waited;
    const ms = Math.min(Math.max(waitMs, 25), remaining);
    if (ms <= 0) return; // budget for waiting exhausted; proceed anyway.
    await sleep(ms, signal);
    waited += ms;
  }
}
