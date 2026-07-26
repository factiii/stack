/**
 * Browser-safe session detection — `@factiii/auth/browser`.
 *
 * This entry point has zero Node dependencies (no `crypto`, no `@trpc/server`,
 * no database adapter) so it can be imported from a client bundle. It reads the
 * non-httpOnly client cookie written by `setAuthCookies` and decodes its payload
 * WITHOUT verifying the HMAC — verification needs the JWT secret, which must
 * never reach the browser.
 *
 * That is fine for this use: the payload answers "does this browser hold a
 * session?" so the app knows whether to run its `users.me` probe. A forged
 * cookie buys an attacker one probe that 401s; the httpOnly session JWT is what
 * actually authorizes anything.
 */

import type { ClientCookiePayload } from './types';

export type { ClientCookiePayload };

/**
 * Default cookie name for the client-readable session marker.
 * Matches `defaultStorageKeys.clientToken` on the server.
 */
export const DEFAULT_CLIENT_STORAGE_KEY = 'auth-client';

export interface ClientSessionOptions {
  /** Cookie name, if the server was configured with a custom `storageKeys.clientToken`. */
  clientToken?: string;
  /**
   * Cookie string to read instead of `document.cookie`. Use this on the server
   * during SSR (pass the request's `Cookie` header) or in tests.
   */
  cookie?: string;
}

/**
 * Read one cookie value by exact name from a `document.cookie`-style string.
 * Exact-match on the name — a naive `split('name=')` would also match
 * `other-name=`.
 */
function readCookie(cookieString: string, name: string): string | undefined {
  for (const part of cookieString.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    return value || undefined;
  }
  return undefined;
}

/**
 * Decode base64url → utf8 using only web-standard globals (`atob`,
 * `TextDecoder`), both of which exist in browsers and in Node >= 16.
 */
function decodeBase64Url(input: string): string | null {
  try {
    const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function getCookieString(options: ClientSessionOptions): string | undefined {
  if (typeof options.cookie === 'string') return options.cookie;
  // Reached via globalThis so this file needs no DOM lib and stays safe to
  // evaluate during SSR, where `document` simply isn't there.
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  return typeof doc?.cookie === 'string' ? doc.cookie : undefined;
}

/**
 * Read the client session payload from the browser's cookies.
 *
 * The signature is NOT verified — treat the result as a presence hint, never as
 * proof of identity. Returns `null` when there is no cookie, when it has been
 * cleared, or when the value is not a well-formed payload.
 */
export function readClientSession(options: ClientSessionOptions = {}): ClientCookiePayload | null {
  const cookieString = getCookieString(options);
  if (!cookieString) return null;

  const value = readCookie(cookieString, options.clientToken ?? DEFAULT_CLIENT_STORAGE_KEY);
  if (!value) return null;

  // Value is `base64url(JSON).base64url(HMAC)`. Cleared cookies carry the
  // 'destroy' sentinel, which has no dot and falls out here.
  const dotIndex = value.indexOf('.');
  if (dotIndex === -1) return null;

  const json = decodeBase64Url(value.slice(0, dotIndex));
  if (!json) return null;

  try {
    const payload: unknown = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof (payload as ClientCookiePayload).userId !== 'number') return null;
    return payload as ClientCookiePayload;
  } catch {
    return null;
  }
}

/**
 * True when this browser holds a client session cookie — i.e. when it is worth
 * running the `users.me` probe. Safe to call during SSR (returns false).
 */
export function hasClientSession(options: ClientSessionOptions = {}): boolean {
  return readClientSession(options) !== null;
}
