import { describe, it, expect, vi } from 'vitest';
import { checkIpLimit } from '../server/_lib/ipLimit.js';
import { handle as handleFetchPage } from '../server/api/fetch-page.js';

// A fake native rate-limiting binding: `limit({ key })` → { success }.
function fakeLimiter(success) {
  return { limit: vi.fn(async () => ({ success })) };
}

describe('checkIpLimit', () => {
  it('allows when the binding grants the slot, keyed by ip', async () => {
    const limiter = fakeLimiter(true);
    const res = await checkIpLimit({ RL_TEST: limiter }, { binding: 'RL_TEST', ip: '1.2.3.4' });
    expect(res.allowed).toBe(true);
    expect(res.degraded).toBeUndefined();
    expect(limiter.limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  it('denies when the binding refuses', async () => {
    const res = await checkIpLimit(
      { RL_TEST: fakeLimiter(false) },
      { binding: 'RL_TEST', ip: '1.2.3.4' },
    );
    expect(res.allowed).toBe(false);
  });

  it('degrades open when the binding is absent (local dev / tests)', async () => {
    const res = await checkIpLimit({}, { binding: 'RL_TEST', ip: '1.2.3.4' });
    expect(res).toEqual({ allowed: true, degraded: true });
  });

  it('degrades open when the env itself is missing', async () => {
    const res = await checkIpLimit(undefined, { binding: 'RL_TEST', ip: '1.2.3.4' });
    expect(res).toEqual({ allowed: true, degraded: true });
  });

  it('degrades open when limit() throws', async () => {
    const limiter = {
      limit: vi.fn(async () => {
        throw new Error('binding exploded');
      }),
    };
    const res = await checkIpLimit({ RL_TEST: limiter }, { binding: 'RL_TEST', ip: '1.2.3.4' });
    expect(res).toEqual({ allowed: true, degraded: true });
  });
});

// Wiring check against a real endpoint: fetch-page consults RL_FETCH_PAGE
// before anything else, so a denying binding must 429 and an absent one must
// fall through to ordinary validation (400 for the missing url param).
describe('endpoint wiring (fetch-page)', () => {
  const request = new Request('https://aliad.app/api/fetch-page', {
    headers: { 'CF-Connecting-IP': '1.2.3.4' },
  });

  it('429s when the binding denies', async () => {
    const res = await handleFetchPage({ request, env: { RL_FETCH_PAGE: fakeLimiter(false) } });
    expect(res.status).toBe(429);
  });

  it('proceeds past the limiter when the binding is absent', async () => {
    const res = await handleFetchPage({ request, env: {} });
    expect(res.status).toBe(400); // Missing url parameter — i.e. not rate-blocked
  });
});
