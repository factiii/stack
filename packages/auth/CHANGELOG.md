# @factiii/auth

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
