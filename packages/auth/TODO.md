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

That caveat was load-bearing, not a footnote: it made the export unusable for the
consumer that motivated it. Fixed by `clientDomain` below.

## ~~Client cookie needs its own domain~~ — done (`cookieSettings.clientDomain`)

**Was.** `hasClientSession()` shipped in 0.15.0 but could not be adopted on a
split-host deployment, which is the topology it was written for. Chop-Shop runs
the app on `greasemoto.com` and the API on `api.greasemoto.com`; the `auth-client`
cookie was host-only on the API host, so `document.cookie` on the app host never
saw it. Evaluated on the 0.13.0 → 0.15.0 bump (2026-07-26) and rejected at the
time, since swapping in the packaged reader would have rendered every logged-in
user logged out in prod while passing in dev. Net effect of that release for that
app: nothing changed.

**Fixed in 0.16.0.** `CookieSettings.clientDomain` scopes the non-httpOnly client
cookie independently of `domain`, defaulting to `domain` when unset so existing
consumers are unaffected. Routed through one `clientCookieDomain()` helper used
by all three client-cookie paths — `setAuthCookies`, `setClientCookie`,
`clearAuthCookies` — because a cookie scoped to `.example.com` is a distinct
cookie from a host-only one, and a host-only clear would leave the hint alive
past logout. Covered by `tests/cookies.test.ts` ("clientDomain scopes only the
client cookie"), which pins that the auth and client cookies carry *different*
`Domain=` attributes: if they ever match, the feature has either broken or
started leaking the JWT.

## ~~`isUserInBundle` rejects logins that already proved identity~~ — done (0.17.0)

**Fixed.** The three sign-in paths (`login`, `oAuthLogin`, magic link) now call
`revokeDeviceSessionsForUser` where they used to throw. It retires the sessions
this device already holds for that same account and lets the sign-in proceed —
revoking rather than reusing, because `issueAuthCookies` drops the old bundle
entry at `maxAccounts: 1` and the row would otherwise linger un-revoked.
Bystander accounts in a larger bundle are untouched, already-revoked rows are
skipped, and a throwing `onSessionRevoked` can't abort the sign-in. Covered by
`tests/relogin.test.ts`. `isUserInBundle` itself stays exported (public API) but
is no longer called on the sign-in paths.

Consumers can drop any client-side workaround that matched on the error message
— Chop-Shop's was `useAuth.login` catching "already signed in as this account"
and adopting the session by hand.

<details>
<summary>Original report</summary>

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

One data point for that call: Chop-Shop already implements the reissue semantics
client-side, by matching on the error message and adopting the session. Matching
on prose is brittle, and every other consumer that hits this has to invent the
same thing — an argument for fixing it server-side rather than shipping the
behavior as opt-in.

*Resolved: fixed for all three callers, no config flag. Every path reaches the
check only after the caller has proven identity, so there is no case where
refusing is the better answer.*

</details>

## Client cookie re-scoping is not self-healing

When `cookieSettings.clientDomain` changes, browsers holding a cookie under the
old scope keep it: `authGuard` re-issues only when the incoming client cookie is
missing, unparseable, or stale, and the old cookie is still sent to the API and
still parses. The `Cookie:` header carries no `Domain` attribute, so the server
cannot detect the drift by inspection.

Chop-Shop worked around this by renaming `storageKeys.clientToken` (`auth-client`
→ `cs-client`) so the old cookie looks missing and gets replaced on the first
authenticated request. That works, but every consumer adopting `clientDomain`
has to invent it.

**Fix.** Record the scope in the signed client payload at issue time (e.g.
`scope: <clientDomain ?? ''>`), and add `parsed.scope !== configured` to
`authGuard`'s `needsRefresh` test. Old payloads have no `scope`; when
`clientDomain` is also unset both read as empty and nothing re-issues, so
existing deployments are untouched. Consumers changing `clientDomain` then
self-heal on the next authenticated request with no rename.
