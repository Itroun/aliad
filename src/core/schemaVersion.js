// Cache schema version for the shared L2 store (the D1 quad store behind
// server/api/lookup.js). Entries key on (provider, normalisedName) and store the
// same mapped-result shape, so bumping this single constant invalidates every
// entry coherently (old entries TTL out; no migration). The former L1 browser
// IndexedDB cache was removed once the identity walk moved server-side.
export const SCHEMA_VERSION = 1;
