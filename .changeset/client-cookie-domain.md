---
'@factiii/auth': minor
---

Add `cookieSettings.clientDomain` so split-host deployments can actually use `@factiii/auth/browser`.

**Why.** 0.15.0 shipped `hasClientSession()` to replace homegrown `localStorage` login markers, but it could not be adopted by the deployment shape that motivated it. `setAuthCookies` passed a single `settings.domain` to both cookies, so the client-readable `auth-client` cookie was host-only alongside the session JWT: an app on `example.com` calling an API on `api.example.com` never saw it. The README told consumers to prefer a shared host or a path-based proxy, which for an existing apex-plus-`api.` subdomain split is not a change you make to adopt a presence hint. Worse, the failure is invisible in development — `localhost:3000` and `localhost:5000` share a host because cookies ignore port — so the swap passes locally and logs out every user in production.

**What.** `CookieSettings.clientDomain?: string` scopes the non-httpOnly client cookie independently of `domain`:

```ts
cookieSettings: {
  clientDomain: '.example.com', // presence hint readable on example.com
  // domain unset → httpOnly session JWT stays host-only on api.example.com
}
```

It defaults to `domain` when unset, so nothing changes for existing consumers. Applied to all three client-cookie paths — `setAuthCookies`, `setClientCookie`, and `clearAuthCookies` — because a cookie scoped to `.example.com` is a distinct cookie from a host-only one and a host-only clear would leave the hint alive past logout.

Setting `domain` is still the wrong tool here and remains documented as such: it applies to both cookies and would broadcast the httpOnly session JWT to every subdomain.

**Security note.** `clientDomain` widens read access to the client cookie payload (`userId`, `updatedAt`, plus any `getClientCookiePayload` additions) to every subdomain of the value set. Keep that payload non-sensitive. The httpOnly session token's scope is unchanged, and the client cookie's HMAC is still never verified browser-side — it remains a presence hint, not authorization.

**Still not fixed.** `isUserInBundle` continues to throw `BAD_REQUEST: "You are already signed in as this account on this device."` on login at `maxAccounts: 1`, after password and 2FA have both verified. Using the cookie as the session hint removes the marker-divergence cause, but any other drift between a client's view of the session and the cookie still ends at that unrecoverable rejection. Tracked in `packages/auth/TODO.md`.
