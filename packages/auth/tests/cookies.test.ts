import { describe, it, expect } from 'vitest';
import { parseAuthCookie, DEFAULT_STORAGE_KEYS } from '../src/utilities/cookies';

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
