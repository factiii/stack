import { describe, it, expect } from 'vitest';
import { parseAuthCookie, setAuthCookies, DEFAULT_STORAGE_KEYS } from '../src/utilities/cookies';

describe('parseAuthCookie', () => {
  it('parses auth token from cookie header', () => {
    const result = parseAuthCookie('auth-token=abc123; other=value');
    expect(result.authToken).toBe('abc123');
  });

  it('returns empty object for undefined header', () => {
    expect(parseAuthCookie(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseAuthCookie('')).toEqual({});
  });

  it('returns undefined authToken when cookie not present', () => {
    const result = parseAuthCookie('other=value; foo=bar');
    expect(result.authToken).toBeUndefined();
  });

  it('works with custom storage key', () => {
    const result = parseAuthCookie('my-token=xyz789; other=val', {
      authToken: 'my-token',
    });
    expect(result.authToken).toBe('xyz789');
  });

  it('handles cookie with no spaces after semicolons', () => {
    const result = parseAuthCookie('auth-token=abc;other=val');
    expect(result.authToken).toBe('abc');
  });
});

describe('DEFAULT_STORAGE_KEYS', () => {
  it('has expected default', () => {
    expect(DEFAULT_STORAGE_KEYS.AUTH_TOKEN).toBe('auth-token');
  });
});

describe('setAuthCookies domain scoping', () => {
  // Regression: dropping Origin-derived domains (b228dc2) made cookies
  // host-only by default. Consumers whose web app sets cookies on one host
  // (proxy) and reads them on another (api subdomain) MUST pass an explicit
  // settings.domain — these tests pin both behaviors.
  const payload = { userId: 1, updatedAt: '2026-01-01T00:00:00.000Z' };

  function issue(settings: Record<string, unknown>): string[] {
    const calls: unknown[] = [];
    const res = {
      setHeader: (_name: string, value: unknown) => calls.push(value),
      appendHeader: (_name: string, value: unknown) => calls.push(value),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setAuthCookies(res as any, 'tok', payload, 'secret', settings, {
      authToken: 'ft-auth',
      clientToken: 'ft-client',
    });
    const value = calls[0];
    return Array.isArray(value) ? (value as string[]) : [value as string];
  }

  it('includes Domain on both cookies when settings.domain is set', () => {
    const cookies = issue({ domain: 'factiii.com' });
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain('Domain=factiii.com');
    }
  });

  it('is host-only (no Domain attribute) when settings.domain is unset', () => {
    const cookies = issue({});
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).not.toContain('Domain=');
    }
  });
});
