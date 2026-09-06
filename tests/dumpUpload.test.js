import { describe, it, expect } from 'vitest';
import {
  isUploadEndpointReady,
  waitForUploadEndpoint,
  uploadFile,
  selectStaleDatabases,
  assertMetaMatchesMonth,
} from '../scripts/dump/upload.js';

// The upload path guards a genuinely destructive sequence: the create call has
// already dropped last month's database, so anything that gives up early leaves
// production with no dump at all. These cover the readiness window that bit us
// on 2026-09-06 (a 404 seconds after create, mistaken for a dead route).

const quiet = { onWait: () => {} };

describe('isUploadEndpointReady', () => {
  it('treats 404 and no-response as not ready', () => {
    expect(isUploadEndpointReady(404)).toBe(false);
    expect(isUploadEndpointReady(0)).toBe(false);
  });

  it('treats the undersized-probe rejection as ready', () => {
    // 400 "file size is less than minimum size" — the route is alive.
    expect(isUploadEndpointReady(400)).toBe(true);
    expect(isUploadEndpointReady(200)).toBe(true);
  });
});

describe('waitForUploadEndpoint', () => {
  it('polls past the 404 window and returns once the route answers', async () => {
    const statuses = [404, 404, 400];
    const slept = [];
    const status = await waitForUploadEndpoint({
      ...quiet,
      probe: async () => statuses.shift(),
      sleep: async (ms) => slept.push(ms),
      pollMs: 3000,
      timeoutMs: 120_000,
    });
    expect(status).toBe(400);
    expect(slept).toEqual([3000, 3000]);
  });

  it('does not sleep when the endpoint is ready immediately', async () => {
    const slept = [];
    await waitForUploadEndpoint({
      ...quiet,
      probe: async () => 400,
      sleep: async (ms) => slept.push(ms),
    });
    expect(slept).toEqual([]);
  });

  it('gives up after the timeout, naming the unseeded database', async () => {
    let clock = 0;
    await expect(
      waitForUploadEndpoint({
        ...quiet,
        probe: async () => 404,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        pollMs: 1000,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/never became ready.*unseeded/s);
  });
});

describe('uploadFile', () => {
  it('returns once the upload succeeds', async () => {
    let calls = 0;
    await uploadFile({
      hostname: 'h',
      token: 't',
      file: 'f',
      send: async () => {
        calls += 1;
        return { status: 200, body: 'is uploaded. File size: 727597056' };
      },
      sleep: async () => {},
    });
    expect(calls).toBe(1);
  });

  it('retries a 404 — the seed window can reopen after the probe passed', async () => {
    const statuses = [404, 404, 200];
    const slept = [];
    await uploadFile({
      hostname: 'h',
      token: 't',
      file: 'f',
      send: async () => ({ status: statuses.shift(), body: '' }),
      sleep: async (ms) => slept.push(ms),
      pollMs: 1000,
    });
    expect(statuses).toEqual([]);
    expect(slept).toEqual([1000, 2000]); // backs off per attempt
  });

  it('gives up after the attempt budget', async () => {
    let calls = 0;
    await expect(
      uploadFile({
        hostname: 'h',
        token: 't',
        file: 'f',
        send: async () => {
          calls += 1;
          return { status: 404, body: '' };
        },
        sleep: async () => {},
        attempts: 3,
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(3);
  });

  it('does not retry a non-404 failure', async () => {
    let calls = 0;
    await expect(
      uploadFile({
        hostname: 'h',
        token: 't',
        file: 'f',
        // The WAL-mode gotcha surfaces as a 400 — retrying it is pointless.
        send: async () => {
          calls += 1;
          return { status: 400, body: 'Protocol error: not a WAL file' };
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
});

// The prune is the only destructive step left in the refresh, and it runs while
// production is serving one of the databases in this list — so which names it
// selects is worth pinning down precisely.
describe('selectStaleDatabases', () => {
  const LIVE = 'discogs-dump-202609-itroun.aws-eu-west-1.turso.io';
  const existing = [
    { name: 'discogs-dump-202608', hostname: 'discogs-dump-202608-itroun.turso.io' },
    { name: 'discogs-dump-202609', hostname: LIVE },
    { name: 'unrelated-app-db', hostname: 'unrelated-app-db-itroun.turso.io' },
  ];

  it('drops the month before last, keeping live and target', () => {
    expect(
      selectStaleDatabases({ existing, liveHost: LIVE, target: 'discogs-dump-202610' }),
    ).toEqual(['discogs-dump-202608']);
  });

  it('never touches databases it does not own', () => {
    const stale = selectStaleDatabases({ existing, liveHost: LIVE, target: 'x' });
    expect(stale).not.toContain('unrelated-app-db');
  });

  it('keeps the live database even when the target names it', () => {
    // Re-running a refresh for the month already live must not drop it.
    expect(
      selectStaleDatabases({ existing, liveHost: LIVE, target: 'discogs-dump-202609' }),
    ).toEqual(['discogs-dump-202608']);
  });

  it('owns the bare pre-blue-green name, so the first run migrates off it', () => {
    const pre = [
      { name: 'discogs-dump', hostname: 'discogs-dump-itroun.turso.io' },
      { name: 'discogs-dump-202610', hostname: 'discogs-dump-202610-itroun.turso.io' },
    ];
    // While the bare one is still live it survives…
    expect(
      selectStaleDatabases({
        existing: pre,
        liveHost: 'discogs-dump-itroun.turso.io',
        target: 'discogs-dump-202610',
      }),
    ).toEqual([]);
    // …and is pruned the refresh after the cutover.
    expect(
      selectStaleDatabases({
        existing: pre,
        liveHost: 'discogs-dump-202610-itroun.turso.io',
        target: 'discogs-dump-202611',
      }),
    ).toEqual(['discogs-dump']);
  });
});

describe('assertMetaMatchesMonth', () => {
  const meta = (over) => ({ dump_date: '2026-10-01', edge_count: '9738476', ...over });

  it('accepts a dump whose date matches the requested month', () => {
    expect(assertMetaMatchesMonth(meta(), '202610')).toBe(true);
  });

  it('rejects the wrong month — a stale file uploaded under a new name', () => {
    expect(() => assertMetaMatchesMonth(meta({ dump_date: '2026-09-01' }), '202610')).toThrow(
      /dump_date is 2026-09-01, expected 2026-10-01/,
    );
  });

  it('rejects an empty or unseeded database', () => {
    expect(() => assertMetaMatchesMonth({}, '202610')).toThrow(/no dump_date/);
    expect(() => assertMetaMatchesMonth(meta({ edge_count: '0' }), '202610')).toThrow(/no edges/);
  });
});
