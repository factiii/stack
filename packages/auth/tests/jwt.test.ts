import { describe, it, expect } from 'vitest';
import {
  createAuthToken,
  verifyAuthToken,
  decodeToken,
  isTokenExpiredError,
  isTokenInvalidError,
} from '../src/utilities/jwt';

const SECRET = 'test-secret-key';

const payload = {
  userId: 1,
  sessionId: 42,
};

describe('createAuthToken / verifyAuthToken', () => {
  it('creates and verifies a valid token', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: 3600 });
    const decoded = verifyAuthToken(token, { secret: SECRET });
    expect(decoded.userId).toBe(1);
    expect(decoded.sessionId).toBe(42);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
  });

  it('rejects a token signed with wrong secret', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: 3600 });
    expect(() => verifyAuthToken(token, { secret: 'wrong-secret' })).toThrow();
  });

  it('rejects an expired token', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: -1 });
    expect(() => verifyAuthToken(token, { secret: SECRET })).toThrow();
  });

  it('allows expired token when ignoreExpiration is true', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: -1 });
    const decoded = verifyAuthToken(token, { secret: SECRET, ignoreExpiration: true });
    expect(decoded.userId).toBe(1);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyAuthToken('not.a.token', { secret: SECRET })).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => verifyAuthToken('', { secret: SECRET })).toThrow();
  });
});

describe('decodeToken', () => {
  it('decodes without verification', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: 3600 });
    const decoded = decodeToken(token);
    expect(decoded?.userId).toBe(1);
    expect(decoded?.sessionId).toBe(42);
  });

  it('decodes even with wrong secret (no verification)', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: 3600 });
    const decoded = decodeToken(token);
    expect(decoded?.userId).toBe(1);
  });

  it('returns null for garbage input', () => {
    expect(decodeToken('garbage')).toBeNull();
  });
});

describe('isTokenExpiredError', () => {
  it('returns true for expired token errors', () => {
    const token = createAuthToken(payload, { secret: SECRET, expiresIn: -1 });
    try {
      verifyAuthToken(token, { secret: SECRET });
    } catch (e) {
      expect(isTokenExpiredError(e)).toBe(true);
      expect(isTokenInvalidError(e)).toBe(false);
    }
  });

  it('returns false for invalid token errors', () => {
    try {
      verifyAuthToken('not.valid.token', { secret: SECRET });
    } catch (e) {
      expect(isTokenExpiredError(e)).toBe(false);
      expect(isTokenInvalidError(e)).toBe(true);
    }
  });

  it('returns false for non-jwt errors', () => {
    expect(isTokenExpiredError(new Error('random'))).toBe(false);
    expect(isTokenInvalidError(new Error('random'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isTokenExpiredError('string')).toBe(false);
    expect(isTokenExpiredError(null)).toBe(false);
    expect(isTokenExpiredError(undefined)).toBe(false);
  });
});
