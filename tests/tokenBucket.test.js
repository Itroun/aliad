import { describe, it, expect } from 'vitest';
import { createBucketState, refill, take } from '../src/core/tokenBucket.js';

const OPTS = { capacity: 10, refillPerSec: 0.75 };

describe('token bucket', () => {
  it('starts full at capacity', () => {
    const s = createBucketState(1000, OPTS);
    expect(s.tokens).toBe(10);
    expect(s.updatedAt).toBe(1000);
  });

  it('grants while tokens remain, decrementing each take', () => {
    let s = createBucketState(0, OPTS);
    for (let i = 0; i < 10; i++) {
      const r = take(s, 0, OPTS);
      expect(r.granted).toBe(true);
      s = r.state;
    }
    expect(s.tokens).toBeCloseTo(0);
  });

  it('denies once empty and reports a positive wait', () => {
    let s = createBucketState(0, OPTS);
    for (let i = 0; i < 10; i++) s = take(s, 0, OPTS).state;
    const denied = take(s, 0, OPTS);
    expect(denied.granted).toBe(false);
    // Need 1 token at 0.75/sec => ~1334 ms.
    expect(denied.waitMs).toBe(Math.ceil((1 / 0.75) * 1000));
  });

  it('refills over time but never exceeds capacity', () => {
    const empty = { tokens: 0, updatedAt: 0 };
    const after2s = refill(empty, 2000, OPTS);
    expect(after2s.tokens).toBeCloseTo(1.5); // 2s * 0.75
    const afterAges = refill(empty, 10_000_000, OPTS);
    expect(afterAges.tokens).toBe(10); // capped
  });

  it('grants again after waiting the reported time', () => {
    let s = createBucketState(0, OPTS);
    for (let i = 0; i < 10; i++) s = take(s, 0, OPTS).state;
    const denied = take(s, 0, OPTS);
    expect(denied.granted).toBe(false);
    const granted = take(denied.state, denied.waitMs, OPTS);
    expect(granted.granted).toBe(true);
  });

  it('treats a clock that goes backwards as no elapsed time', () => {
    const s = { tokens: 3, updatedAt: 5000 };
    const r = refill(s, 4000, OPTS); // now < updatedAt
    expect(r.tokens).toBe(3);
  });
});
