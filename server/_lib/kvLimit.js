// KV-counter limits — now used ONLY for the OpenRouter daily counters (the
// per-IP daily sub-cap via checkRateLimit, and the global call ceiling below).
// Every per-minute per-IP abuse cap moved to the native ratelimits bindings
// (ipLimit.js): a KV counter costs 1 read + 1 write per request, and KV's free
// tier (1k writes/day) both capped total traffic and let cheap endpoints
// exhaust the write budget the daily ceiling depends on. The daily counters
// stay here because they need what the native binding can't do: a 24h window
// and one globally-consistent count. Denied checks don't write, and the global
// ceiling bounds the writers, so the residual KV write volume is self-limiting.
export async function checkRateLimit(env, { scope, ip, limit, windowSec, now = Date.now }) {
  if (!env?.KV) return { allowed: true, degraded: true };
  const windowStart = Math.floor(now() / 1000 / windowSec) * windowSec;
  const key = `rl:${scope}:${ip}:${windowStart}`;
  try {
    const raw = await env.KV.get(key);
    const count = raw ? Number(raw) : 0;
    if (count >= limit) return { allowed: false, count };
    await env.KV.put(key, String(count + 1), { expirationTtl: windowSec * 2 });
    return { allowed: true, count: count + 1 };
  } catch {
    return { allowed: true, degraded: true };
  }
}

export async function checkDailyCeiling(env, { key, limit, now = Date.now }) {
  if (!env?.KV) return { allowed: true, degraded: true };
  const day = new Date(now()).toISOString().slice(0, 10);
  const storageKey = `${key}:${day}`;
  try {
    const raw = await env.KV.get(storageKey);
    const count = raw ? Number(raw) : 0;
    if (count >= limit) return { allowed: false, count, storageKey };
    return { allowed: true, count, storageKey };
  } catch {
    return { allowed: true, degraded: true };
  }
}

// Bump the daily counter by `count` (default 1). The openrouter endpoint passes
// the number of upstream model calls a request actually made, so an escalated
// extraction (cheap + fallback) draws down two units rather than one.
export async function incrementDailyCeiling(env, storageKey, count = 1) {
  if (!env?.KV || !storageKey || count <= 0) return;
  try {
    const raw = await env.KV.get(storageKey);
    const next = (raw ? Number(raw) : 0) + count;
    await env.KV.put(storageKey, String(next), { expirationTtl: 172_800 });
  } catch {
    // swallow — budget tracking is best-effort
  }
}
