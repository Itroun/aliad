import { describe, it, expect } from 'vitest';
import { checkOrigin, requestOrigin, parseAllowedOrigins } from '../server/_lib/originCheck.js';

function req(headers = {}) {
  return { headers: new Headers(headers) };
}

describe('parseAllowedOrigins', () => {
  it('returns [] for empty/undefined', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
  });

  it('splits a comma list and normalises each to a bare origin', () => {
    expect(parseAllowedOrigins('https://aka.example , https://aliad.app/')).toEqual([
      'https://aka.example',
      'https://aliad.app',
    ]);
  });

  it('lowercases and drops paths/ports noise', () => {
    expect(parseAllowedOrigins('https://AKA.Example:443/some/path')).toEqual([
      'https://aka.example',
    ]);
  });

  it('skips unparseable entries', () => {
    expect(parseAllowedOrigins('not a url, https://ok.example')).toEqual(['https://ok.example']);
  });
});

describe('requestOrigin', () => {
  it('prefers the Origin header', () => {
    expect(requestOrigin(req({ Origin: 'https://aka.example' }))).toBe('https://aka.example');
  });

  it('falls back to the Referer origin', () => {
    expect(requestOrigin(req({ Referer: 'https://aka.example/page?x=1' }))).toBe(
      'https://aka.example',
    );
  });

  it('ignores the literal "null" Origin and falls back to Referer', () => {
    expect(requestOrigin(req({ Origin: 'null', Referer: 'https://aka.example/p' }))).toBe(
      'https://aka.example',
    );
  });

  it('returns null when neither header is present', () => {
    expect(requestOrigin(req())).toBeNull();
  });
});

describe('checkOrigin', () => {
  it('degrades open when ALLOWED_ORIGIN is unset', () => {
    const result = checkOrigin(req({ Origin: 'https://evil.example' }), {});
    expect(result).toEqual({ allowed: true, degraded: true });
  });

  it('allows a matching Origin', () => {
    const env = { ALLOWED_ORIGIN: 'https://aka.example' };
    expect(checkOrigin(req({ Origin: 'https://aka.example' }), env).allowed).toBe(true);
  });

  it('allows a matching Referer when Origin is absent', () => {
    const env = { ALLOWED_ORIGIN: 'https://aka.example' };
    expect(checkOrigin(req({ Referer: 'https://aka.example/index.html' }), env).allowed).toBe(true);
  });

  it('allows any origin in a multi-value allowlist (prod + preview)', () => {
    const env = { ALLOWED_ORIGIN: 'https://aka.example,https://aliad.app' };
    expect(checkOrigin(req({ Origin: 'https://aliad.app' }), env).allowed).toBe(true);
  });

  it('rejects a non-allowlisted origin', () => {
    const env = { ALLOWED_ORIGIN: 'https://aka.example' };
    expect(checkOrigin(req({ Origin: 'https://evil.example' }), env).allowed).toBe(false);
  });

  it('allows a header-less request (not a cross-site browser call)', () => {
    const env = { ALLOWED_ORIGIN: 'https://aka.example' };
    const result = checkOrigin(req(), env);
    expect(result.allowed).toBe(true);
    expect(result.headerless).toBe(true);
  });

  it('matches case-insensitively', () => {
    const env = { ALLOWED_ORIGIN: 'https://aka.example' };
    expect(checkOrigin(req({ Origin: 'https://AKA.Example' }), env).allowed).toBe(true);
  });
});
