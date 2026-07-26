# @factiii/auth

## 0.17.0

### Minor Changes

- 0623769: Sign-in no longer rejects a device that already holds a session for the same account. **Behavior change** — the `BAD_REQUEST: "You are already signed in as this account on this device."` error is gone from `login`, `oAuthLogin`, and magic-link verification.

  **Why.** The check ran _after_ the password and the 2FA code had both verified, so it rejected callers who had just proven exactly who they were. That made it unrecoverable rather than merely annoying: no credential and no TOTP code could get past it, and any client whose view of the session had drifted from the cookie was locked out until the user found and cleared cookies by hand. Consumers were reduced to string-matching the message client-side and adopting the session themselves.

  **What.** The three sign-in paths now call `revokeDeviceSessionsForUser`, which retires the sessions this device holds for that account and lets the sign-in proceed with a fresh one:
  - Revokes rather than reuses. `issueAuthCookies` drops the previous bundle entry at `maxAccounts: 1`, so reusing would leave the old row un-revoked in the database and reachable by nothing.
  - Leaves other accounts in the bundle alone — signing in as one user on a multi-account device does not sign the others out.
  - Skips sessions already revoked elsewhere, so hooks don't fire twice for one logout.
  - Fires `onSessionRevoked(sessionId, socketId, 'Replaced by a new sign-in on this device')` per revoked session, wrapped, so a throwing listener cannot abort a sign-in half-way.

  No config flag: every one of these paths is reached only after identity is proven, so there is no case where refusing is the better answer.

  **Migration.** If you match on that error message to recover the session client-side, delete that branch — the login call now simply succeeds and sets cookies. `isUserInBundle` remains exported for anyone using it directly; it is just no longer called on the sign-in paths.

  **Still open.** Changing `cookieSettings.clientDomain` is not self-healing: browsers holding the cookie under the old scope keep it, because the `Cookie:` header carries no `Domain` attribute for the server to compare. Renaming `storageKeys.clientToken` forces the re-issue in the meantime. Tracked in `packages/auth/TODO.md`.

## 0.16.0

### Minor Changes

- 32311ea: Add `cookieSettings.clientDomain` so split-host deployments can actually use `@factiii/auth/browser`.

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

## 0.15.0

### Minor Changes

- 974d024: Add `@factiii/auth/browser` — a Node-free entry point so client bundles can answer "does this browser hold a session?" without a network round-trip.

  **Why.** The package already sets a client-readable `auth-client` cookie (`setAuthCookies`, `httpOnly: false`) for exactly this, but only exposed server-shaped readers, and the main entry pulls in `crypto`, `@trpc/server`, and the Drizzle adapter — so it could not be imported from a browser bundle at all. Apps therefore invented their own client-side marker, which has a different lifetime from the cookie. When the two diverge the app breaks invisibly: a cleared `localStorage` flag gates off the `users.me` probe that would have discovered the still-live 1-year cookie, so the UI renders logged-out on every refresh while every login attempt is rejected by `isUserInBundle` with `BAD_REQUEST: "You are already signed in as this account on this device."` — thrown _after_ password and 2FA both verify, so no credential and no TOTP code can get past it.

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

  **Do not use this for authorization.** The payload is decoded but the HMAC is _not_ verified — verification needs the JWT secret, which must never reach the browser. Treat the result as a presence hint only; a forged cookie buys an attacker one `users.me` probe that 401s, because the httpOnly session JWT is what actually authorizes anything.

  **Requires the API and client to share a host.** `cookieSettings.domain` is unset by default, making the cookie host-only, so an `api.example.com` / `example.com` split can't see it — and it looks fine in local dev where both sit on `localhost` (cookies ignore port). Setting `domain` is not a workaround: `setAuthCookies` passes one `settings.domain` to both cookies, which would broadcast the httpOnly session JWT to every subdomain. Prefer same-host or a path-based API proxy.

  **Not fixed by this.** `isUserInBundle` still throws on login at `maxAccounts: 1`. This removes the marker-divergence cause, but any other drift between a client's view of the session and the cookie still ends at the same unrecoverable login rejection.

## 0.14.0

### Minor Changes

- a6a619b: Add agent/scripting mode to the stack CLI, separate the vault key from the personal password, and generate main-is-production deploy workflows.

  **Agent mode** — `--json`, `--non-interactive`, and `--quiet` are now global flags usable on any command in any position (env equivalents `STACK_JSON`, `STACK_NONINTERACTIVE`, `STACK_QUIET`). In `--json` mode stdout carries exactly one result envelope and all logs move to stderr. Errors map to stable exit codes (1 FAILED, 2 NEEDS_INPUT, 3 UNREACHABLE, 4 VALIDATION), and prompts throw `NEEDS_INPUT` naming what to supply instead of hanging on stdin.

  **Vault key separation** — the vault key and the password protecting it are no longer the same string. `rekey` generates a random 256-bit vault key, re-encrypts the vault with it, and stores only the key wrapped by a local personal password; the raw key never touches disk. The `missing-vault-password-file` scanfix generates a key on fresh setup or prompts to import the shared key when an encrypted vault already exists. Personal password minimum raised from 4 to 8 characters.

  **Workflows** — `stack-cicd-prod.yml` is replaced by `stack-pr-staging.yml` (PR deploys staging) and `stack-prod.yml` (merge to main deploys prod), reflecting that main is the production branch. `WORKFLOW_VERSION` bumped to 2 so existing repos regenerate.

  `@factiii/stack` is now unmaintained — see the README. This is its final feature release. `@factiii/auth` is unchanged in this release apart from added regression tests, and bumps to stay in lockstep with its linked package.

## 0.13.0

### Minor Changes

- b89ee42: fix(auth): accept TOTP codes one time step either side of now

  `verifyTotp` compared the submitted code against the current 30s step only, so
  a client clock a few seconds off — or a user typing a code as it rolled over —
  failed every attempt, indistinguishable from a wrong code. It now checks ±1
  step per RFC 6238 §5.2, implementing the `window` parameter its JSDoc already
  documented. Pass `window: 0` to restore the old strict behavior.

## 0.12.2

### Patch Changes

- 6d6bede: Stop logging a CRITICAL SECURITY error for requests with no auth token — a missing token is normal anonymous/logged-out traffic, not a security event. Cookies are still cleared and UNAUTHORIZED is still thrown. Also removes the doubled "Session revoked: Session revoked:" prefix from revocation log descriptions, and prepends the tRPC procedure path to errorFormatter SERVER_ERROR stacks so minified production errors are attributable to a procedure.

## 0.12.0

### Patch Changes

- 5a53023: Fix `authGuard` stacking duplicate `Set-Cookie` headers across batched tRPC procedures.

  Batched procedures share a single `res`, so the auth/client cookies were appended once per procedure — stacking N copies of `Set-Cookie` (overflowing proxy buffers and causing 502s) and firing N redundant `getClientCookiePayload` queries, including on the slide path. The guard now checks whether the auth or client cookie has already been issued on the response and skips re-issuing it, so cookies are written at most once per request.

## 0.11.4

### Patch Changes

- Fix `authGuard` stacking duplicate `Set-Cookie` headers across batched tRPC procedures.

  Batched procedures share a single `res`, so the auth/client cookies were appended once per procedure — stacking N copies of `Set-Cookie` (overflowing proxy buffers and causing 502s) and firing N redundant `getClientCookiePayload` queries, including on the slide path. The guard now checks whether the auth or client cookie has already been issued on the response and skips re-issuing it, so cookies are written at most once per request.

## 0.11.1

### Patch Changes

- 0adcf70: Fix `authGuard.revokeSession` passing `userId` to `onSessionRevoked` where the hook expects `sessionId`.

  The hook signature is `(sessionId, socketId, reason)` but the auth guard's revocation path was calling it with `session.userId` as the first argument. Consumers' `onSessionRevoked` handlers in this code path were receiving a userId where they expected a sessionId. Now passes `session.id` correctly.

## 0.11.0

### Minor Changes

- 19a73ff: Multi-account hook fires and logout consolidation.
  - **Removed `auth.multiAccount.clearBundle`.** Use `auth.logout` instead — it now does the right thing for both single- and multi-account devices.
  - **`auth.logout` revokes the whole bundle** when `ctx.bundleSessionIds` is present (previously revoked only the active session, leaving other bundle session rows alive in DB after cookies were cleared).
  - **`auth.logout` now fires `onSessionRevoked`** per revoked session (was firing only `afterLogout`), matching every other revocation path.
  - **`afterLogout` fires once for the active user**, not per session. The hook signature gained an optional 4th param — `otherSessions: Array<{ userId, sessionId, socketId }>` — listing bystander accounts in the bundle that were also revoked. Existing 3-arg handlers keep working unchanged.
  - **`auth.logout` updates `user.isActive: false` for every unique userId in the bundle**, not just the active user.
  - **`removeSession` fires `afterLogout` and flips `user.isActive: false`** when removing the last session in the bundle (matching `logout`'s precedent).
  - **`removeSession` promotes the most-recently-added remaining session** when removing the active one (was promoting the oldest). Consistent with the authGuard fallback.
  - **`removeSession` always re-fetches the new active session**, so the client cookie's `updatedAt` matches the DB on the first response (was forcing a redundant refresh on the next request when removing a non-active session).
  - **Hook errors no longer abort the loop.** `onSessionRevoked` and `afterLogout` calls in both `logout` and `removeSession` are wrapped — a flaky listener can't leave the bundle half-revoked.
  - **Already-revoked sessions are skipped** in `logout` and `removeSession`, so a session that was killed via another path (e.g. `revokeAllByUserId` from another device) won't get re-revoked or fire its hooks twice.

## 0.10.0

### Minor Changes

- 316d265: Add multi-account support to `@factiii/auth`.

  A device can now hold a bundle of signed-in sessions and switch between them without re-authenticating. Behavior is unchanged by default; set `AuthConfig.maxAccounts > 1` to opt in.

  **New config**
  - `AuthConfig.maxAccounts?: number` — max sessions per device. Defaults to `1` (single-account, identical to prior behavior). `>1` enables the bundle.

  **JWT shape**
  - `JwtPayload` now carries `sessions: number[]` — the bundle of session IDs the device holds, with `id` pointing at the currently active one.
  - `verifyAuthToken` / `decodeToken` normalize legacy tokens missing `sessions` to `[id]`, so existing tokens keep working across the rollout.
  - `createAuthToken`'s `sessions` field is optional; defaults to `[id]`.

  **New procedures (under `auth.multiAccount`)**
  - `switchSession({ targetSessionId })` — make another session in the bundle active.
  - `removeSession({ targetSessionId })` — revoke a session and drop it from the bundle; promotes the next session if the removed one was active, or clears cookies if it was the last.
  - `clearBundle()` — revoke every session in the bundle ("log out of all accounts on this device").

  **Auth guard changes**
  - When the active session is revoked or missing, the guard now tries to promote another session from the bundle (rewriting cookies) and signals the rotation by throwing `UNAUTHORIZED` with message `ACTIVE_SESSION_SWITCHED` so clients can retry transparently.
  - `TrpcContext` gains `bundleSessionIds?: number[]` for downstream procedures.

  **Adapter change**
  - `DatabaseAdapter.session.findManyByIds(ids)` is now **required**. Both `createPrismaAdapter` and `createDrizzleAdapter` implement it. Custom adapters must add it.

  **New utilities**
  - `issueAuthCookies(config, params)` — centralizes JWT + cookie issuance after sign-in / sign-up / oauth / magic-link, handles bundle append + cap enforcement + revoked-session pruning.
  - `isUserInBundle(config, cookieHeader, userId)` — guards against signing the same user into one device twice. Used by base sign-in, OAuth, and magic-link procedures.

## 0.8.0

### Minor Changes

- 7dfe209: Split @factiii/auth 2FA into clean standard and device modes, and ship Claude Code skill scanfixes from @factiii/stack.

  **@factiii/auth**
  - `createAuthRouter` now selects its router shape from `features.twoFaMode`. Default is the new `'standard'` mode (user-centric TOTP with `User.twoFaSecret` + `User.twoFaBackupCodes`). Set `features.twoFaMode: 'device'` and pass a `deviceAuth: DeviceAuthAdapter` to opt into the legacy mobile-bound flow used by factiii.
  - New exports: `StandardAuthRouter`, `DeviceAuthRouter`, `TwoFaMode`, `DeviceAuthAdapter`, `createPrismaDeviceAdapter`, `AUTH_PRISMA_MODELS_STANDARD`, `AUTH_PRISMA_MODELS_DEVICE`, `getAuthPrismaModels`. `AuthRouter` is preserved as an alias of `StandardAuthRouter`.
  - Reference Prisma schema split: `prisma/schema.prisma` is now `prisma/schema.standard.prisma` (default) and `prisma/schema.device.prisma` (legacy). Update `package.json#exports` consumers — the old `./prisma/schema.prisma` subpath has been removed.
  - `SessionWithDevice` moved from `./adapters/database` to `./adapters/deviceAuth`.
  - Restored the required `User.updatedAt` column in both schema variants — login/refresh embed `updatedAt.toISOString()` in the cookie payload, so omitting it crashes auth at runtime.
  - Drops the redundant `User.twoFaEnabled` flag in standard mode; `twoFaSecret != null` is the source of truth.

  **@factiii/stack**
  - New `claude-skills` scanfix replaces the older `prod-check-skill` scanfix, installing the `commit`, `push`, and `prod-check` Claude Code skills under `~/.claude/skills/` for factiii-pipeline repos.

## 0.7.2

### Patch Changes

- 774979b: fix: 2FA recovery now accepts email or username

## 0.7.1

### Patch Changes

- 3abe40e: feat(auth): add magic link authentication and session integrity checks
  - Add magic link authentication support
  - Add session integrity checks to prevent cross-database user mismatch
  - Restructure monorepo — move stack to packages/stack, align versions to 0.7.0
  - Prevent repeated SSH password prompts during scan

## 0.6.3

### Patch Changes

- b4e0eff: Added client cookie and made auth cooke strict

## 0.6.2

### Patch Changes

- f57ab54: Update from strict to lac cookie
