import { describe, it, expect } from 'vitest';
import { createQueue } from '../src/core/rateLimit.js';

function makeClock() {
  let time = 0;
  const now = () => time;
  const sleep = (ms) => {
    time += ms;
    return Promise.resolve();
  };
  return { now, sleep, advance: (ms) => { time += ms; } };
}

describe('createQueue', () => {
  it('runs a single task immediately', async () => {
    const clock = makeClock();
    const q = createQueue({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    const result = await q.run(() => 'ok');
    expect(result).toBe('ok');
  });

  it('spaces sequential tasks by at least minIntervalMs', async () => {
    const clock = makeClock();
    const q = createQueue({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    const starts = [];
    await Promise.all([
      q.run(() => { starts.push(clock.now()); }),
      q.run(() => { starts.push(clock.now()); }),
      q.run(() => { starts.push(clock.now()); }),
    ]);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('does not wait when the previous task ran long enough ago', async () => {
    const clock = makeClock();
    const q = createQueue({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await q.run(() => {});
    clock.advance(1500);
    const before = clock.now();
    await q.run(() => {});
    expect(clock.now()).toBe(before);
  });

  it('continues the queue after a task throws', async () => {
    const clock = makeClock();
    const q = createQueue({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    const first = q.run(() => { throw new Error('boom'); });
    const second = q.run(() => 'recovered');
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('recovered');
  });

  it('rejects invalid minIntervalMs', () => {
    expect(() => createQueue({ minIntervalMs: -1 })).toThrow();
    expect(() => createQueue({ minIntervalMs: NaN })).toThrow();
  });
});
