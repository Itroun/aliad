// Cold-run benchmark harness (built for D4.1, reused for D4.2): drive
// /api/closure like the app does (dedupe + collab-split, full roots list) and
// aggregate per-provider telemetry from the SSE `provider` events.
// `aggregateClosure(names)` is reused by the URL driver.
//
// CLI: names on stdin, one per line. Target defaults to local wrangler dev;
// point at prod with ALIAD_BASE=https://<domain>.
import { splitCollab } from '../../src/core/lookup.js';
import { dedupeNames } from '../../src/core/merge.js';

export const BASE = process.env.ALIAD_BASE ?? 'http://localhost:8787';
const CONCURRENCY = 12;

export async function aggregateClosure(rawNames) {
  const unique = dedupeNames(rawNames);
  const streams = [];
  for (const name of unique) {
    streams.push(name);
    const parts = splitCollab(name);
    if (parts) for (const p of parts) streams.push(p);
  }

  const agg = {};
  const record = (ev) => {
    const t = (agg[ev.provider] ??= {
      lookups: 0,
      wireCalls: 0,
      dumpHits: 0,
      gateWaitMs: 0,
      retries: 0,
      status429: 0,
      err: 0,
      cache: {},
    });
    t.lookups++;
    if (!ev.ok) t.err++;
    const label = ev.serverCache ?? 'none';
    t.cache[label] = (t.cache[label] ?? 0) + 1;
    const s = ev.stats;
    if (s) {
      t.wireCalls += s.calls ?? 0;
      t.dumpHits += s.dumpHit ?? 0;
      t.gateWaitMs += s.gateWaitMs ?? 0;
      t.retries += s.retries ?? 0;
      t.status429 += s.status429 ?? 0;
    }
  };

  let done = 0;
  const started = Date.now();
  await pool(streams, CONCURRENCY, async (root) => {
    const params = new URLSearchParams();
    params.set('root', root);
    for (const r of unique) params.append('roots', r);
    const res = await fetch(`${BASE}/api/closure?${params}`);
    const text = await res.text();
    for (const block of text.split('\n\n')) {
      let event, data;
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (event === 'provider' && data) {
        try {
          record(JSON.parse(data));
        } catch {}
      }
    }
    done++;
    process.stderr.write(`\r  streams ${done}/${streams.length}`);
  });
  process.stderr.write('\n');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${unique.length} acts → ${streams.length} closure streams in ${secs}s\n`);
  for (const [p, t] of Object.entries(agg)) {
    const cache = Object.entries(t.cache)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    console.log(
      `${p}: ${t.lookups} node-lookups | wireCalls=${t.wireCalls} dumpHits=${t.dumpHits} ` +
        `gateWait=${(t.gateWaitMs / 1000).toFixed(1)}s retries=${t.retries} 429=${t.status429} err=${t.err}`,
    );
    console.log(`   L2 cache: ${cache}`);
  }
  return agg;
}

export async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// CLI: names from stdin, one per line.
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = await new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
  });
  await aggregateClosure(
    input
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
