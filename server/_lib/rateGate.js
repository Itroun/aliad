// Adapter between the lookup path and the RateLimiter Durable Object. Turns a
// denied token-take into backpressure: wait the reported time, then retry, until
// granted, aborted, or a hard cap is hit. Keeps all Cloudflare-specific DO
// plumbing behind one swappable function (see server/rateLimiter.js for the why).

// The two gate tiers. Root lookups take tokens freely; expansion lookups yield
// to root demand via the bucket's reserve floor (see server/rateLimiter.js).
// Exported so the tier names are defined once — a typo'd tier string would
// otherwise silently land in the privileged root tier.
export const PRIORITY_ROOT = 'root';
export const PRIORITY_EXPAND = 'expand';

// Per-tier wait budgets, sized to the measured workload: a fully-cold large
// lineup is Discogs-budget-bound for ~12+ minutes, and root demand alone can
// run 5+ minutes (staggered stream starts keep it alive for most of a big cold
// run). Both budgets therefore exceed the phase they wait out, so hitting one
// means the DO is wedged or the workload is far past anything measured — not
// merely a busy cold run. An expand waiter that outlives its budget PROMOTES
// to the root tier (still token-gated) rather than bypassing the gate; only a
// waiter that then also exhausts the root budget proceeds ungated, as the true
// last resort (measured: ungated barging under load held Discogs in a
// sustained 429 state, so this path must stay rare).
const MAX_TOTAL_WAIT_MS = { root: 600_000, expand: 900_000 };
// Per-tier ceilings for one denied-take sleep. Waiters escalate their sleep per
// consecutive denial toward this, so a long wait costs a few DO round-trips,
// not hundreds — root's lower cap keeps its grant latency tight while still
// avoiding a ~1/s poll storm from every parked root waiter on a cold run.
const MAX_POLL_MS = { root: 5_000, expand: 15_000 };

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

// Mirrors fetchWithRetry's sleep: resolves after ms, rejects with AbortError as
// soon as the signal fires, so a disconnected client's gate wait ends now — not
// after the full budget.
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
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Wait for a Discogs slot. Degrades OPEN (returns immediately) when the binding
// is absent — tests, local runs without the DO, or a DO error — so a missing
// limiter never takes the app down, mirroring kvLimit's fail-open posture.
// Returns the total ms spent waiting, so callers can report gate backpressure
// (the dev-probe's cold-run stats). Throws AbortError when `signal` fires, so
// an abandoned request never consumes a token (the walk owns stopping itself).
//
// `priority`: PRIORITY_ROOT (default) takes tokens freely; PRIORITY_EXPAND
// yields to root demand via the bucket's reserve floor.
export async function awaitDiscogsSlot(
  env,
  { sleep = defaultSleep, signal, priority = PRIORITY_ROOT } = {},
) {
  const ns = env?.RATE_LIMITER;
  if (!ns) return 0;
  let stub;
  try {
    stub = ns.get(ns.idFromName('discogs'));
  } catch {
    return 0;
  }

  let tier = priority === PRIORITY_EXPAND ? PRIORITY_EXPAND : PRIORITY_ROOT;
  let remaining = MAX_TOTAL_WAIT_MS[tier];
  let waitedTotal = 0;
  let denials = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let granted = true;
    let waitMs = 0;
    try {
      const res = await stub.fetch(`https://rate-limiter/?key=discogs&priority=${tier}`);
      ({ granted, waitMs } = await res.json());
    } catch {
      return waitedTotal; // DO unreachable — fail open.
    }
    if (granted) return waitedTotal;

    denials++;
    // Clamp the reported wait to a sane floor — and to a number at all: a
    // malformed denial (no waitMs) must not NaN-poison the loop into a
    // zero-delay busy-poll that also never exhausts its budget.
    const base = Math.max(Number.isFinite(waitMs) ? waitMs : 25, 25);
    // Escalate the sleep per consecutive denial: while the bucket starves this
    // waiter the reported waitMs stays small (one token's refill), so without
    // backoff every parked waiter would poll the DO a few times a second for
    // minutes.
    const ms = Math.min(base * denials, MAX_POLL_MS[tier], remaining);
    if (ms <= 0) {
      if (tier === PRIORITY_EXPAND) {
        // Waited out the expand budget — join the root tier (still token-
        // gated) instead of bypassing the gate; see MAX_TOTAL_WAIT_MS note.
        // `denials` carries over so the settled backoff cadence survives the
        // promotion instead of snapping back to fast polling at peak load.
        tier = PRIORITY_ROOT;
        remaining = MAX_TOTAL_WAIT_MS[tier];
        continue;
      }
      return waitedTotal; // root budget exhausted — last-resort bypass.
    }
    await sleep(ms, signal);
    remaining -= ms;
    waitedTotal += ms;
  }
}
