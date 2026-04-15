export function createQueue({ minIntervalMs, now = Date.now, sleep = defaultSleep } = {}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error('minIntervalMs must be a non-negative number');
  }

  let chain = Promise.resolve();
  let lastStart = -Infinity;

  function run(fn) {
    const task = chain.then(async () => {
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return fn();
    });
    chain = task.catch(() => {});
    return task;
  }

  return { run };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
