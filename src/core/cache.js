import { SCHEMA_VERSION } from './schemaVersion.js';

const DAY = 24 * 60 * 60 * 1000;

const TTL_NON_EMPTY = 30 * DAY;
const TTL_EMPTY = 7 * DAY;

function isResultEmpty(result) {
  return (
    (result?.aliases?.length ?? 0) === 0 &&
    (result?.groups?.length ?? 0) === 0 &&
    (result?.members?.length ?? 0) === 0 &&
    (result?.relatedProjects?.length ?? 0) === 0
  );
}

function ttlFor(isEmpty) {
  return isEmpty ? TTL_EMPTY : TTL_NON_EMPTY;
}

function isFresh(entry, now) {
  return now - entry.fetchedAt < ttlFor(entry.isEmpty);
}

function keyFor(provider, nameKey) {
  return `${provider}::${nameKey}`;
}

export function createNoopCache() {
  return {
    async lookup(_provider, _nameKey, { fetch } = {}) {
      const result = await fetch();
      return { result, cached: false, fromPersistent: false, stale: false };
    },
    stats() {
      return { hits: 0, misses: 0, stale: 0, writes: 0 };
    },
    async clear() {},
  };
}

export function createCache({
  db: dbName = 'aka-cache',
  store: storeName = 'lookups',
  now = Date.now,
} = {}) {
  if (typeof indexedDB === 'undefined') return createNoopCache();

  let dbPromise = null;
  const counters = { hits: 0, misses: 0, stale: 0, writes: 0 };

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function getEntry(key) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function writeEntry(provider, nameKey, result) {
    const d = await openDb();
    const value = {
      schemaVersion: SCHEMA_VERSION,
      provider,
      nameKey,
      fetchedAt: now(),
      isEmpty: isResultEmpty(result),
      result,
    };
    await new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, keyFor(provider, nameKey));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    counters.writes++;
  }

  async function lookup(provider, nameKey, { fetch } = {}) {
    let entry = null;
    try {
      entry = await getEntry(keyFor(provider, nameKey));
    } catch {
      entry = null;
    }
    if (entry && entry.schemaVersion !== SCHEMA_VERSION) entry = null;

    if (entry && isFresh(entry, now())) {
      counters.hits++;
      return { result: entry.result, cached: true, fromPersistent: true, stale: false };
    }

    if (entry) {
      counters.stale++;
      try {
        const result = await fetch();
        await writeEntry(provider, nameKey, result);
        return { result, cached: false, fromPersistent: false, stale: false };
      } catch {
        // Stale-on-error (including AbortError): return the prior value, don't write.
        return { result: entry.result, cached: true, fromPersistent: true, stale: true };
      }
    }

    counters.misses++;
    const result = await fetch();
    await writeEntry(provider, nameKey, result);
    return { result, cached: false, fromPersistent: false, stale: false };
  }

  function stats() {
    return { ...counters };
  }

  async function clear() {
    const d = await openDb();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { lookup, stats, clear };
}
