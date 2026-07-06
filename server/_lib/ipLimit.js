// Per-IP abuse caps over the native Workers rate-limiting bindings
// ([[ratelimits]] in wrangler.toml). Replaces the KV-counter rate limits for
// everything with a ≤60s window: the native binding costs no KV operations,
// which matters because KV's free tier allows only 1k writes/day account-wide
// — a KV-backed counter (1 read + 1 write per request) capped the whole app at
// ~1k requests/day AND let the cheap endpoints exhaust the write budget the
// OpenRouter daily ceiling depends on (kvLimit.js degrades open, so blowing
// the budget silently disarmed the spend guard).
//
// Semantics trade, accepted: the native binding is per-colo and eventually
// consistent, so a client spread across N colos gets N× the allowance. Fine
// for per-IP abuse caps (one IP lands on one colo); NOT usable for global
// budgets — the Discogs 60/min bucket stays on the strongly-consistent
// RATE_LIMITER DO, and the OpenRouter daily counters stay on KV (a 24h window
// exceeds the binding's 10s/60s maximum anyway).
//
// Degrades OPEN like every guard here: no binding (plain Vite, unit tests,
// a wrangler.toml regression) or a thrown limit() call allows the request.
// The limit/window numbers live in wrangler.toml next to each binding.
export async function checkIpLimit(env, { binding, ip }) {
  const limiter = env?.[binding];
  if (!limiter) return { allowed: true, degraded: true };
  try {
    const { success } = await limiter.limit({ key: ip });
    return { allowed: success };
  } catch {
    return { allowed: true, degraded: true };
  }
}
