import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../server/rateLimiter.js';

// Drive the Durable Object class directly through its fetch interface — the
// only Cloudflare-specific bits it uses are `new URL(request.url)` and
// `Response.json`, both available under Node.
const takeOnce = async (limiter, priority) => {
  const qs = priority ? `&priority=${priority}` : '';
  const res = await limiter.fetch({ url: `https://rate-limiter/?key=discogs${qs}` });
  return res.json();
};

describe('RateLimiter DO priority tiers', () => {
  it('expand takes stop at the reserve floor; root takes drain past it', async () => {
    const limiter = new RateLimiter(null, null);

    // Fresh bucket (capacity 5, expandReserve 3): expand gets 2 grants…
    for (let i = 0; i < 2; i++) {
      expect((await takeOnce(limiter, 'expand')).granted).toBe(true);
    }
    // …then is denied at the floor with a positive wait hint…
    const denied = await takeOnce(limiter, 'expand');
    expect(denied.granted).toBe(false);
    expect(denied.waitMs).toBeGreaterThan(0);

    // …while root still drains the reserved 3.
    for (let i = 0; i < 3; i++) {
      expect((await takeOnce(limiter, 'root')).granted).toBe(true);
    }
    expect((await takeOnce(limiter, 'root')).granted).toBe(false);
  });

  it('treats a missing priority param as root', async () => {
    const limiter = new RateLimiter(null, null);
    for (let i = 0; i < 2; i++) await takeOnce(limiter, 'expand');
    // Bucket at the floor: expand denied, an untiered take still granted.
    expect((await takeOnce(limiter, 'expand')).granted).toBe(false);
    expect((await takeOnce(limiter)).granted).toBe(true);
  });
});
