// Server-side identity closure. GET /api/closure?root=<name>&roots=<name>&roots=…
//
// Phase 3b: the identity-graph walk runs HERE now, not in the browser. It drives
// the BFS as a query over the D1 quad store (src/core/closure.js, dormant since
// Phase 3a) and streams progress back as Server-Sent Events so the browser graph
// still fills in progressively. Each node's edges are read ACROSS source_keys, so
// MB + Discogs finally union per node — the cross-provider view Phase 2 deferred.
//
// Cold/expired nodes are fetched by delegating to handleLookup (functions/api/
// lookup.js): it already does search→pick→details→map, writes the quads, and
// implements HIT/MISS/STALE freshness + stale-on-error. We call it for its side
// effect (populating the substrate) and its cache label, then read the cross-
// provider union via getQuadsTouching.
//
// Collab splitting ("X vs Y") stays client-side — the browser calls this endpoint
// once per part + combo and merges the streams. This endpoint is single-root.

import { checkRateLimit } from '../_lib/kvLimit.js';
import { makeD1Store } from '../_lib/quadStore.js';
import { handleLookup } from './lookup.js';
import { quadsToResult } from '../../src/core/quads.js';
import { mergeResults, normaliseName } from '../../src/core/merge.js';
import { identityClosure } from '../../src/core/closure.js';

// The providers the walk consults per node. Mirrors the PROVIDERS map in
// functions/api/lookup.js (which is not exported); keep the two in sync.
const PROVIDER_NAMES = ['musicbrainz', 'discogs'];

/**
 * Run one root's closure, emitting SSE events through `emit(event, data)`.
 * Plumbing-free so tests can drive it with an in-memory store + fetchFn and
 * capture the emitted events (mirrors handleLookup's testability split).
 *
 * Events: `provider` (per provider per node), `progress` (running merged after
 * each node), `budget` (expansion cap hit), `done` (final merged + closure),
 * `error` (substrate missing / fatal).
 */
export async function runClosure(
  env,
  { root, roots = [], fetchFn = fetch, sleep, now = Date.now, store, emit },
) {
  const graph = store ?? (env?.DB ? makeD1Store(env.DB) : null);
  if (!graph) {
    // Closure has no degraded path — it IS a query over the substrate.
    emit('error', { message: 'Graph substrate unavailable' });
    return;
  }

  const rootKeys = new Set(roots.map(normaliseName).filter(Boolean));
  const rootKey = normaliseName(root);
  const rootOutcomes = {};

  const neighbors = async (name) => {
    const key = normaliseName(name);
    const isRoot = key === rootKey;
    // Drive each provider's cold/expired fetch + quad write, collecting its
    // cache label. handleLookup owns freshness + stale-on-error.
    for (const provider of PROVIDER_NAMES) {
      let ok = true;
      let cache = null;
      let result;
      let stats;
      try {
        const res = await handleLookup(env, {
          provider,
          name,
          store: graph,
          fetchFn,
          sleep,
          now,
          // Rate-gate tier: cold ROOT lookups across all concurrent streams
          // take Discogs tokens ahead of expansion, so every act's headline
          // data lands before any act's deep walk (see server/rateLimiter.js).
          priority: isRoot ? 'root' : 'expand',
        });
        ok = res.status === 200;
        cache = res.cache;
        stats = res.stats;
        // res.body is this provider's mapped result (JSON) on success; carry it
        // so the browser's dev-probe can show per-provider counts as before.
        if (ok && res.body) {
          try {
            result = JSON.parse(res.body);
          } catch {
            /* leave result undefined */
          }
        }
      } catch {
        ok = false;
      }
      if (isRoot) rootOutcomes[provider] = ok;
      emit('provider', {
        provider,
        name,
        via: isRoot ? undefined : name,
        ok,
        result,
        cached: cache === 'HIT',
        serverCache: cache ?? undefined,
        // Upstream telemetry (calls/retries/429s/gate wait) — only present when
        // the lookup actually hit the upstream; the dev-probe sums it per run.
        stats,
      });
    }
    // Cross-provider, cross-lookup union for this node.
    return mergeResults(quadsToResult(key, await graph.getQuadsTouching(key)));
  };

  const { merged, closure } = await identityClosure(root, {
    neighbors,
    rootKeys,
    onNode: (m) => emit('progress', { merged: m }),
    onBudgetExhausted: (info) => emit('budget', info),
  });

  const queried = PROVIDER_NAMES.filter((p) => rootOutcomes[p] === true);
  const errored = PROVIDER_NAMES.filter((p) => rootOutcomes[p] === false);
  emit('done', { merged, closure: [...closure], queried, errored });
}

export async function handle(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const root = url.searchParams.get('root');
  if (!root) return new Response('Missing root', { status: 400 });
  // One `roots` param per lineup name (no delimiter collisions with artist names
  // that contain commas). Falls back to the root alone if the lineup is omitted.
  const roots = url.searchParams.getAll('roots');
  if (roots.length === 0) roots.push(root);

  // Per-IP cap. A full lineup run fires one closure request per act in parallel,
  // and each closure fans out many handleLookup calls (which therefore skip their
  // own per-call limit) — so the window is sized for a large lineup, not a single
  // lookup. Pure abuse protection.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env, { scope: 'closure', limit: 200, windowSec: 60, ip });
  if (!rate.allowed) return new Response('Too many requests', { status: 429 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // Propagate the client disconnect into upstream fetches so a closed tab
      // stops the walk mid-flight.
      const tracedFetch = (u, opts) => fetch(u, { ...opts, signal: request.signal });
      try {
        await runClosure(env, { root, roots, fetchFn: tracedFetch, emit });
      } catch (err) {
        emit('error', { message: String(err?.message ?? err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
