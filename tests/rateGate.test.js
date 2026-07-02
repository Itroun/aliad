import { describe, it, expect } from 'vitest';
import { awaitDiscogsSlot } from '../server/_lib/rateGate.js';

// Fake RATE_LIMITER namespace whose DO answers each take() from a scripted list
// of { granted, waitMs } responses (last one repeats).
function fakeNs(script) {
  let i = 0;
  return {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => {
        const reply = script[Math.min(i++, script.length - 1)];
        return { json: async () => reply };
      },
    }),
  };
}

describe('awaitDiscogsSlot', () => {
  it('returns 0 immediately when the binding is absent (fail open)', async () => {
    expect(await awaitDiscogsSlot({})).toBe(0);
    expect(await awaitDiscogsSlot(undefined)).toBe(0);
  });

  it('returns 0 when granted on the first take', async () => {
    const env = { RATE_LIMITER: fakeNs([{ granted: true }]) };
    expect(await awaitDiscogsSlot(env, { sleep: () => {} })).toBe(0);
  });

  it('returns the accumulated wait after denied takes', async () => {
    const env = {
      RATE_LIMITER: fakeNs([
        { granted: false, waitMs: 40 },
        { granted: false, waitMs: 30 },
        { granted: true },
      ]),
    };
    const slept = [];
    const waited = await awaitDiscogsSlot(env, { sleep: (ms) => slept.push(ms) });
    expect(waited).toBe(70);
    expect(slept).toEqual([40, 30]);
  });

  it('clamps tiny reported waits up to the 25ms floor', async () => {
    const env = {
      RATE_LIMITER: fakeNs([{ granted: false, waitMs: 1 }, { granted: true }]),
    };
    expect(await awaitDiscogsSlot(env, { sleep: () => {} })).toBe(25);
  });

  it('passes the priority tier to the DO and defaults to root', async () => {
    const urls = [];
    const env = {
      RATE_LIMITER: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (url) => {
            urls.push(url);
            return { json: async () => ({ granted: true }) };
          },
        }),
      },
    };
    await awaitDiscogsSlot(env, { sleep: () => {} });
    await awaitDiscogsSlot(env, { sleep: () => {}, priority: 'expand' });
    expect(urls[0]).toContain('priority=root');
    expect(urls[1]).toContain('priority=expand');
  });

  it('escalates expand-tier sleeps per consecutive denial, capped at 15s', async () => {
    const env = {
      RATE_LIMITER: fakeNs([
        { granted: false, waitMs: 4000 },
        { granted: false, waitMs: 4000 },
        { granted: false, waitMs: 4000 },
        { granted: false, waitMs: 4000 },
        { granted: true },
      ]),
    };
    const slept = [];
    await awaitDiscogsSlot(env, { sleep: (ms) => slept.push(ms), priority: 'expand' });
    // 4000×1, 4000×2, 4000×3 capped at 12000, then 4000×4 capped at 15000.
    expect(slept).toEqual([4000, 8000, 12000, 15000]);
  });

  it('gives the expand tier a wait budget past the root 60s cap', async () => {
    // Deny forever with 30s hints: root gives up after 60s waited; expand waits
    // its 480s budget, then spends a promoted root-tier 60s before bypassing.
    const deny = { granted: false, waitMs: 30_000 };
    let rootWaited = 0;
    await awaitDiscogsSlot(
      { RATE_LIMITER: fakeNs([deny]) },
      { sleep: (ms) => (rootWaited += ms), priority: 'root' },
    );
    expect(rootWaited).toBe(60_000);

    let expandWaited = 0;
    await awaitDiscogsSlot(
      { RATE_LIMITER: fakeNs([deny]) },
      { sleep: (ms) => (expandWaited += ms), priority: 'expand' },
    );
    expect(expandWaited).toBe(480_000 + 60_000);
  });

  it('promotes an exhausted expand waiter to the root tier instead of bypassing', async () => {
    // Deny every expand take; grant the first root take. The waiter must burn
    // its whole expand budget, then come back as root and be granted — never
    // proceeding ungated.
    const urls = [];
    const env = {
      RATE_LIMITER: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (url) => {
            urls.push(url);
            const granted = url.includes('priority=root');
            return {
              json: async () => (granted ? { granted: true } : { granted: false, waitMs: 15_000 }),
            };
          },
        }),
      },
    };
    let waited = 0;
    const returned = await awaitDiscogsSlot(env, {
      sleep: (ms) => (waited += ms),
      priority: 'expand',
    });
    expect(waited).toBe(480_000);
    expect(returned).toBe(480_000);
    expect(urls[urls.length - 1]).toContain('priority=root');
    expect(urls.slice(0, -1).every((u) => u.includes('priority=expand'))).toBe(true);
  });

  it('fails open with the wait so far when the DO errors mid-sequence', async () => {
    let i = 0;
    const env = {
      RATE_LIMITER: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async () => {
            if (i++ === 0) return { json: async () => ({ granted: false, waitMs: 50 }) };
            throw new Error('DO unreachable');
          },
        }),
      },
    };
    expect(await awaitDiscogsSlot(env, { sleep: () => {} })).toBe(50);
  });
});
