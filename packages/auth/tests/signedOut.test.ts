import { afterEach, describe, expect, it, vi } from 'vitest';

import { readClientSession } from '../src/browser';
import {
  clearAuthCookies,
  parseClientCookiePayload,
  setAuthCookies,
  setClientCookie,
  signClientCookie,
  signedOutCookieName,
} from '../src/utilities/cookies';

// A signed-in response still in flight at sign-out can write the client cookie
// back after sign-out cleared it. Sign-out leaves a marker with the time, and
// readers ignore a client cookie issued before it.

const keys = { authToken: 'ft-auth', clientToken: 'ft-client' };
const settings = { sameSite: 'lax' as const, path: '/', maxAge: 3600 };
const payload = { userId: 7, updatedAt: '2026-11-01T00:00:00.000Z' };

/** Cookie name=value pairs from Set-Cookie headers, as a browser would send them. */
const jar = (headers: string[]): string =>
  headers
    .map((h) => h.split(';')[0])
    .filter((pair) => !pair.endsWith('=destroy'))
    .join('; ');

const capture = () => {
  const calls: string[] = [];
  const res = {
    getHeader: () => undefined,
    setHeader: (_n: string, v: string | string[]) => calls.push(...(Array.isArray(v) ? v : [v])),
    appendHeader: (_n: string, v: string) => calls.push(v),
  };
  return { calls, res };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('signed-out marker', () => {
  it('sign-out writes a readable marker with the time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { calls, res } = capture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearAuthCookies(res as any, settings, keys);
    const marker = calls.find((c) => c.startsWith(`${signedOutCookieName('ft-client')}=`));
    expect(marker).toBeDefined();
    expect(marker).toContain('ft-client-out=5000');
    expect(marker).not.toContain('HttpOnly');
  });

  it('the setters stamp issuedAt on the client cookie', () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const { calls, res } = capture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setAuthCookies(res as any, 'tok', payload, 'secret', settings, keys);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setClientCookie(capture().res as any, payload, 'secret', settings, keys);
    const value = calls.find((c) => c.startsWith('ft-client='))!.split(';')[0].slice(10);
    expect(parseClientCookiePayload(value, 'secret')?.issuedAt).toBe(9_000);
  });

  it('a cookie written by a late response after sign-out reads as signed out', () => {
    vi.useFakeTimers();
    // The in-flight request was authorised, and its cookie minted, at t=1000.
    vi.setSystemTime(1_000);
    const late = capture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setClientCookie(late.res as any, payload, 'secret', settings, keys);
    // Sign-out at t=2000.
    vi.setSystemTime(2_000);
    const out = capture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearAuthCookies(out.res as any, settings, keys);
    // The browser applies sign-out first, then the late response.
    const cookie = jar([...out.calls, ...late.calls]);
    expect(cookie).toContain('ft-client=');
    expect(readClientSession({ cookie, clientToken: 'ft-client' })).toBeNull();
  });

  it('signing in again after sign-out reads as signed in', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const out = capture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearAuthCookies(out.res as any, settings, keys);
    vi.setSystemTime(3_000);
    const login = capture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setAuthCookies(login.res as any, 'tok', payload, 'secret', settings, keys);
    const cookie = jar([...out.calls, ...login.calls]);
    expect(readClientSession({ cookie, clientToken: 'ft-client' })?.userId).toBe(7);
  });

  it('a cookie from an older version (no issuedAt) beside a marker reads as signed out', () => {
    const legacy = signClientCookie(payload, 'secret');
    const cookie = `ft-client=${legacy}; ft-client-out=2000`;
    expect(readClientSession({ cookie, clientToken: 'ft-client' })).toBeNull();
  });

  it('without a marker, any client cookie still reads as signed in', () => {
    const legacy = signClientCookie(payload, 'secret');
    expect(readClientSession({ cookie: `ft-client=${legacy}`, clientToken: 'ft-client' })?.userId).toBe(7);
  });

  it('a junk marker is ignored', () => {
    const legacy = signClientCookie(payload, 'secret');
    const cookie = `ft-client=${legacy}; ft-client-out=abc`;
    expect(readClientSession({ cookie, clientToken: 'ft-client' })?.userId).toBe(7);
  });
});
