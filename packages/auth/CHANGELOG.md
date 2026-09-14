# @factiii/auth

## 0.21.1

### Patch Changes

- e247372: A password reset requested for an account with no password now sends an email sign-in (link and code) when the request names an app with email sign-in, instead of refusing. The sign-in goes through the same path as `auth.emailLogin.request`, so it shares its rate limits and single open attempt.
  
  `sendPasswordResetEmail` now gives one answer for every address — `{ message: 'If an account exists with that email, we sent a link.' }` — padded to the email sign-in response floor. It no longer returns different messages or errors for an address with no account, an account with no password, or an account with no email, and a reset email the provider rejects is logged instead of thrown. An unknown `app` key is still refused with `Unknown app.`

## 0.21.0

### Minor Changes

- 989a431: Email sign-in with a link and a code, and one 2FA gate for every sign-in path
  
  `auth.emailLogin.request`, `verifyLink` and `verifyCode`, behind
  `features.emailLogin`. One email carries a sign-in link and a 6-digit code for the
  same attempt. `request` returns `{ sent: true }` with the same timing whether or
  not an account exists, so it cannot be used to find out who has one; the email is
  sent without being awaited, so a slow or failing mail provider changes neither the
  timing nor the response. An attempt lives 15 minutes, is consumed once and
  atomically by whichever of the link or the code arrives first, allows five wrong
  codes, and is replaced by a newer request. Requests are limited per address and IP
  pair, per IP, and per address, with the per-address cap higher than the pair limit
  so a stranger cannot use up the owner's requests from one IP. Only a hash of the
  token and an HMAC of the code are stored. Verifying an address with no account
  creates one with the email already VERIFIED; an existing account whose email was
  never proven is refused, by the same rule as the OAuth attach fix. `app` is a key
  into a server-side allowlist (`emailLogin.apps`, own keys only), which picks the
  link host and brand, so no URL ever comes from the client. Needs the new
  `EmailLoginAttempt` model, `emailLogin.pepper`, `emailLogin.rateLimit`, and
  `emailService.sendLoginEmail`; `createAuthConfig` refuses to start without them.
  
  The 2FA check now runs at every place a session is minted, not only password
  login. A magic link or an OAuth sign-in into an account with 2FA on used to go
  straight through; both now return `pendingLogin` or `requires2FA` exactly as
  password login does, and accept `twoFaCode` for the second step. Push approval
  for these paths goes through the new `hooks.onDeviceStepRequired`. A
  user-verified passkey still signs in alone. The second step is bounded: through
  `emailLogin.rateLimit`, an account accepts ten second-step codes per 15 minutes
  across every IP, five wrong codes spend the email attempt or magic link they came
  with, and two requests racing on one link or attempt push a device once.
  
  New `hooks.beforeSessionMint(userId, { firstFactor, ip })` runs at every mint site
  — password, email sign-in, magic link, OAuth (before a provider is linked to an
  existing account) and passkey — before the second step and any side effect.
  Throw to refuse. Account-status rules kept in `beforeLogin` only ever covered
  password login; move them here (for example, refusing a DELETED account past its
  grace window). The package itself now refuses DEACTIVATED and BANNED accounts on
  every path, including magic link and passkey, which did not check.
  
  Case-insensitive user lookups are exact. The Prisma adapter's `mode:
  'insensitive'` `equals` is an ILIKE on Postgres, where `_` and `%` are wildcards,
  so a lookup for `j_hn@outlook.com` could return `john@outlook.com` — and OAuth
  attach-by-email, email sign-in and password reset act on that result. Lookups now
  escape the wildcards and keep only a row with the same identifier, and those
  paths re-check the address before acting on it.
  
  `verifyMagicLink` is single-use atomically: two requests racing on one link can
  no longer both sign in. Adapters gain `magicLink.consume`; one written before it
  keeps the old read-then-mark behaviour.
  
  `sendPasswordResetEmail` takes an optional `app` key and passes the app's reset
  URL to the email service, so each product's reset link opens on its own site.
  
  `auth.emailLogin.peekLink({ token })` returns `{ valid: true, maskedEmail }` for an
  open link (`a•••@example.com`, from the exported `maskEmail`), or `{ valid: false }`,
  so a confirm page can name the address before anyone signs in. It is a mutation,
  so a link pre-fetch never calls it; it spends nothing and is limited per IP.
  
  Accounts created by email sign-in or OAuth try a fresh generated username when the
  one they drew is taken, up to five times, instead of failing. Only an email
  violation still counts as a lost race for the same inbox. The default
  `generateUsername` now adds a random suffix, so two accounts made in the same
  millisecond do not draw the same name.

## 0.20.6

### Patch Changes

- 81ca3b5: Security: case-insensitive email and username lookups are now exact. The Prisma adapter escapes the characters that a case-insensitive database match treats as patterns, and sign-in, OAuth attach-by-email, signup checks, password reset, 2FA reset and login-method lookups re-check that the account found has the same email or username as the one given. Upgrade is recommended for every consumer of the Prisma adapter.

## 0.20.5

### Patch Changes

- 1dadcc2: Stop a revoked session's 2FA secret from answering the login challenge, and
  carry the live one onto the session that replaces it
  
  In device mode the TOTP secret lives on `Session.twoFaSecret`, but it belongs to
  the phone rather than to any one session of it. `findTwoFaSecretsByUserId` did
  not filter revoked rows, so a secret from a device the user had deliberately
  revoked — an old phone, a sold one, "log out everywhere" after a compromise —
  still passed the 2FA challenge. Revoking a device did not revoke its second
  factor. Present in every 0.x.
  
  The filter alone would have turned that leak into a lockout, because nothing
  carried the secret across a session replacement: `revokeDeviceSessionsForUser`
  retires the session this device already held on every ordinary sign-in, so
  filtering revoked rows would leave a re-logged-in user with no live secret at
  all, and an account with no email on file with no way back in. So the two halves
  are one change. `carryDeviceTwoFaSecret` moves the secret onto the replacement
  in the password, OAuth and magic-link paths, and only then does the adapter
  query — both the Prisma and Drizzle implementations — filter `revokedAt`.
  
  It **moves** the secret rather than copying it, which the schema requires:
  `Session.twoFaSecret` is `@unique`, so the donor and the recipient cannot hold
  the same string even for the length of a transaction. `DeviceAuthAdapter` gains
  an optional `moveTwoFaSecret`, implemented atomically by both shipped adapters
  (clear the donor, then write the recipient, in one transaction) so a crash cannot
  leave the secret on neither row. It is optional, not required, so an adapter
  written against an earlier version still satisfies the interface; without it the
  carry falls back to a clear-then-set pair, which is not atomic but fails in the
  recoverable direction.
  
  The carry is best-effort and never throws: losing a cached second factor is
  recoverable, since the vault can mint a new one, while failing here would reject
  a sign-in whose credentials have already been accepted. It does report a failure
  rather than swallowing it. It is a no-op in standard mode, where the secret is on
  the user row and no session replacement can touch it.
  
  This also fixes an existing failure: a consumer that already filtered revoked
  rows on its own approval path found no secret at all after a re-login, so
  push approvals failed until the vault happened to re-materialize one.
- aa53b2c: Only attach an OAuth sign-in to an existing account by an email that was proven
  
  `oAuthLogin` attaches a new Google or Apple identity to an existing passwordless
  account whose email matches the provider's. Two things let that attach land on
  the wrong account.
  
  The email could come from the client. When Apple's signed token carried no
  email claim, the verifier fell back to `user.email` from the request, so anyone
  holding a valid Apple token for their own Apple ID could name another person's
  address and be signed into that person's passwordless account. The Google branch
  trusted `payload.email` without checking `email_verified`. The verifier now takes
  the email only from the signed token, and from Google only when it is marked
  verified. A token with no trusted email still verifies — an identity already
  linked by its subject keeps signing in — but it can no longer attach or create.
  `OAuthResult.email` is now optional to say so.
  
  And the account's own email did not have to be proven. A consumer that lets a
  user store an unclaimed address unverified is open to pre-hijacking: register a
  passwordless account under a victim's address, and the victim's first genuine
  sign-in lands in an account the registrant still controls. No token is forged
  for that one. Attach-by-email now requires the matching account's
  `emailVerificationStatus` to be `VERIFIED`, and refuses otherwise; the user can
  still link the provider from a signed-in session. An adapter that does not return
  the field refuses every attach rather than allowing any.

## 0.20.4

### Patch Changes

- 5587241: Make `usernameMode` change the signup types, not just the runtime schema
  
  `features.usernameMode` picked the signup schema at runtime from 0.20.0 on, but
  the types were pinned to the username-required base whatever the mode said. A
  consumer on `usernameMode: 'optional'` — the documented default — could not call
  `register` without passing the username it had explicitly opted out of
  collecting.
  
  `createSchemas`, `createAuthRouter` and the router types now carry the mode as a
  type parameter inferred from the config, so `register`'s input matches what the
  schema actually validates: username optional under `'optional'`, required under
  `'required'`. Consumers need no change.

## 0.20.3

### Patch Changes

- 7f8fc49: Declare `@trpc/server` as a peer dependency, not a regular one

  `createAuthRouter` returns a tRPC router the consumer merges into its own, and
  the package throws `TRPCError` across twenty source files. Both sides must
  share one `@trpc/server` instance, exactly as they must share one `zod`.

  0.20.2 bumped it from `^11.8.0` to `^11.18.0` while it was still a regular
  dependency. Consumers on 11.8.x satisfied the old range and deduped to a single
  copy; they do not satisfy the new one, so pnpm nests a second `@trpc/server`
  under the package and their typecheck fails on `TRPCRequestInfoProcedureCall`.

  The peer range is `>=11.0.0 <12`, which every tRPC 11 consumer satisfies.

## 0.20.2

### Patch Changes

- a25c537: Build against zod 4, so the emitted types match the declared peer range

  `peerDependencies` has always said `zod >=4.3.6 <5`, but a `zod: 3.25.76`
  override in the workspace forced zod 3 into the build. The package compiled and
  tested green while emitting zod 3 shapes into the published `.d.ts`, which do
  not typecheck for a consumer on zod 4.

  `validators.ts`, `types/hooks.ts` and `procedures/passkey.ts` imported
  `AnyZodObject`, which zod 3 exported and zod 4 removed. `src/types/zod.ts` now
  defines the zod 4 equivalent.

  Also drops the unused `better-sqlite3` dependency, its adapter and its types,
  which removes a native build step from install.

  Note: this release also bumped `@trpc/server` from `^11.8.0` to `^11.18.0`
  while it was still a regular dependency. That nests a second `@trpc/server`
  under the package for any consumer on 11.8.x and breaks their typecheck. Fixed
  in 0.20.3, which makes it a peer dependency.

## 0.20.1

### Patch Changes

- 9905eba: Fix public routes rejecting a dead session, which locked browsers out

  `authGuard` re-threw `UNAUTHORIZED` before it could reach the anonymous
  fallback, so any session-integrity failure — revoked session, missing session,
  userId mismatch, token predating the session, banned user, admin IP mismatch —
  failed **every** route rather than only those requiring auth.

  `login`, `logout` and `register` are built on the public procedure, so a revoked
  session locked the browser out completely: it could not log in to replace the
  dead cookie, nor log out to clear it. The auth cookie is `httpOnly`, so the
  client could not clear it either. The only escape was waiting for the JWT to
  expire or clearing cookies by hand.

  Introduced in 0.10.0, which moved the re-throw above the `!meta?.authRequired`
  fallback and made it unreachable. This restores the pre-0.10.0 ordering.
  `FORBIDDEN` still propagates on every route, and procedures requiring auth still
  reject a dead session exactly as before.

- 8a7b4cf: Ship `zod` as a peer dependency so consumers keep a single copy

  `zod` was a regular dependency, so pnpm could install a second copy alongside
  the consumer's. Two zod instances crash `createAuthRouter` at import — zod 4
  reads `_zod.def` off schemas built by the other instance — and the failure
  surfaces as `Cannot read properties of undefined (reading 'def')`, pointing at
  zod internals rather than the cause. Consumers were pinning zod with a
  `pnpm.overrides` entry to force one copy.

  `peerDependenciesMeta` already declared `zod` non-optional; only the
  `peerDependencies` half was missing. Consumers can now drop that override.

## 0.20.0

### Minor Changes

- 88dd834: Configurable username requirement, plus `setUsername` to pick one later.

  New `features.usernameMode: 'required' | 'optional'`, defaulting to
  **`'optional'`**.
  - `'optional'` (default): `register` accepts email + password alone and stores a
    null username; the account picks one later through the new authed
    `auth.setUsername` procedure. Right for email-first products, where making
    someone invent a unique handle before they can do anything is a tax on signup.
  - `'required'`: an account cannot be created without a username, and
    `AuthUser.username` is never null in practice. Right for username-first
    products, where the username IS the identity — profile URLs, mentions,
    ownership checks.

  **Breaking — the default changed.** Every release before this one required a
  username unconditionally. A username-first consumer must now set
  `usernameMode: 'required'` explicitly on upgrade; otherwise signup quietly stops
  asking for one, and because `User.username` is usually `NOT NULL` the first such
  signup fails at the database rather than at validation.

  The mode drives the signup schema (`signupSchema` is the required base;
  `signupSchemaOptionalUsername` its counterpart, both exported), so a missing
  username is rejected by validation and the client sees a normal field error.
  Login is unaffected — it has always accepted an email OR a username.

  `AuthUser.username` and `CreateUserData.username` are typed `string | null` so
  the optional mode is representable. Make the `username` column nullable if you
  use the default; the reference Prisma schemas do.

  Passkey ceremonies now bind to `username ?? email ?? user-<id>` instead of the
  raw username. Under the optional mode a null-username account bound its
  add-passkey challenge to `null`, so every such account shared one binding value
  and a stolen `flowId` could attach a credential to a different account. The
  authenticator also displays this value, so it is never blank.

## 0.19.0

### Minor Changes

- 49dbf12: Multi-method accounts: one account can hold a password, several passkeys, and
  both Google and Apple at once, and manage them from settings.

  Passkey and multi-provider storage now live in dedicated **adapters**
  (`config.passkey`, `config.oauthAccounts`) mirroring `deviceAuth`, instead of
  loose entries in `hooks`.

  **Breaking — OAuth is now table-based.** The `User.oauthProvider` / `oauthId`
  scalar is gone; the `OAuthAccount` table (via `config.oauthAccounts`) is the sole
  source of truth. Concretely:
  - `AuthUser` and `CreateUserData` no longer include `oauthProvider` / `oauthId`,
    and `findByEmailOrOAuthId` is removed from `DatabaseAdapter`. Drop the
    `oauthProvider` / `oauthId` columns from your User table. The prebuilt Prisma
    and Drizzle adapters already reflect this.
  - `oAuthLogin` requires a `config.oauthAccounts` adapter (throws if OAuth is used
    without one). It resolves by the linked provider identity, attaches a provider
    to an existing passwordless account with the same email, else creates one.
  - 2FA no longer refuses "social login accounts" — it keys off whether the
    account has a password (a social account may now also have one).

  **Breaking — passkey storage moved.** The passkey storage that shipped in 0.18 as
  `hooks.storePasskeyChallenge` / `consumePasskeyChallenge` / `createPasskeyUser` /
  `resolvePasskeyCredential` / `onPasskeyAuthenticated` / `userHasPasskey` moves to
  a `PasskeyAdapter` on `config.passkey`, renamed `storeChallenge` /
  `consumeChallenge` / `createUser` / `resolveCredential` / `onAuthenticated` /
  `has` (plus new `list` / `add` / `remove`).
  - `OAuthAccountAdapter` (`config.oauthAccounts`): `resolve` / `link` / `unlink` /
    `list`. New authed `oAuthLink` / `oAuthUnlink`.
  - Add-passkey to an existing account: `auth.passkey.addOptions` / `addVerify` /
    `list` / `remove` (via the `passkey` adapter's `list` / `add` / `remove`).
  - Passkey registration now fires `onUserCreated` (it didn't before), so
    provisioning is shared across password/OAuth/passkey signup instead of being
    re-implemented inside the passkey adapter. `onUserCreated`'s input type widened
    to include the passkey register input.
  - `setPassword` for passwordless accounts (uses the User adapter).
  - `countLoginMethods` / `assertKeepsLoginMethod` / `resolveLoginMethods`
    exported; every unlink/remove keeps at least one method.
  - Prebuilt Prisma adapters `createPrismaOAuthAccountAdapter(prisma)` (fully
    generic) and `createPrismaPasskeyAdapter(prisma, { createUser, challenge })`
    (generic CRUD; you inject user-creation + the challenge store), mirroring
    `createPrismaDeviceAdapter`.
  - Reference `Passkey` + `OAuthAccount` models in both schemas; README documented.

## 0.18.0

### Minor Changes

- 77cbc84: Add WebAuthn passkeys and push-approval login.

  Passkeys: new `auth.passkey.*` sub-router (registerOptions / registerVerify /
  authOptions / authVerify) behind `features.passkey` + a `webauthn` config block.
  The package runs the ceremony and mints the session; storage and user creation
  are delegated to the new `storePasskeyChallenge`, `consumePasskeyChallenge`,
  `createPasskeyUser`, `resolvePasskeyCredential`, `onPasskeyAuthenticated` and
  `userHasPasskey` hooks. Credentials are registered with `residentKey: 'required'`
  and `userVerification: 'required'`, since a passkey is the account's only factor
  and sign-in uses an empty `allowCredentials` list.

  Push-approval login: the new `onLoginApprovalRequired` hook lets a consumer turn
  a 2FA-required password login into a push the user approves on another device.
  `auth.login` then returns `{ pendingLogin: true, pendingLoginId, userId }`
  instead of `{ requires2FA: true }`. The `userId` lets a client that already holds
  the user's TOTP secret locally answer the challenge itself rather than waiting on
  a second device.

  **Breaking (types):** `AuthUser.email` is now `string | null`. Username-first
  consumers can have accounts with no address, and the old non-nullable type made
  that a silent lie: `sendPasswordResetEmail` and the 2FA-reset OTP both passed it
  straight to the email service. Both now fail with a clear message instead, and
  the `user.email` returned by register/login/oauth/passkey can be null.

  **Behaviour change:** `enableTwofa` (both the device and standard flows) now
  rejects any account without a password, where it previously only rejected OAuth
  accounts. 2FA gates the password login, so on a passwordless account it guarded a
  code path the user could never reach, and `disableTwofa` (password-gated) could
  never turn it back off. This also covers passkey accounts, which are already
  two-factor via the required user-verification gesture.

  Also: passwordless-account login errors now name the exact method (passkey vs a
  specific OAuth provider) instead of saying "social login", and
  `sendVerificationEmail` no longer flips a user to PENDING when they have no email
  on file.

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
