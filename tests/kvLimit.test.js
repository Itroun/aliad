import { describe, it, expect } from 'vitest';
import {
  checkRateLimit,
  checkDailyCeiling,
  incrementDailyCeiling,
} from '../functions/_lib/kvLimit.js';

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
  };
}

describe('checkRateLimit', () => {
  it('allows when env.KV is missing (degraded-open)', async () => {
    const result = await checkRateLimit({}, { scope: 's', ip: '1.1.1.1', limit: 5, windowSec: 60 });
    expect(result).toEqual({ allowed: true, degraded: true });
  });

  it('allows under the limit and increments the counter', async () => {
    const KV = fakeKV();
    const now = () => 1_700_000_000_000;
    const first = await checkRateLimit({ KV }, { scope: 's', ip: '1.1.1.1', limit: 3, windowSec: 60, now });
    const second = await checkRateLimit({ KV }, { scope: 's', ip: '1.1.1.1', limit: 3, windowSec: 60, now });
    expect(first).toEqual({ allowed: true, count: 1 });
    expect(second).toEqual({ allowed: true, count: 2 });
  });

  it('denies once the limit is reached', async () => {
    const KV = fakeKV();
    const now = () => 1_700_000_000_000;
    const opts = { scope: 's', ip: '1.1.1.1', limit: 2, windowSec: 60, now };
    await checkRateLimit({ KV }, opts);
    await checkRateLimit({ KV }, opts);
    const blocked = await checkRateLimit({ KV }, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(2);
  });

  it('resets when the window rolls over', async () => {
    const KV = fakeKV();
    let t = 1_700_000_000_000;
    const now = () => t;
    const opts = { scope: 's', ip: '1.1.1.1', limit: 1, windowSec: 60, now };
    const first = await checkRateLimit({ KV }, opts);
    expect(first.allowed).toBe(true);
    const blockedInSameWindow = await checkRateLimit({ KV }, opts);
    expect(blockedInSameWindow.allowed).toBe(false);
    t += 61_000;
    const afterRoll = await checkRateLimit({ KV }, opts);
    expect(afterRoll.allowed).toBe(true);
  });

  it('isolates counters per scope and per ip', async () => {
    const KV = fakeKV();
    const now = () => 1_700_000_000_000;
    await checkRateLimit({ KV }, { scope: 'a', ip: '1.1.1.1', limit: 1, windowSec: 60, now });
    const otherScope = await checkRateLimit({ KV }, { scope: 'b', ip: '1.1.1.1', limit: 1, windowSec: 60, now });
    const otherIp = await checkRateLimit({ KV }, { scope: 'a', ip: '2.2.2.2', limit: 1, windowSec: 60, now });
    expect(otherScope.allowed).toBe(true);
    expect(otherIp.allowed).toBe(true);
  });

  it('fails open if KV throws', async () => {
    const KV = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
    const result = await checkRateLimit({ KV }, { scope: 's', ip: '1.1.1.1', limit: 1, windowSec: 60 });
    expect(result).toEqual({ allowed: true, degraded: true });
  });
});

describe('checkDailyCeiling / incrementDailyCeiling', () => {
  it('allows and returns the storage key for the current UTC day', async () => {
    const KV = fakeKV();
    const now = () => Date.parse('2026-04-19T10:00:00Z');
    const result = await checkDailyCeiling({ KV }, { key: 'anthropic:usage', limit: 5, now });
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(0);
    expect(result.storageKey).toBe('anthropic:usage:2026-04-19');
  });

  it('increments the counter and respects the limit', async () => {
    const KV = fakeKV();
    const now = () => Date.parse('2026-04-19T10:00:00Z');
    for (let i = 0; i < 3; i++) {
      const c = await checkDailyCeiling({ KV }, { key: 'k', limit: 3, now });
      expect(c.allowed).toBe(true);
      await incrementDailyCeiling({ KV }, c.storageKey);
    }
    const blocked = await checkDailyCeiling({ KV }, { key: 'k', limit: 3, now });
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(3);
  });

  it('starts fresh on a new UTC day', async () => {
    const KV = fakeKV();
    let t = Date.parse('2026-04-19T23:59:00Z');
    const now = () => t;
    const day1 = await checkDailyCeiling({ KV }, { key: 'k', limit: 1, now });
    await incrementDailyCeiling({ KV }, day1.storageKey);
    const day1Blocked = await checkDailyCeiling({ KV }, { key: 'k', limit: 1, now });
    expect(day1Blocked.allowed).toBe(false);
    t = Date.parse('2026-04-20T00:01:00Z');
    const day2 = await checkDailyCeiling({ KV }, { key: 'k', limit: 1, now });
    expect(day2.allowed).toBe(true);
    expect(day2.storageKey).toBe('k:2026-04-20');
  });

  it('degrades open when KV is missing', async () => {
    const result = await checkDailyCeiling({}, { key: 'k', limit: 1 });
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });
});
