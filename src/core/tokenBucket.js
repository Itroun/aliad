// Pure token-bucket math. State is plain data with no platform dependency, so the
// same logic runs inside a Durable Object, in memory, or under unit tests with an
// injected clock. The Durable Object (server/rateLimiter.js) is just a
// strongly-consistent home for this state; the adapter (server/_lib/rateGate.js)
// turns a denied take into backpressure (wait, then retry).

// Start full so a cold bucket allows an immediate burst up to `capacity`.
export function createBucketState(now, { capacity }) {
  return { tokens: capacity, updatedAt: now };
}

// Refill lazily: add `refillPerSec` tokens for each second elapsed since the last
// update, capped at `capacity`. No timers — time is whatever `now` says.
export function refill(state, now, { capacity, refillPerSec }) {
  const elapsedSec = Math.max(0, (now - state.updatedAt) / 1000);
  const tokens = Math.min(capacity, state.tokens + elapsedSec * refillPerSec);
  return { tokens, updatedAt: now };
}

// Attempt to take one token. Returns the next state plus whether it was granted
// and, if not, how long to wait before a token will be available.
//
// `reserve` (default 0) is the priority mechanism: a taker only succeeds while
// the bucket holds MORE than `reserve` tokens, so a positive reserve makes this
// taker yield to reserve-0 takers whenever the bucket runs hot — the low tier
// only drinks once the bucket has filled past the floor the high tier never
// lets it reach while it still has demand. No queue, no coordination: strict
// priority falls out of the admission threshold alone.
export function take(state, now, opts) {
  const refilled = refill(state, now, opts);
  const threshold = 1 + (opts.reserve ?? 0);
  if (refilled.tokens >= threshold) {
    return { state: { ...refilled, tokens: refilled.tokens - 1 }, granted: true, waitMs: 0 };
  }
  const deficit = threshold - refilled.tokens;
  const waitMs = Math.ceil((deficit / opts.refillPerSec) * 1000);
  return { state: refilled, granted: false, waitMs };
}
