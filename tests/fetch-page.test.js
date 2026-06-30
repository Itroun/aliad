import { describe, it, expect, vi } from 'vitest';
import {
  fetchWithRetry,
  isBlockedHost,
  looksLikeChallenge,
  safeRedirectTarget,
} from '../server/api/fetch-page.js';

function resp(status, { retryAfter } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'retry-after') return retryAfter ?? null;
        return null;
      },
    },
  };
}

describe('looksLikeChallenge', () => {
  it('detects Cloudflare "Just a moment" interstitial', () => {
    const body = '<html><head><title>Just a moment...</title></head></html>';
    expect(looksLikeChallenge(body)).toBe(true);
  });

  it('detects Cloudflare challenge-platform script', () => {
    const body = '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/..."></script>';
    expect(looksLikeChallenge(body)).toBe(true);
  });

  it('detects DataDome captcha reference', () => {
    expect(looksLikeChallenge('var x = DataDome.captchaUrl')).toBe(true);
  });

  it('returns false for a normal HTML page', () => {
    const body =
      '<html><body><h1>Festival 2026 lineup</h1><ul><li>Aphex Twin</li></ul></body></html>';
    expect(looksLikeChallenge(body)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(looksLikeChallenge('')).toBe(false);
    expect(looksLikeChallenge(null)).toBe(false);
  });
});

describe('isBlockedHost', () => {
  it('blocks localhost variants', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('LOCALHOST')).toBe(true);
    expect(isBlockedHost('something.local')).toBe(true);
    expect(isBlockedHost('something.internal')).toBe(true);
  });

  it('blocks cloud metadata hostnames', () => {
    expect(isBlockedHost('metadata.google.internal')).toBe(true);
    expect(isBlockedHost('metadata.goog')).toBe(true);
    expect(isBlockedHost('metadata')).toBe(true);
  });

  it('blocks all IPv4 literals', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('8.8.8.8')).toBe(true);
  });

  it('blocks IPv6 literals with or without brackets', () => {
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('[::1]')).toBe(true);
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost('2001:4860:4860::8888')).toBe(true);
  });

  it('allows normal public hostnames', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('boomfestival.org')).toBe(false);
    expect(isBlockedHost('www.festival.co.uk')).toBe(false);
  });

  it('blocks empty or missing hostnames', () => {
    expect(isBlockedHost('')).toBe(true);
    expect(isBlockedHost(null)).toBe(true);
    expect(isBlockedHost(undefined)).toBe(true);
  });
});

describe('safeRedirectTarget', () => {
  const base = 'https://festival.example/lineup';

  it('allows a redirect to another public https host', () => {
    expect(safeRedirectTarget('https://cdn.example/page', base)).toBe('https://cdn.example/page');
  });

  it('resolves a relative Location against the current URL', () => {
    expect(safeRedirectTarget('/2026', base)).toBe('https://festival.example/2026');
  });

  it('blocks a redirect to an internal IP (the SSRF bypass)', () => {
    expect(safeRedirectTarget('http://169.254.169.254/latest/meta-data/', base)).toBe(null);
    expect(safeRedirectTarget('https://169.254.169.254/', base)).toBe(null);
  });

  it('blocks a redirect to localhost or an internal name', () => {
    expect(safeRedirectTarget('https://localhost/', base)).toBe(null);
    expect(safeRedirectTarget('https://db.internal/', base)).toBe(null);
  });

  it('blocks a downgrade to http even on a public host', () => {
    expect(safeRedirectTarget('http://example.com/', base)).toBe(null);
  });

  it('blocks a non-http(s) scheme like file:', () => {
    expect(safeRedirectTarget('file:///etc/passwd', base)).toBe(null);
  });

  it('returns null for a missing or unparseable Location', () => {
    expect(safeRedirectTarget(null, base)).toBe(null);
    expect(safeRedirectTarget('', base)).toBe(null);
  });
});

describe('fetchWithRetry', () => {
  it('succeeds on the first attempt without sleeping', async () => {
    const sleep = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(resp(200));
    const result = await fetchWithRetry('https://example.com', {}, { fetchFn, sleep });
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries 503 twice then succeeds, with jittered backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(200));

    const result = await fetchWithRetry('https://example.com', {}, { fetchFn, sleep });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(3);

    const [firstWait] = sleep.mock.calls[0];
    const [secondWait] = sleep.mock.calls[1];
    expect(firstWait).toBeGreaterThanOrEqual(375);
    expect(firstWait).toBeLessThanOrEqual(625);
    expect(secondWait).toBeGreaterThanOrEqual(1125);
    expect(secondWait).toBeLessThanOrEqual(1875);
  });

  it('retries on network error and then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(resp(200));

    const result = await fetchWithRetry('https://example.com', {}, { fetchFn, sleep });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.attempts[0].error).toMatch(/ECONNRESET/);
  });

  it('does not retry on a non-retryable status like 403', async () => {
    const sleep = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(resp(403));

    const result = await fetchWithRetry('https://example.com', {}, { fetchFn, sleep });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honours Retry-After over the computed backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(resp(429, { retryAfter: '2' }))
      .mockResolvedValueOnce(resp(200));

    await fetchWithRetry('https://example.com', {}, { fetchFn, sleep });
    expect(sleep.mock.calls[0][0]).toBe(2000);
  });

  it('throws AbortError when the signal fires during a sleep', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn().mockResolvedValue(resp(503));
    const sleep = vi.fn().mockImplementation(() => {
      controller.abort();
      const err = new Error('Aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(
      fetchWithRetry('https://example.com', {}, { fetchFn, sleep, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts when status stays retryable', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(resp(503));

    const result = await fetchWithRetry('https://example.com', {}, { fetchFn, sleep });

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
