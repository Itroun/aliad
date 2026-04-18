import { describe, it, expect, vi } from 'vitest';
import {
  fetchWithRetry,
  looksLikeChallenge,
} from '../functions/api/fetch-page.js';

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
    const body = '<html><body><h1>Festival 2026 lineup</h1><ul><li>Aphex Twin</li></ul></body></html>';
    expect(looksLikeChallenge(body)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(looksLikeChallenge('')).toBe(false);
    expect(looksLikeChallenge(null)).toBe(false);
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

    const result = await fetchWithRetry(
      'https://example.com',
      {},
      { fetchFn, sleep },
    );

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

    const result = await fetchWithRetry(
      'https://example.com',
      {},
      { fetchFn, sleep },
    );

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.attempts[0].error).toMatch(/ECONNRESET/);
  });

  it('does not retry on a non-retryable status like 403', async () => {
    const sleep = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(resp(403));

    const result = await fetchWithRetry(
      'https://example.com',
      {},
      { fetchFn, sleep },
    );

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
      fetchWithRetry(
        'https://example.com',
        {},
        { fetchFn, sleep, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts when status stays retryable', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(resp(503));

    const result = await fetchWithRetry(
      'https://example.com',
      {},
      { fetchFn, sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
