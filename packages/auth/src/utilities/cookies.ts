import { createHmac, timingSafeEqual } from 'crypto';

import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';

import { type ClientCookiePayload, type CookieSettings } from '../types';

/**
 * Default storage key for auth cookie
 */
export const DEFAULT_STORAGE_KEYS = {
  AUTH_TOKEN: 'auth-token',
};

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse auth token from cookie header
 */
export function parseAuthCookie(
  cookieHeader: string | undefined,
  storageKeys: { authToken: string } = {
    authToken: DEFAULT_STORAGE_KEYS.AUTH_TOKEN,
  },
): { authToken?: string } {
  if (!cookieHeader) {
    return {};
  }
  const authToken = cookieHeader.split(`${storageKeys.authToken}=`)[1]?.split(';')[0];

  return {
    authToken: authToken || undefined,
  };
}

/**
 * Parse client cookie value from cookie header
 */
export function parseClientCookie(
  cookieHeader: string | undefined,
  storageKeys: { clientToken?: string },
): string | undefined {
  if (!cookieHeader || !storageKeys.clientToken) return undefined;
  const value = cookieHeader.split(`${storageKeys.clientToken}=`)[1]?.split(';')[0];
  return value || undefined;
}

// ── HMAC signing / verification ─────────────────────────────────────────────

/**
 * Sign a client cookie payload: base64url(JSON).base64url(HMAC-SHA256)
 */
export function signClientCookie(payload: ClientCookiePayload, secret: string): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify HMAC and parse client cookie value.
 * Returns the parsed payload or null if invalid/tampered.
 */
export function parseClientCookiePayload(
  value: string,
  secret: string,
): ClientCookiePayload | null {
  const dotIndex = value.indexOf('.');
  if (dotIndex === -1) return null;

  const data = value.slice(0, dotIndex);
  const sig = value.slice(dotIndex + 1);

  const expectedSig = createHmac('sha256', secret).update(data).digest('base64url');

  // Constant-time comparison to prevent timing attacks
  try {
    const sigBuf = Buffer.from(sig, 'base64url');
    const expectedBuf = Buffer.from(expectedSig, 'base64url');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const json = Buffer.from(data, 'base64url').toString('utf8');
    return JSON.parse(json) as ClientCookiePayload;
  } catch {
    return null;
  }
}

// ── Domain extraction ───────────────────────────────────────────────────────

/**
 * Extract domain from request headers.
 * Tries origin header first (for POST/PUT/DELETE), then referer (for GET), then host.
 */
function extractDomain(req: CreateHTTPContextOptions['res']['req']): string | undefined {
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      // Invalid URL, continue to next option
    }
  }

  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).hostname;
    } catch {
      // Invalid URL, continue to next option
    }
  }

  const host = req.headers.host;
  if (host) {
    return host.split(':')[0];
  }

  return undefined;
}

// ── Cookie string builder ───────────────────────────────────────────────────

/**
 * Build a single Set-Cookie header string.
 */
function buildCookieString(
  name: string,
  value: string,
  settings: Partial<CookieSettings>,
  domain: string | undefined,
  expiresDate?: string,
): string {
  return [
    `${name}=${value}`,
    settings.httpOnly !== false ? 'HttpOnly' : '',
    settings.secure ? 'Secure=true' : '',
    `SameSite=${settings.sameSite}`,
    `Path=${settings.path ?? '/'}`,
    domain ? `Domain=${domain}` : '',
    expiresDate ? `Expires=${expiresDate}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

// ── Single-cookie functions (backward compat) ───────────────────────────────

/**
 * Set auth cookie on response (single cookie, overwrites Set-Cookie header)
 */
export function setAuthCookie(
  res: CreateHTTPContextOptions['res'],
  authToken: string,
  settings: Partial<CookieSettings>,
  storageKeys: { authToken: string } = {
    authToken: DEFAULT_STORAGE_KEYS.AUTH_TOKEN,
  },
): void {
  const domain = settings.domain ?? extractDomain(res.req);
  const expiresDate = settings.maxAge
    ? new Date(Date.now() + settings.maxAge * 1000).toUTCString()
    : undefined;

  const cookie = buildCookieString(storageKeys.authToken, authToken, settings, domain, expiresDate);
  res.setHeader('Set-Cookie', cookie);
}

/**
 * Clear auth cookie (single cookie, overwrites Set-Cookie header)
 */
export function clearAuthCookie(
  res: CreateHTTPContextOptions['res'],
  settings: Partial<CookieSettings>,
  storageKeys: { authToken: string } = {
    authToken: DEFAULT_STORAGE_KEYS.AUTH_TOKEN,
  },
): void {
  const domain = extractDomain(res.req);
  const expiredDate = new Date(0).toUTCString();

  const cookie = buildCookieString(storageKeys.authToken, 'destroy', settings, domain, expiredDate);
  res.setHeader('Set-Cookie', cookie);
}

// ── Composite functions (auth + client cookie) ──────────────────────────────

/**
 * Set both auth cookie (httpOnly) and client cookie (non-httpOnly) atomically.
 * Uses array Set-Cookie header to avoid overwrites.
 */
export function setAuthCookies(
  res: CreateHTTPContextOptions['res'],
  authToken: string,
  clientPayload: ClientCookiePayload,
  secret: string,
  settings: Partial<CookieSettings>,
  storageKeys: { authToken: string; clientToken?: string },
): void {
  const domain = settings.domain ?? extractDomain(res.req);
  const expiresDate = settings.maxAge
    ? new Date(Date.now() + settings.maxAge * 1000).toUTCString()
    : undefined;

  // Auth cookie — uses settings as-is (httpOnly by default)
  const authCookie = buildCookieString(
    storageKeys.authToken,
    authToken,
    settings,
    domain,
    expiresDate,
  );

  if (!storageKeys.clientToken) {
    // No client cookie configured — single cookie only
    res.setHeader('Set-Cookie', authCookie);
    return;
  }

  // Client cookie — forced non-httpOnly so JS can read it
  const clientSettings = { ...settings, httpOnly: false };
  const clientValue = signClientCookie(clientPayload, secret);
  const clientCookie = buildCookieString(
    storageKeys.clientToken,
    clientValue,
    clientSettings,
    domain,
    expiresDate,
  );

  res.setHeader('Set-Cookie', [authCookie, clientCookie]);
}

/**
 * Set only the client cookie (e.g., when authGuard detects stale updatedAt).
 * Appends to existing Set-Cookie headers to avoid overwriting the auth cookie.
 */
export function setClientCookie(
  res: CreateHTTPContextOptions['res'],
  clientPayload: ClientCookiePayload,
  secret: string,
  settings: Partial<CookieSettings>,
  storageKeys: { clientToken: string },
): void {
  const domain = settings.domain ?? extractDomain(res.req);
  const expiresDate = settings.maxAge
    ? new Date(Date.now() + settings.maxAge * 1000).toUTCString()
    : undefined;

  const clientSettings = { ...settings, httpOnly: false };
  const clientValue = signClientCookie(clientPayload, secret);
  const clientCookie = buildCookieString(
    storageKeys.clientToken,
    clientValue,
    clientSettings,
    domain,
    expiresDate,
  );

  res.appendHeader('Set-Cookie', clientCookie);
}

/**
 * Clear both auth and client cookies atomically.
 */
export function clearAuthCookies(
  res: CreateHTTPContextOptions['res'],
  settings: Partial<CookieSettings>,
  storageKeys: { authToken: string; clientToken?: string },
): void {
  const domain = extractDomain(res.req);
  const expiredDate = new Date(0).toUTCString();

  const authCookie = buildCookieString(
    storageKeys.authToken,
    'destroy',
    settings,
    domain,
    expiredDate,
  );

  if (!storageKeys.clientToken) {
    res.setHeader('Set-Cookie', authCookie);
    return;
  }

  // Client cookie clear — force non-httpOnly to match the original cookie attributes
  const clientSettings = { ...settings, httpOnly: false };
  const clientCookie = buildCookieString(
    storageKeys.clientToken,
    'destroy',
    clientSettings,
    domain,
    expiredDate,
  );

  res.setHeader('Set-Cookie', [authCookie, clientCookie]);
}
