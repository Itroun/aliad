import { describe, it, expect } from 'vitest';
import { awaitDiscogsSlot } from '../server/_lib/rateGate.js';
import { fakeRateLimiterNs } from './helpers/fakeRateLimiter.js';

describe('awaitDiscogsSlot', () => {
  it('returns 0 immediately when the binding is absent (fail open)', async () => {
    expect(await awaitDiscogsSlot({})).toBe(0);
    expect(await awaitDiscogsSlot(undefined)).toBe(0);
  });

  it('returns 0 when granted on the first take', async () => {
    const env = { RATE_LIMITER: fakeRateLimiterNs([{ granted: true }]) };
    expect(await awaitDiscogsSlot(env, { sleep: () => {} })).toBe(0);
  });

  it('returns the accumulated wait after denied takes (escalating per denial)', async () => {
    const env = {
      RATE_LIMITER: fakeRateLimiterNs([
        { granted: false, waitMs: 40 },
        { granted: false, waitMs: 30 },
        { granted: true },
      ]),
    };
    const slept = [];
    const waited = await awaitDiscogsSlot(env, { sleep: (ms) => slept.push(ms) });
    // Second consecutive denial doubles the reported wait (30 × 2).
    expect(waited).toBe(100);
    expect(slept).toEqual([40, 60]);
  });

  it('clamps tiny reported waits up to the 25ms floor', async () => {
    const env = {
      RATE_LIMITER: fakeRateLimiterNs([{ granted: false, waitMs: 1 }, { granted: true }]),
    };
    expect(await awaitDiscogsSlot(env, { sleep: () => {} })).toBe(25);
  });

  it('treats a denial with no numeric waitMs as the 25ms floor (no NaN busy-poll)', async () => {
    const env = { RATE_LIMITER: fakeRateLimiterNs([{ granted: false }, { granted: true }]) };
    const slept = [];
    const waited = await awaitDiscogsSlot(env, { sleep: (ms) => slept.push(ms) });
    expect(waited).toBe(25);
    expect(slept).toEqual([25]);
  });

  it('passes the priority tier to the DO and defaults to root', async () => {
    const ns = fakeRateLimiterNs([{ granted: true }]);
    const env = { RATE_LIMITER: ns };
    await awaitDiscogsSlot(env, { sleep: () => {} });
    await awaitDiscogsSlot(env, { sleep: () => {}, priority: 'expand' });
    expect(ns.urls[0]).toContain('priority=root');
    expect(ns.urls[1]).toContain('priority=expand');
  });

  it('escalates expand-tier sleeps per consecutive denial, capped at 15s', async () => {
    const env = {
      RATE_LIMITER: fakeRateLimiterNs([
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

  it('escalates root-tier sleeps too, capped at 5s (no per-second poll storm)', async () => {
    const env = {
      RATE_LIMITER: fakeRateLimiterNs([
        { granted: false, waitMs: 4000 },
        { granted: false, waitMs: 4000 },
        { granted: false, waitMs: 4000 },
        { granted: true },
      ]),
    };
    const slept = [];
    await awaitDiscogsSlot(env, { sleep: (ms) => slept.push(ms), priority: 'root' });
    expect(slept).toEqual([4000, 5000, 5000]);
  });

  it('gives each tier a budget sized past the measured cold-run phases', async () => {
    // Deny forever with 30s hints: root gives up (last-resort bypass) after its
    // 600s budget; expand waits its 900s budget, then spends a promoted
    // root-tier 600s before bypassing.
    const deny = { granted: false, waitMs: 30_000 };
    let rootWaited = 0;
    await awaitDiscogsSlot(
      { RATE_LIMITER: fakeRateLimiterNs([deny]) },
      { sleep: (ms) => (rootWaited += ms), priority: 'root' },
    );
    expect(rootWaited).toBe(600_000);

    let expandWaited = 0;
    await awaitDiscogsSlot(
      { RATE_LIMITER: fakeRateLimiterNs([deny]) },
      { sleep: (ms) => (expandWaited += ms), priority: 'expand' },
    );
    expect(expandWaited).toBe(900_000 + 600_000);
  });

  it('promotes an exhausted expand waiter to the root tier instead of bypassing', async () => {
    // Deny every expand take; grant the first root take. The waiter must burn
    // its whole expand budget, then come back as root and be granted — never
    // proceeding ungated.
    const ns = fakeRateLimiterNs((url) =>
      url.includes('priority=root') ? { granted: true } : { granted: false, waitMs: 15_000 },
    );
    let waited = 0;
    const returned = await awaitDiscogsSlot(
      { RATE_LIMITER: ns },
      { sleep: (ms) => (waited += ms), priority: 'expand' },
    );
    expect(waited).toBe(900_000);
    expect(returned).toBe(900_000);
    expect(ns.urls[ns.urls.length - 1]).toContain('priority=root');
    expect(ns.urls.slice(0, -1).every((u) => u.includes('priority=expand'))).toBe(true);
  });

  it('throws AbortError instead of taking a token once the signal fires', async () => {
    // Denied once; the fake sleep aborts the signal (client disconnected while
    // parked). The next loop pass must throw, not poll on toward a grant.
    const ns = fakeRateLimiterNs([{ granted: false, waitMs: 40 }, { granted: true }]);
    const signal = { aborted: false };
    const slept = [];
    await expect(
      awaitDiscogsSlot(
        { RATE_LIMITER: ns },
        {
          sleep: (ms) => {
            slept.push(ms);
            signal.aborted = true;
          },
          signal,
          priority: 'expand',
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(slept).toEqual([40]);
    expect(ns.urls.length).toBe(1); // no second take after the abort
  });

  it('fails open with the wait so far when the DO errors mid-sequence', async () => {
    const env = {
      RATE_LIMITER: fakeRateLimiterNs([
        { granted: false, waitMs: 50 },
        new Error('DO unreachable'),
      ]),
    };
    expect(await awaitDiscogsSlot(env, { sleep: () => {} })).toBe(50);
  });
});
