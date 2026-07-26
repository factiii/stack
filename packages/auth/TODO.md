# @factiii/auth — TODO

## ~~Browser-safe session detection~~ — done (`@factiii/auth/browser`)

Shipped as a Node-free entry point: `hasClientSession()` / `readClientSession()`
read the client-readable `auth-client` cookie and decode the payload without
verifying the HMAC (verification needs the JWT secret, which must never reach
the browser). Presence hint only — a forged cookie buys one `users.me` probe
that 401s. See `src/browser.ts`, `tests/clientSession.test.ts`, and the
"Browser Session Detection" section of the README.

The same-host caveat still applies and is documented in the README:
`cookieSettings.domain` is unset by default, so the cookie is host-only and an
`api.example.com` / `example.com` split can't see it — while local dev looks
fine because both sit on `localhost` (cookies ignore port). Setting `domain` is
not a workaround: `setAuthCookies` passes one `settings.domain` to both cookies,
which would broadcast the httpOnly session JWT to every subdomain.

## `isUserInBundle` rejects logins that already proved identity

**Problem.** At `maxAccounts: 1`, `isUserInBundle` throws
`BAD_REQUEST: "You are already signed in as this account on this device."` —
*after* password and 2FA have both verified (`src/utilities/issueCookies.ts:79`,
called from `procedures/base.ts:213`, `procedures/oauth.ts:112`,
`procedures/magicLink.ts:57`).

The caller has already proven who they are at that point, so a hard rejection is
a poor default. Re-issuing the token, or adopting the existing session, would be
friendlier.

**Real incident (Chop-Shop, 2026-07-25).** The app used a `localStorage` flag to
gate its `users.me` probe. Storage got cleared; the 1-year `cs-auth` cookie did
not. The UI rendered logged-out on every refresh (the probe that would have
discovered the live session was the thing being skipped), while every login
attempt hit the throw above. No credential and no TOTP code could get past it;
the only escape was clearing cookies. Cost hours, and sent us chasing a TOTP bug
that wasn't there.

The browser export above removes the marker-divergence half of this, but the
throw is still reachable whenever a client's view of the session drifts from the
cookie.

**Open question.** Is adopt/re-issue safe for every caller (password, OAuth,
magic link), or should it be opt-in via config (e.g.
`features.reloginBehavior: 'throw' | 'reissue'`) so existing consumers keep the
current semantics?
