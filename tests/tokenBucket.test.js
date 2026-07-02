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

describe('token bucket reserve (priority floor)', () => {
  const RESERVED = { ...OPTS, reserve: 3 };

  it('a reserved take stops granting once the bucket reaches the floor', () => {
    let s = createBucketState(0, OPTS);
    // 10 tokens, threshold 1+3: grants at 10..4 = 7 grants, then denied at 3.
    for (let i = 0; i < 7; i++) {
      const r = take(s, 0, RESERVED);
      expect(r.granted).toBe(true);
      s = r.state;
    }
    const denied = take(s, 0, RESERVED);
    expect(denied.granted).toBe(false);
    expect(s.tokens).toBeCloseTo(3);
  });

  it('an unreserved take still drains the floor a reserved take cannot touch', () => {
    let s = { tokens: 3, updatedAt: 0 };
    expect(take(s, 0, RESERVED).granted).toBe(false);
    const r = take(s, 0, OPTS);
    expect(r.granted).toBe(true);
    expect(r.state.tokens).toBeCloseTo(2);
  });

  it('a denied reserved take reports the wait until the floor is exceeded', () => {
    const s = { tokens: 2, updatedAt: 0 };
    const denied = take(s, 0, RESERVED);
    expect(denied.granted).toBe(false);
    // Needs (1 + 3) - 2 = 2 tokens at 0.75/sec => ~2667 ms.
    expect(denied.waitMs).toBe(Math.ceil((2 / 0.75) * 1000));
    const later = take(denied.state, denied.waitMs, RESERVED);
    expect(later.granted).toBe(true);
  });
});
