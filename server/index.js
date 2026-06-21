// Workers entry point. Replaces Cloudflare Pages' file-based routing (functions/
// → URLs) with an explicit router over the standard `fetch(request, env, ctx)`
// handler. This is deliberately plain: the entry is the cross-platform WinterCG
// shape and the router is our own code, so the only Cloudflare-specific surface
// left is the bindings (KV, D1, the RateLimiter DO) — each behind an adapter.
//
// Each /api/* handler is the former Pages `onRequest`, now exported as `handle`
// and unchanged: we hand it a small `context` shim so bodies that read
// `context.request` / `context.env` / `context.waitUntil` keep working verbatim.
// Anything that isn't an API route falls through to static assets (the built
// Vite app in dist/, served via the ASSETS binding).

import { handle as lookup } from './api/lookup.js';
import { handle as closure } from './api/closure.js';
import { handle as anthropic } from './api/anthropic.js';
import { handle as fetchPage } from './api/fetch-page.js';
import { checkOrigin } from './_lib/originCheck.js';

// The DO class must be exported from the Worker module so the runtime can
// instantiate it for the RATE_LIMITER binding.
export { RateLimiter } from './rateLimiter.js';

const ROUTES = {
  '/api/lookup': lookup,
  '/api/closure': closure,
  '/api/anthropic': anthropic,
  '/api/fetch-page': fetchPage,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = ROUTES[pathname];
    if (handler) {
      // Origin/Referer allowlist guards every /api/* route from one chokepoint —
      // these are our paid proxies and all serve our own same-origin frontend.
      if (!checkOrigin(request, env).allowed) {
        return new Response('Forbidden origin', { status: 403 });
      }
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
      return handler(context);
    }
    // Static assets (and any SPA fallback) are served by the assets binding.
    return env.ASSETS.fetch(request);
  },
};
