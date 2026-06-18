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

// Discogs allows 60 req/min authenticated. We refill at 45/min (0.75/sec) for
// safety margin, with a small burst capacity; fetchWithRetry's Retry-After
// backoff remains the backstop for any residual 429s.
const BUCKETS = {
  discogs: { capacity: 10, refillPerSec: 0.75 },
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
    const now = Date.now();
    const state = this.states.get(key) ?? createBucketState(now, opts);
    const result = take(state, now, opts);
    this.states.set(key, result.state);
    return Response.json({ granted: result.granted, waitMs: result.waitMs });
  }
}
