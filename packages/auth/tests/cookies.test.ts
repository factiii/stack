import { describe, it, expect } from 'vitest';
import {
  parseAuthCookie,
  setAuthCookies,
  clearAuthCookies,
  DEFAULT_STORAGE_KEYS,
} from '../src/utilities/cookies';

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

describe('clientDomain scopes only the client cookie', () => {
  // The whole point of clientDomain: an app on example.com reading a presence
  // hint set by api.example.com, WITHOUT the httpOnly session JWT becoming
  // readable to every subdomain. If these two ever carry the same Domain, the
  // feature has either stopped working or started leaking the JWT.
  const payload = { userId: 1, updatedAt: '2026-01-01T00:00:00.000Z' };

  function headers(
    fn: 'set' | 'clear',
    settings: Record<string, unknown>,
  ): { auth: string; client: string } {
    const calls: unknown[] = [];
    const res = {
      setHeader: (_name: string, value: unknown) => calls.push(value),
      appendHeader: (_name: string, value: unknown) => calls.push(value),
    };
    if (fn === 'set') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setAuthCookies(res as any, 'tok', payload, 'secret', settings, {
        authToken: 'ft-auth',
        clientToken: 'ft-client',
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clearAuthCookies(res as any, settings, {
        authToken: 'ft-auth',
        clientToken: 'ft-client',
      });
    }
    const cookies = calls[0] as string[];
    return {
      auth: cookies.find((c) => c.startsWith('ft-auth=')) as string,
      client: cookies.find((c) => c.startsWith('ft-client=')) as string,
    };
  }

  it('scopes the client cookie to clientDomain while the auth cookie stays host-only', () => {
    const { auth, client } = headers('set', { clientDomain: '.example.com' });
    expect(client).toContain('Domain=.example.com');
    expect(auth).not.toContain('Domain=');
  });

  it('keeps the auth cookie on domain when both are set', () => {
    const { auth, client } = headers('set', {
      domain: 'api.example.com',
      clientDomain: '.example.com',
    });
    expect(auth).toContain('Domain=api.example.com');
    expect(client).toContain('Domain=.example.com');
  });

  it('falls back to domain for the client cookie when clientDomain is unset', () => {
    const { auth, client } = headers('set', { domain: 'factiii.com' });
    expect(auth).toContain('Domain=factiii.com');
    expect(client).toContain('Domain=factiii.com');
  });

  it('clears the client cookie with the same Domain it was set with', () => {
    // A cookie scoped to `.example.com` is a distinct cookie from a host-only
    // one: clearing without the Domain leaves the hint alive past logout, so
    // the app reports a session that no longer exists.
    const settings = { clientDomain: '.example.com' };
    const set = headers('set', settings);
    const cleared = headers('clear', settings);
    expect(cleared.client).toContain('Domain=.example.com');
    expect(cleared.client).toContain('ft-client=destroy');
    expect(cleared.auth).not.toContain('Domain=');
    // Same scope on the way out as on the way in.
    expect(cleared.client.includes('Domain=.example.com')).toBe(
      set.client.includes('Domain=.example.com'),
    );
  });

  it('keeps the client cookie non-httpOnly when scoped', () => {
    const { client } = headers('set', { clientDomain: '.example.com' });
    expect(client).not.toContain('HttpOnly');
  });
});
