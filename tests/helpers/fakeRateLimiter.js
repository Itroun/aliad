// Shared fake for the RATE_LIMITER Durable Object namespace, single-sourcing
// the DO wire contract ({ granted, waitMs } JSON behind
// { idFromName, get: () => ({ fetch }) }) that awaitDiscogsSlot speaks.
//
// `script` is either:
//   - an array of steps (the last one repeats), or
//   - a function (url, callIndex) => step.
// Each step is a { granted, waitMs } reply, an Error to throw from the DO
// fetch, or a function (url, callIndex) => reply/Error.
//
// The returned namespace records every gate URL in `.urls` so tests can assert
// on the ?priority= tier.
export function fakeRateLimiterNs(script) {
  const urls = [];
  let i = 0;
  return {
    urls,
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url) => {
        urls.push(url);
        const n = i++;
        let step =
          typeof script === 'function' ? script(url, n) : script[Math.min(n, script.length - 1)];
        if (typeof step === 'function') step = step(url, n);
        if (step instanceof Error) throw step;
        return { json: async () => step };
      },
    }),
  };
}
