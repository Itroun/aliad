// Shared cache schema version. Governs BOTH tiers of the unified cache:
//   L1 — the browser IndexedDB cache (src/core/cache.js)
//   L2 — the server KV cache (functions/api/lookup.js)
// Both key on (provider, normalisedName) and store the same mapped-result shape,
// so bumping this single constant invalidates every entry in both tiers
// coherently (old entries TTL out; no migration). See PHASE2B_MAPPED_CACHE_PLAN.md.
export const SCHEMA_VERSION = 1;
