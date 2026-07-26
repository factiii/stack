---
'@factiii/auth': minor
---

Add `@factiii/auth/browser` — a Node-free entry point so client bundles can answer "does this browser hold a session?" without a network round-trip.

**Why.** The package already sets a client-readable `auth-client` cookie (`setAuthCookies`, `httpOnly: false`) for exactly this, but only exposed server-shaped readers, and the main entry pulls in `crypto`, `@trpc/server`, and the Drizzle adapter — so it could not be imported from a browser bundle at all. Apps therefore invented their own client-side marker, which has a different lifetime from the cookie. When the two diverge the app breaks invisibly: a cleared `localStorage` flag gates off the `users.me` probe that would have discovered the still-live 1-year cookie, so the UI renders logged-out on every refresh while every login attempt is rejected by `isUserInBundle` with `BAD_REQUEST: "You are already signed in as this account on this device."` — thrown *after* password and 2FA both verify, so no credential and no TOTP code can get past it.

**API.**

```ts
import { hasClientSession, readClientSession } from '@factiii/auth/browser';

if (hasClientSession()) await trpc.users.me.query();

const session = readClientSession(); // { userId, updatedAt, ...custom } | null
```

Both accept optional `{ clientToken, cookie }`. `clientToken` is the cookie name, for servers configured with a custom `storageKeys.clientToken` (default `auth-client`). `cookie` supplies a cookie string instead of reading `document.cookie` — pass the request's `Cookie` header for SSR. With no `document` and no `cookie`, they return `false` / `null`.

**How to adopt.** Nothing is required — this is purely additive and changes no existing behavior. To use it:

1. Replace any homegrown `localStorage`/`sessionStorage` login marker with `hasClientSession()`, and delete the marker so the two can't drift again.
2. If your server sets a custom `storageKeys.clientToken`, pass it: `hasClientSession({ clientToken: 'cs-auth' })`.
3. For SSR, pass the request cookie header: `hasClientSession({ cookie: req.headers.cookie })`.

**Do not use this for authorization.** The payload is decoded but the HMAC is *not* verified — verification needs the JWT secret, which must never reach the browser. Treat the result as a presence hint only; a forged cookie buys an attacker one `users.me` probe that 401s, because the httpOnly session JWT is what actually authorizes anything.

**Requires the API and client to share a host.** `cookieSettings.domain` is unset by default, making the cookie host-only, so an `api.example.com` / `example.com` split can't see it — and it looks fine in local dev where both sit on `localhost` (cookies ignore port). Setting `domain` is not a workaround: `setAuthCookies` passes one `settings.domain` to both cookies, which would broadcast the httpOnly session JWT to every subdomain. Prefer same-host or a path-based API proxy.

**Not fixed by this.** `isUserInBundle` still throws on login at `maxAccounts: 1`. This removes the marker-divergence cause, but any other drift between a client's view of the session and the cookie still ends at the same unrecoverable login rejection.
