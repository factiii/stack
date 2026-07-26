import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CLIENT_STORAGE_KEY, hasClientSession, readClientSession } from '../src/browser';
import { signClientCookie } from '../src/utilities/cookies';

const SECRET = 'test-secret';

const payload = {
  userId: 42,
  updatedAt: '2026-07-25T00:00:00.000Z',
};

function cookieFor(value: string, name = DEFAULT_CLIENT_STORAGE_KEY): string {
  return `${name}=${value}`;
}

function setDocumentCookie(cookie: string | undefined): void {
  if (cookie === undefined) {
    delete (globalThis as { document?: unknown }).document;
    return;
  }
  (globalThis as { document?: unknown }).document = { cookie };
}

afterEach(() => {
  setDocumentCookie(undefined);
});

describe('readClientSession', () => {
  it('decodes a signed client cookie without the secret', () => {
    const cookie = cookieFor(signClientCookie(payload, SECRET));

    expect(readClientSession({ cookie })).toEqual(payload);
    expect(hasClientSession({ cookie })).toBe(true);
  });

  it('preserves custom payload fields', () => {
    const custom = { ...payload, role: 'admin', orgId: 7 };
    const cookie = cookieFor(signClientCookie(custom, SECRET));

    expect(readClientSession({ cookie })).toEqual(custom);
  });

  it('reads the cookie from a multi-cookie header', () => {
    const cookie = [
      'other=1',
      'auth-token=jwt-value',
      cookieFor(signClientCookie(payload, SECRET)),
      'trailing=2',
    ].join('; ');

    expect(readClientSession({ cookie })?.userId).toBe(42);
  });

  it('does not match a cookie whose name merely ends with the key', () => {
    const cookie = cookieFor(
      signClientCookie(payload, SECRET),
      `not-${DEFAULT_CLIENT_STORAGE_KEY}`
    );

    expect(readClientSession({ cookie })).toBeNull();
  });

  it('honors a custom cookie name', () => {
    const cookie = cookieFor(signClientCookie(payload, SECRET), 'cs-auth');

    expect(readClientSession({ cookie })).toBeNull();
    expect(readClientSession({ cookie, clientToken: 'cs-auth' })).toEqual(payload);
  });

  it('returns null for a cleared cookie', () => {
    expect(readClientSession({ cookie: cookieFor('destroy') })).toBeNull();
    expect(readClientSession({ cookie: cookieFor('') })).toBeNull();
    expect(hasClientSession({ cookie: '' })).toBe(false);
  });

  it('returns null for malformed values', () => {
    expect(readClientSession({ cookie: cookieFor('not-base64.sig') })).toBeNull();
    expect(readClientSession({ cookie: cookieFor(`${btoa('[1,2,3]')}.sig`) })).toBeNull();
    expect(readClientSession({ cookie: cookieFor(`${btoa('{"noUserId":true}')}.sig`) })).toBeNull();
  });

  it('accepts a tampered signature — presence only, not verification', () => {
    const [data] = signClientCookie(payload, SECRET).split('.');

    expect(readClientSession({ cookie: cookieFor(`${data}.forged`) })).toEqual(payload);
  });

  it('falls back to document.cookie', () => {
    setDocumentCookie(cookieFor(signClientCookie(payload, SECRET)));

    expect(hasClientSession()).toBe(true);
    expect(readClientSession()?.userId).toBe(42);
  });

  it('returns false when there is no document (SSR)', () => {
    expect(hasClientSession()).toBe(false);
    expect(readClientSession()).toBeNull();
  });
});
