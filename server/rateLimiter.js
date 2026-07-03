// Strongly-consistent global rate limiter, backed by a single Durable Object
// instance per key. Because a DO runs single-threaded and all callers route to
// the same named instance, concurrent /api/closure requests can't race past the
// budget the way a KV counter or the per-location native binding would.
//
// Declared as a SQLite-backed class in wrangler.toml ([[migrations]]
// new_sqlite_classes) so it stays on the free plan. State is held in memory: if
// the instance is evicted the bucket simply resets to full, which only permits a
// small one-off burst — acceptable for rate limiting.
//
// The bucket MATH lives in src/core/tokenBucket.js (pure, unit-tested); this
// class is just its consistent home. Replacing Cloudflare later means swapping
// this file + server/_lib/rateGate.js for e.g. a Redis-backed limiter.

import { createBucketState, take } from '../src/core/tokenBucket.js';
import { PRIORITY_EXPAND } from './_lib/rateGate.js';

// Discogs allows 60 req/min authenticated as a ROLLING window, so the binding
// invariant is `capacity + refill/min <= 60`: a fully-cold run drains the burst
// AND a full minute's refill into Discogs's first window. 5 + 54 = 59 keeps one
// call of headroom. (A 10 + 55 sizing was measured to trip sustained 429s —
// cold-run wall time scales with the refill rate, but overshooting the window
// costs far more than the margin saves.) fetchWithRetry's Retry-After backoff
// remains the backstop for any residual 429s.
//
// `expandReserve` is the two-tier priority floor: `priority=expand` takes only
// succeed while the bucket holds more than this many tokens, so root lookups
// (priority=root, reserve 0) drain it ahead of expansion whenever both contend.
// Measured cold-run data (see TODO/dev-probe): a large lineup's walk is fully
// Discogs-budget-bound, so without this a late act's ROOT waits behind an early
// act's deep expansion; with it, every act's headline data lands first and the
// remaining minutes only deepen the graph.
const BUCKETS = {
  discogs: { capacity: 5, refillPerSec: 54 / 60, expandReserve: 3 },
};

export class RateLimiter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.states = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') ?? 'discogs';
    const opts = BUCKETS[key] ?? BUCKETS.discogs;
    const reserve =
      url.searchParams.get('priority') === PRIORITY_EXPAND ? (opts.expandReserve ?? 0) : 0;
    const now = Date.now();
    const state = this.states.get(key) ?? createBucketState(now, opts);
    const result = take(state, now, { ...opts, reserve });
    this.states.set(key, result.state);
    return Response.json({ granted: result.granted, waitMs: result.waitMs });
  }
}
