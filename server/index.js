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
import { handle as openrouter } from './api/openrouter.js';
import { handle as fetchPage } from './api/fetch-page.js';
import { checkOrigin } from './_lib/originCheck.js';

// The DO class must be exported from the Worker module so the runtime can
// instantiate it for the RATE_LIMITER binding.
export { RateLimiter } from './rateLimiter.js';

const ROUTES = {
  '/api/lookup': lookup,
  '/api/closure': closure,
  '/api/openrouter': openrouter,
  '/api/fetch-page': fetchPage,
};

// Content-Security-Policy for the app shell. The strong line is `script-src
// 'self'`: it's a second, independent layer under the manual escape()/textContent
// discipline — even if an escaping bug slipped through, injected inline script
// won't run. Tailored to what the app actually loads:
//   - everything is same-origin EXCEPT Google Fonts: the stylesheet comes from
//     fonts.googleapis.com (style-src) and the font files from fonts.gstatic.com
//     (font-src) — see the @import in src/style.css.
//   - style-src keeps 'unsafe-inline' because the policy can't distinguish a
//     stray inline style attribute from a legit one; style injection is low-risk
//     (no script), so this is the accepted trade. (JS-set element.style.* is NOT
//     governed by style-src, so the graph's dynamic positioning needs nothing.)
//   - connect-src 'self' means a hypothetical injected script can't exfiltrate to
//     an external origin via fetch/XHR. frame-ancestors/base-uri/object-src lock
//     down framing, <base> hijacking and plugins.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Superseded by frame-ancestors above, but a cheap belt for older browsers.
  'X-Frame-Options': 'DENY',
};

// Re-emit a response with the security headers merged in. Preserves the original
// body stream untouched, so SSE (the closure endpoint) keeps streaming; `set`
// (not append) means a handler that already sent one — e.g. fetch-page's own
// nosniff — ends up with a single, canonical value rather than a duplicate.
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = ROUTES[pathname];
    if (handler) {
      // Origin/Referer allowlist guards every /api/* route from one chokepoint —
      // these are our paid proxies and all serve our own same-origin frontend.
      if (!checkOrigin(request, env).allowed) {
        return withSecurityHeaders(new Response('Forbidden origin', { status: 403 }));
      }
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
      // Same headers as the app shell go on API responses too (nosniff matters
      // most for JSON/text; the rest are harmless and keep the surface uniform).
      return withSecurityHeaders(await handler(context));
    }
    // Static assets (and any SPA fallback) are served by the assets binding (HSTS
    // is left to the Cloudflare edge so it never forces https on localhost dev).
    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  },
};
