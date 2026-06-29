// Origin/Referer allowlist for the /api/* endpoints. Without this, once the app
// is publicly reachable anyone's browser JS could call our proxies and spend our
// OpenRouter budget / Discogs quota for free.
//
// Threat model: the vector an origin check actually defends is *another site's
// page calling our endpoints from a browser* — a cross-origin fetch always
// carries an `Origin` (and same-origin browser fetches carry at least a
// `Referer`). A bare server-side script (curl/node) can omit or spoof every
// header, so origin checks can't stop it; that's what the per-IP rate limits and
// the OpenRouter daily ceiling are for. So we reject a request whose origin is
// present and NOT allowlisted, and let a header-less request through rather than
// create false positives against odd legit clients.
//
// Fails OPEN when ALLOWED_ORIGIN is unset, mirroring checkRateLimit's degraded
// path: local `wrangler dev` and the tests run without the var, and the real
// origin value is only known at deploy. MUST be set in production.

function normaliseOrigin(value) {
  if (!value) return null;
  try {
    // Accept a full URL or a bare origin; collapse to scheme://host[:port].
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => normaliseOrigin(part.trim()))
    .filter(Boolean);
}

// The origin a request claims to come from: the Origin header if present,
// otherwise the origin parsed out of Referer. Null when neither is usable.
export function requestOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null') {
    const normalised = normaliseOrigin(origin);
    if (normalised) return normalised;
  }
  const referer = request.headers.get('Referer');
  if (referer) {
    const normalised = normaliseOrigin(referer);
    if (normalised) return normalised;
  }
  return null;
}

export function checkOrigin(request, env) {
  const allowed = parseAllowedOrigins(env?.ALLOWED_ORIGIN);
  if (allowed.length === 0) return { allowed: true, degraded: true };

  const origin = requestOrigin(request);
  // No Origin/Referer at all: not a cross-site browser call (those always send
  // one), so don't block — see the threat-model note above.
  if (!origin) return { allowed: true, headerless: true };

  return { allowed: allowed.includes(origin), origin };
}
