/**
 * OAuth providers supported by the auth system
 */
export type OAuthProvider = 'GOOGLE' | 'APPLE';

/**
 * JWT payload structure
 */
export interface JwtPayload {
  id: number; // Session ID
  userId: number;
  verifiedHumanAt: Date | null;
  sessions: number[];
  exp?: number;
  iat?: number;
}

/**
 * Cookie settings for auth tokens
 */
export interface CookieSettings {
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  domain?: string;
  /**
   * Domain for the non-httpOnly client cookie only (`storageKeys.clientToken`).
   * Defaults to `domain` when unset, so behavior is unchanged unless set.
   *
   * Exists so a split-host deployment can make the presence hint readable
   * across subdomains WITHOUT widening the httpOnly session JWT's scope: an
   * app on `example.com` calling an API on `api.example.com` sets
   * `clientDomain: '.example.com'` and leaves `domain` unset, so
   * `hasClientSession()` works on the app host while the session token stays
   * host-only on the API. Setting `domain` alone cannot express that — it
   * applies to both cookies and would broadcast the JWT to every subdomain.
   *
   * The client cookie is a signed-but-readable presence hint (userId +
   * updatedAt), so scoping it to the parent domain exposes those fields to
   * every subdomain. Don't put anything sensitive in
   * `getClientCookiePayload` when using this.
   */
  clientDomain?: string;
  httpOnly: boolean;
  path: string;
  maxAge: number; // in seconds
}

/**
 * Client cookie payload — non-httpOnly cookie readable by CSR/SSR.
 * Always includes userId and updatedAt. Apps can add custom fields
 * via the getClientCookiePayload config callback.
 */
export interface ClientCookiePayload {
  userId: number;
  updatedAt: string; // ISO timestamp
  [key: string]: unknown;
}
