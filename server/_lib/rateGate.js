// Adapter between the lookup path and the RateLimiter Durable Object. Turns a
// denied token-take into backpressure: wait the reported time, then retry, until
// granted or a hard cap is hit. Keeps all Cloudflare-specific DO plumbing behind
// one swappable function (see server/rateLimiter.js for the why).

// Per-tier wait budgets. An expansion lookup legitimately parks for a long
// root phase (staggered stream starts keep root demand alive for most of a big
// cold run), so its budget is generous — but on expiry it PROMOTES to the root
// tier (still token-gated) rather than bypassing the gate: an ungated call is
// an overshoot of the provider window at exactly the moment the gate matters
// most (measured: post-expiry barging held Discogs in a sustained 429 state).
// Only a root-tier waiter that times out proceeds ungated, as the true last
// resort — root drains at the full refill rate, so that path needs the DO to
// be effectively wedged.
const MAX_TOTAL_WAIT_MS = { root: 60_000, expand: 480_000 };
// Ceiling for one denied-take sleep. Parked expansion waiters back off toward
// this so a long wait costs a few DO round-trips, not hundreds.
const MAX_POLL_MS = 15_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for a Discogs slot. Degrades OPEN (returns immediately) when the binding
// is absent — tests, local runs without the DO, or a DO error — so a missing
// limiter never takes the app down, mirroring kvLimit's fail-open posture.
// Returns the total ms spent waiting, so callers can report gate backpressure
// (the dev-probe's cold-run stats).
//
// `priority`: 'root' (default) takes tokens freely; 'expand' yields to root
// demand via the bucket's reserve floor (see server/rateLimiter.js).
export async function awaitDiscogsSlot(
  env,
  { sleep = defaultSleep, signal, priority = 'root' } = {},
) {
  const ns = env?.RATE_LIMITER;
  if (!ns) return 0;
  let stub;
  try {
    stub = ns.get(ns.idFromName('discogs'));
  } catch {
    return 0;
  }

  let tier = priority === 'expand' ? 'expand' : 'root';
  let budget = MAX_TOTAL_WAIT_MS[tier];
  let waitedInTier = 0;
  let waitedTotal = 0;
  let denials = 0;
  for (;;) {
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
    const base = Math.max(waitMs, 25);
    // Expansion waiters escalate their sleep per consecutive denial: while the
    // root phase starves them the reported waitMs stays small (one token's
    // refill), so without backoff every parked waiter would poll the DO a few
    // times a second for minutes.
    const poll = tier === 'expand' ? Math.min(base * denials, MAX_POLL_MS) : base;
    const ms = Math.min(poll, budget - waitedInTier);
    if (ms <= 0) {
      if (tier === 'expand') {
        // Waited out the expand budget — join the root tier (still token-
        // gated) instead of bypassing the gate; see MAX_TOTAL_WAIT_MS note.
        tier = 'root';
        budget = MAX_TOTAL_WAIT_MS.root;
        waitedInTier = 0;
        denials = 0;
        continue;
      }
      return waitedTotal; // root budget exhausted — last-resort bypass.
    }
    await sleep(ms, signal);
    waitedInTier += ms;
    waitedTotal += ms;
  }
}
